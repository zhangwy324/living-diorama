import type {
  CreatureState,
  DayPhase,
  DecisionTrace,
  Simulation,
  SimulationEvent,
} from "@living-diorama/simulation";

// The living-behavior checks of the long runs (ADR 0018 §20 and its amendments), kept apart from
// the runner so they can be fed synthetic traces in tests. Needs stay in [0, 1], decisions and
// interruptions stay under a bound, and, once food and sleep exist, creatures eat and sleep.

/** By default, on average at most this many decisions per creature per 10 simulated seconds. */
export const MAX_DECISIONS_PER_10_SECONDS = 1;
/** By default, at most this many `rejected` or `no_proposal` evaluations in a row. */
export const MAX_FAILED_DECISIONS_IN_A_ROW = 20;
/** At most this many interruptions per creature in any simulated minute. */
export const MAX_INTERRUPTIONS_PER_MINUTE = 3;
/** The event that counts as a meal (ADR 0018, PR 4a). */
export const MEAL_EVENT = "ate";
/** A creature counts as hungry with the `hungry` cue or with this much hunger. */
export const HUNGRY_FROM = 0.8;
const HUNGER_NEED = "core:hunger";

/**
 * Which creatures a check applies to; all by default. The runner calls it once per creature, when
 * it first sees it, with its state and the simulation, so a filter can ask about the world, e.g.
 * whether any food is reachable from where the creature is.
 */
export type CreatureFilter = (creature: CreatureState, simulation: Simulation) => boolean;

export interface LongRunCheckOptions {
  /**
   * The decision bound; default `MAX_DECISIONS_PER_10_SECONDS`. Wander alone decides about
   * 0.4 times per 10 s in Woodland Hollow but about 1.3 in the small river-crossing fixture, whose
   * walks are short, so fixtures may loosen it.
   */
  maxDecisionsPer10Seconds?: number;
  /**
   * Catches a retry loop that the lifetime average would hide: at most this many `rejected` or
   * `no_proposal` evaluations in a row per creature; default `MAX_FAILED_DECISIONS_IN_A_ROW`.
   * Only a `started` evaluation ends the run of failures; `kept` neither counts nor ends it.
   */
  maxFailedDecisionsInARow?: number;
  /**
   * Each creature eats (a `MEAL_EVENT`) at least once every `hours` (default 3). Off by default
   * until food exists; PR 6 turns it on, with `creatures` choosing those that can reach food.
   */
  meals?: { hours?: number; creatures?: CreatureFilter };
  /**
   * Each creature is asleep for at least `minShare` (default 0.5) of the night ticks it lived
   * through, once it has lived through `minNightHours` (default 1). Off by default until sleep
   * exists; PR 6 turns it on.
   */
  sleep?: { minShare?: number; minNightHours?: number; creatures?: CreatureFilter };
}

/** What one creature did over a run; also the runner's per-creature report. */
export interface CreatureStats {
  speciesId: string;
  /** Ticks it was alive at the end of. */
  ticks: number;
  /** Evaluations traced, whatever their result. */
  decisions: number;
  /** Evaluations while an action ran that started a challenger. */
  interruptions: number;
  /** Most interruptions within any one simulated minute. */
  peakInterruptionsPerMinute: number;
  /** `MEAL_EVENT`s. */
  meals: number;
  hungryTicks: number;
  asleepTicks: number;
  nightTicks: number;
  asleepAtNightTicks: number;
}

/** A creature as one tick leaves it. */
export interface CreatureTick {
  id: string;
  speciesId: string;
  needs: Readonly<Record<string, number>>;
  asleep: boolean;
  cues: readonly string[];
  /** Whether the meal and sleep checks, if on, apply to it (their `creatures` filters). */
  checkMeals?: boolean;
  checkSleep?: boolean;
}

export class LongRunChecks {
  readonly creatures = new Map<string, CreatureStats>();
  readonly #ticksPerMinute: number;
  /** Per creature, the ticks of its interruptions within the last minute. */
  readonly #recentInterruptions = new Map<string, number[]>();
  /** Per creature, the tick of its last meal, or of when it was first seen. */
  readonly #lastMeal = new Map<string, number>();
  /** Per creature, its `rejected` and `no_proposal` evaluations since the last `started`. */
  readonly #failedInARow = new Map<string, number>();
  /** Creatures the sleep check skips. */
  readonly #noSleepCheck = new Set<string>();

  constructor(
    private readonly tickRateHz: number,
    private readonly options: LongRunCheckOptions,
    private readonly violation: (message: string) => void,
  ) {
    this.#ticksPerMinute = 60 * tickRateHz;
  }

