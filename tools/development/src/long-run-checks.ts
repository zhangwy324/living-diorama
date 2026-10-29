import {
  phaseSpans,
  tirednessNeed,
  type CreatureState,
  type DayPhase,
  type DecisionTrace,
  type Simulation,
  type SimulationEvent,
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
/** By default, a creature that lived a whole day is asleep at most this many hours a day. */
export const MAX_SLEEP_HOURS_PER_DAY = 14;
/** The event that counts as a meal (ADR 0018, PR 4a). */
export const MEAL_EVENT = "ate";
/** A creature counts as hungry with the `hungry` cue or with this much hunger. */
export const HUNGRY_FROM = 0.8;
const HUNGER_NEED = "core:hunger";
/** Hours of night in a day (ADR 0018 §5): 20:00 to 06:00. */
const NIGHT_HOURS = phaseSpans(0, 24 * 3_600_000)
  .filter((span) => span.phase === "night")
  .reduce((hours, span) => hours + span.hours, 0);

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
   * Each creature eats (a `MEAL_EVENT`) at least once every `hours` (default 3) awake. Ticks it
   * spends asleep don't count, so a night's sleep of about 10 hours is no gap. Off unless given;
   * `creatures` chooses those held to it, e.g. those that can reach food.
   */
  meals?: { hours?: number; creatures?: CreatureFilter };
  /**
   * Each creature is asleep for at least `minShare` (default 0.5) of the night ticks it lived
   * through, once it has lived through `minNightHours` (default 1), and, once it has lived a
   * whole simulated day, for at most `maxHoursPerDay` (default 14) a day on average, so one that
   * never wakes fails too. The day is weighed by phase: its share of night ticks asleep counts for
   * the night's 10 hours and its share of other ticks asleep for the other 14, so a run whose
   * ticks are not a fair sample of the day (one that skipped hours in a catch-up) is judged as an
   * unbroken one. Off unless given; `creatures` chooses those held to it, e.g. those
   * that sleep at night (a nocturnal creature sleeps by day, so it is left out).
   */
  sleep?: {
    minShare?: number;
    minNightHours?: number;
    maxHoursPerDay?: number;
    creatures?: CreatureFilter;
  };
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
  /**
   * Times of day, in minutes since midnight, it fell asleep in the evening: in the world's dusk
   * or night, before midnight (issue #85).
   */
  bedtimes: number[];
  /** Times of day it woke rested in the morning: in the world's night or dawn, after midnight. */
  wakeTimes: number[];
}

/** The world's time of day when an event was emitted. */
export interface EventTime {
  dayPhase: DayPhase;
  /** Minutes since midnight. */
  minutes: number;
}

const NOON = 12 * 60;

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
  /** Per creature, its ticks awake since its last meal, or since it was first seen. */
  readonly #awakeSinceMeal = new Map<string, number>();
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
        bedtimes: [],
        wakeTimes: [],
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

  /**
   * Counts meals and records bedtimes and wake times. A creature the sleep check holds to it that
   * falls asleep in the world's day phase must be tired enough to act (`actAt`): only then may it
   * nap, never because its own day starts early (issue #85).
   */
  event(event: SimulationEvent, { dayPhase, minutes }: EventTime) {
    if (event.type === "fell_asleep") {
      const { creatureId, tiredness } = event;
      if ((dayPhase === "dusk" || dayPhase === "night") && minutes >= NOON) {
        this.#stats(creatureId).bedtimes.push(minutes);
      }
      const checked = this.options.sleep && !this.#noSleepCheck.has(creatureId);
      if (checked && dayPhase === "day" && tiredness < tirednessNeed.actAt) {
        this.violation(
          `${creatureId}: fell asleep by day at tiredness ${tiredness.toFixed(2)} (below ${tirednessNeed.actAt})`,
        );
      }
    } else if (event.type === "woke_up" && event.reason === "rested") {
      if ((dayPhase === "dawn" || dayPhase === "night") && minutes < NOON) {
        this.#stats(event.creatureId).wakeTimes.push(minutes);
      }
    }
    // Compared as a string, so this works before the event type exists.
    if ((event.type as string) !== MEAL_EVENT || !("creatureId" in event)) return;
    this.#stats(event.creatureId).meals++;
    this.#awakeSinceMeal.set(event.creatureId, 0);
  }

  /**
   * After a restore with catch-up, which feeds every creature (ADR 0018 §19): the time awake
   * before the gap no longer counts towards a gap between meals.
   */
  caughtUp() {
    this.#awakeSinceMeal.clear();
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
      // Only time awake counts towards a gap between meals: a night's sleep is no gap.
      if (c.asleep) continue;
      const awake = (this.#awakeSinceMeal.get(c.id) ?? 0) + 1;
      this.#awakeSinceMeal.set(c.id, awake);
      if (meals && c.checkMeals !== false && awake > mealTicks) {
        this.violation(`${c.id}: no meal for ${meals.hours ?? 3} h awake`);
        // Once per gap, not every tick after.
        this.#awakeSinceMeal.set(c.id, 0);
      }
    }
  }

  /** At the end of the run: the bounds that hold on average. */
  finish() {
    const { maxDecisionsPer10Seconds = MAX_DECISIONS_PER_10_SECONDS } = this.options;
    for (const [id, stats] of this.creatures) {
      // One decision for free, the creature's first.
      const allowed = 1 + (maxDecisionsPer10Seconds * stats.ticks) / (10 * this.tickRateHz);
      if (stats.decisions > allowed) {
        this.violation(
          `${id}: ${stats.decisions} decisions in ${(stats.ticks / this.tickRateHz).toFixed(0)} s ` +
            `(at most ${maxDecisionsPer10Seconds} per 10 s)`,
        );
      }
      this.#checkSleep(id, stats);
    }
  }

  /** The sleep bounds over the whole run. */
  #checkSleep(id: string, stats: CreatureStats) {
    const { sleep } = this.options;
    if (!sleep || this.#noSleepCheck.has(id)) return;
    const { ticks, asleepTicks, nightTicks, asleepAtNightTicks } = stats;
    const dayTicks = 24 * 3600 * this.tickRateHz;
    const maxHours = sleep.maxHoursPerDay ?? MAX_SLEEP_HOURS_PER_DAY;
    // Hours asleep in a day, weighed by phase; a phase it never lived through counts at its
    // overall share.
    const overall = asleepTicks / Math.max(1, ticks);
    const otherTicks = ticks - nightTicks;
    const atNight = nightTicks > 0 ? asleepAtNightTicks / nightTicks : overall;
    const otherwise = otherTicks > 0 ? (asleepTicks - asleepAtNightTicks) / otherTicks : overall;
    const hoursPerDay = NIGHT_HOURS * atNight + (24 - NIGHT_HOURS) * otherwise;
    if (ticks >= dayTicks && hoursPerDay > maxHours) {
      this.violation(`${id}: asleep ${hoursPerDay.toFixed(1)} h a day (at most ${maxHours})`);
    }
    const minNightTicks = (sleep.minNightHours ?? 1) * 3600 * this.tickRateHz;
    if (nightTicks < minNightTicks) return;
    const share = asleepAtNightTicks / nightTicks;
    const minShare = sleep.minShare ?? 0.5;
    if (share < minShare) {
      this.violation(
        `${id}: asleep ${(100 * share).toFixed(0)}% of the night (at least ${100 * minShare}%)`,
      );
    }
  }
}