  #stats(id: string, speciesId = ""): CreatureStats {
    let stats = this.creatures.get(id);
    if (!stats) {
      stats = {
        speciesId,
        ticks: 0,
        decisions: 0,
        interruptions: 0,
        peakInterruptionsPerMinute: 0,
        meals: 0,
        hungryTicks: 0,
        asleepTicks: 0,
        nightTicks: 0,
        asleepAtNightTicks: 0,
      };
      this.creatures.set(id, stats);
    }
    return stats;
  }

  trace(trace: DecisionTrace) {
    const stats = this.#stats(trace.creatureId);
    stats.decisions++;
    if (trace.result === "started") this.#failedInARow.set(trace.creatureId, 0);
    else if (trace.result === "rejected" || trace.result === "no_proposal") {
      const failed = (this.#failedInARow.get(trace.creatureId) ?? 0) + 1;
      this.#failedInARow.set(trace.creatureId, failed);
      const max = this.options.maxFailedDecisionsInARow ?? MAX_FAILED_DECISIONS_IN_A_ROW;
      if (failed === max + 1) {
        this.violation(
          `${trace.creatureId}: ${failed} rejected or empty evaluations in a row (at most ${max})`,
        );
      }
    }
    // Interruption emits no event; a trace that starts a challenger over a running action is one.
    if (!trace.running || trace.result !== "started") return;
    stats.interruptions++;
    let recent = this.#recentInterruptions.get(trace.creatureId);
    if (!recent) this.#recentInterruptions.set(trace.creatureId, (recent = []));
    recent.push(trace.tick);
    while ((recent[0] ?? Infinity) <= trace.tick - this.#ticksPerMinute) recent.shift();
    stats.peakInterruptionsPerMinute = Math.max(stats.peakInterruptionsPerMinute, recent.length);
    if (recent.length === MAX_INTERRUPTIONS_PER_MINUTE + 1) {
      this.violation(
        `${trace.creatureId}: ${recent.length} interruptions within a minute (at most ${MAX_INTERRUPTIONS_PER_MINUTE})`,
      );
    }
  }

  event(event: SimulationEvent) {
    // Compared as a string, so this works before the event type exists.
    if ((event.type as string) !== MEAL_EVENT || !("creatureId" in event)) return;
    this.#stats(event.creatureId).meals++;
    this.#lastMeal.set(event.creatureId, event.tick);
  }

  /** After each tick, with every creature alive. */
  tick(tick: number, dayPhase: DayPhase, creatures: Iterable<CreatureTick>) {
    const { meals } = this.options;
    const mealTicks = (meals?.hours ?? 3) * 3600 * this.tickRateHz;
    for (const c of creatures) {
      const stats = this.#stats(c.id, c.speciesId);
      stats.speciesId = c.speciesId;
      stats.ticks++;
      for (const [need, value] of Object.entries(c.needs)) {
        if (!(value >= 0 && value <= 1)) this.violation(`${c.id}: ${need} is ${value}`);
      }
      if (c.cues.includes("hungry") || (c.needs[HUNGER_NEED] ?? 0) >= HUNGRY_FROM) {
        stats.hungryTicks++;
      }
      if (c.checkSleep === false) this.#noSleepCheck.add(c.id);
      if (c.asleep) stats.asleepTicks++;
      if (dayPhase === "night") {
        stats.nightTicks++;
        if (c.asleep) stats.asleepAtNightTicks++;
      }
      const last = this.#lastMeal.get(c.id);
      if (last === undefined) this.#lastMeal.set(c.id, tick);
      else if (meals && c.checkMeals !== false) {
        if (tick - last > mealTicks) {
          this.violation(`${c.id}: no meal for ${meals.hours ?? 3} h`);
          // Once per gap, not every tick after.
          this.#lastMeal.set(c.id, tick);
        }
      }
    }
  }

  /** At the end of the run: the bounds that hold on average. */
  finish() {
    const { sleep, maxDecisionsPer10Seconds = MAX_DECISIONS_PER_10_SECONDS } = this.options;
    for (const [id, stats] of this.creatures) {
      // One decision for free, the creature's first.
      const allowed = 1 + (maxDecisionsPer10Seconds * stats.ticks) / (10 * this.tickRateHz);
      if (stats.decisions > allowed) {
        this.violation(
          `${id}: ${stats.decisions} decisions in ${(stats.ticks / this.tickRateHz).toFixed(0)} s ` +
            `(at most ${maxDecisionsPer10Seconds} per 10 s)`,
        );
      }
      if (!sleep || this.#noSleepCheck.has(id)) continue;
      const minNightTicks = (sleep.minNightHours ?? 1) * 3600 * this.tickRateHz;
      if (stats.nightTicks < minNightTicks) continue;
      const share = stats.asleepAtNightTicks / stats.nightTicks;
      const minShare = sleep.minShare ?? 0.5;
      if (share < minShare) {
        this.violation(
          `${id}: asleep ${(100 * share).toFixed(0)}% of the night (at least ${100 * minShare}%)`,
        );
      }
    }
  }
}
