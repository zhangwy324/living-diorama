import { formatDiagnostic, parseWorldSave, type WorldSave } from "@living-diorama/content-schema";
import {
  creaturePhaseStarts,
  hungerNeed,
  isFailingShelter,
  phaseSpans,
  Rng,
  SLEEPER_GAP,
  sleepCycle,
  tirednessNeed,
  type CreatureState,
  type RestoreReport,
  type Simulation,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { isDeepStrictEqual } from "node:util";

// Save and restore in the long runs (ADR 0019; M15 PR 7): saves go through JSON text and the
// schema as the app's do, a restore without a gap carries on exactly as the unbroken run, and a
// restore after a long gap leaves the world as the catch-up rules say (ADR 0018 §19).

/** Save and restore mid-run, at ticks drawn from the run's seed (`pnpm soak`). */
export interface SaveRestoreOptions {
  /** How many times to save and restore. */
  cycles: number;
  /**
   * After each restore without a gap, the world from before the save runs on beside the restored
   * one for this many ticks, and the two must emit the same decisions and events every tick and
   * end in the same state.
   */
  compareTicks: number;
  /**
   * Makes one of the cycles a restore after a gap of 2 to 16 hours (capped at 12), with the
   * catch-up checks instead of the comparison.
   */
  longGap?: boolean;
}

/** One restore planned mid-run: after the tick numbered `afterStep` (0-based steps of the run). */
export interface PlannedRestore {
  afterStep: number;
  /** Wall-clock gap in ms; 0 for a restore that must carry on exactly. */
  gapMs: number;
}

/**
 * Where a run of `ticks` steps saves and restores, drawn from `seed`: one restore at a random
 * tick in each of `cycles` equal parts of the run, early enough in its part for the comparison
 * to end before the next.
 */
export function planRestores(seed: number, ticks: number, options: SaveRestoreOptions) {
  const rng = Rng.fromSeed(seed).fork("dev:save-restore");
  const cycles = Math.max(0, Math.floor(options.cycles));
  const part = Math.floor(ticks / Math.max(1, cycles));
  const longGapAt = options.longGap && cycles > 0 ? rng.int(0, cycles) : -1;
  const planned: PlannedRestore[] = [];
  for (let k = 0; k < cycles; k++) {
    const room = Math.max(1, part - options.compareTicks);
    const afterStep = k * part + rng.int(0, room);
    // Whole seconds, so the gap is a whole number of ticks at any usual rate.
    const gapMs = k === longGapAt ? rng.int(2 * 3600, 16 * 3600) * 1000 : 0;
    if (afterStep < ticks - 1) planned.push({ afterStep, gapMs });
  }
  return planned;
}

/**
 * Saves `simulation` as the app does, to JSON text, and reads it back as the app's worker does,
 * through the schema. JSON turns NaN and Infinity into null and drops undefined, so a save the
 * schema accepts as plain data may still fail here.
 */
export function saveThroughText(
  simulation: Simulation,
  savedAt: number,
): { ok: true; save: WorldSave; bytes: number } | { ok: false; problem: string } {
  const text = JSON.stringify(simulation.save(savedAt));
  const parsed = parseWorldSave(JSON.parse(text));
  if (!parsed.ok) {
    return {
      ok: false,
      problem: `save doesn't parse back: ${parsed.diagnostics.map(formatDiagnostic).join("; ")}`,
    };
  }
  return { ok: true, save: parsed.value, bytes: text.length };
}

/** A restore of the running world's own save drops and prunes nothing. */
export function restoreProblems(report: RestoreReport): string[] {
  const problems: string[] = [];
  const { droppedCreatures, prunedPlacements, droppedActions, catchUp } = report;
  if (droppedCreatures.length > 0) {
    problems.push(`restore dropped creatures: ${JSON.stringify(droppedCreatures)}`);
  }
  if (prunedPlacements.length > 0) {
    problems.push(`restore pruned placements: ${JSON.stringify(prunedPlacements)}`);
  }
  if (droppedActions.length > 0) {
    problems.push(`restore dropped actions: ${JSON.stringify(droppedActions)}`);
  }
  if (catchUp.failures.length > 0) {
    problems.push(`catch-up failures: ${JSON.stringify(catchUp.failures)}`);
  }
  return problems;
}

/** Per-creature events, which catch-up must not emit (ADR 0018 §19). */
const PER_CREATURE_EVENTS = new Set([
  "ate",
  "fell_asleep",
  "woke_up",
  "new_home_selected",
  "creature_stuck",
]);

/**
 * The world one step after a restore with catch-up (ADR 0018 §19, ADR 0019 §5), and that step's
 * `events`: the tick moved on by the capped gap, nothing announced (no phase change, no
 * per-creature events), every creature fed, asleep in its sleeping phase, awake otherwise, and
 * rested if its sleeping phase ended during the gap. Asleep, a creature with a home lies at its
 * spot there clear of the other sleepers; if home is full, it sleeps anywhere but there, and
 * `onFullHome` is called with it (issue #158). No creature sleeps at a shelter it keeps failing to
 * reach, home or not, and one whose home is failing may sleep anywhere else (issue #175). A creature resumed asleep counts as asleep from
 * that first step. `checkSleep` says which creatures sleep at night (the sleep check's filter).
 */
export function catchUpProblems(
  simulation: Simulation,
  save: WorldSave,
  report: RestoreReport,
  events: readonly SimulationEvent[],
  checkSleep: (creature: CreatureState) => boolean,
  onFullHome?: (creature: CreatureState) => void,
): string[] {
  const problems = events
    .filter((e) => e.type === "day_phase_changed" || PER_CREATURE_EVENTS.has(e.type))
    .map((e) => `first step after catch-up emitted ${JSON.stringify(e)}`);
  const { catchUp } = report;
  if (!catchUp.applied) return [`no catch-up after a gap of ${report.gapMs} ms`];
  const { state } = simulation;
  // The jump, then the one step since.
  const jumped = state.tick - save.tick - 1;
  const expected = Math.round((catchUp.gapMs / 1000) * simulation.tickRateHz);
  if (jumped !== expected) {
    problems.push(`tick moved on by ${jumped}, not by the capped gap's ${expected} ticks`);
  }
  if (state.creatures.size !== save.creatures.length) {
    problems.push(
      `${state.creatures.size} creatures after catch-up, ${save.creatures.length} saved`,
    );
  }
  for (const creature of state.creatures.values()) {
    // Its own day (issue #85), by its present offsets. Below, only the end of a night in the gap
    // matters, which is its dawn start, and only while it is awake now: its morning offset then
    // changed last when that night began, so the present one is the one that moved that dawn.
    const spans = phaseSpans(state.minutes, catchUp.gapMs, creaturePhaseStarts(creature.day));
    const phase = creature.day.phase;
    const who = creature.id;
    const hunger = creature.needs[hungerNeed.id];
    if (hunger !== undefined && !(hunger < hungerNeed.actAt)) {
      problems.push(`${who}: hunger ${hunger} after catch-up, not fed`);
    }
    if (!checkSleep(creature) || creature.releasedAtTick !== undefined) continue;
    const { sleeping } = sleepCycle(phase, false);
    if (sleeping !== creature.asleep) {
      problems.push(`${who}: ${creature.asleep ? "asleep" : "awake"} at its ${phase}`);
    }
    // Never at a shelter it keeps failing to reach (issue #175); a failing home is no exception.
    const bed = sleepsAt(creature);
    if (bed !== null && isFailingShelter(creature.knowledge, bed)) {
      problems.push(`${who}: asleep at ${bed}, a shelter it keeps failing to reach`);
    }
    if (
      sleeping &&
      creature.home !== null &&
      !isFailingShelter(creature.knowledge, creature.home)
    ) {
      // Its spot clear of the others asleep, as catch-up chose it; none clear while home has a
      // spot at all means home is full, and it sleeps elsewhere (issue #158).
      const spot = simulation.spotFor(who, creature.home, { clearOfSleepers: SLEEPER_GAP });
      const full = !spot && simulation.spotFor(who, creature.home) !== undefined;
      if (full) {
        onFullHome?.(creature);
        if (sleepsAt(creature) === creature.home) {
          problems.push(`${who}: asleep at its full home ${creature.home}`);
        }
      } else if (!isDeepStrictEqual(spot, creature.position)) {
        problems.push(`${who}: away from its home ${creature.home} in its sleeping phase`);
      }
    }
    // Rested: tiredness was 0 when the night ended in the gap, and rose awake since.
    let hoursSinceNight: number | undefined;
    let slept = false;
    for (const { phase, hours } of spans) {
      const cycle = sleepCycle(phase, false);
      if (cycle.waking && slept) hoursSinceNight = 0;
      slept = cycle.sleeping;
      if (hoursSinceNight !== undefined) hoursSinceNight += hours;
    }
    const tiredness = creature.needs[tirednessNeed.id];
    if (hoursSinceNight === undefined || sleeping || tiredness === undefined) continue;
    const rate = tirednessNeed.perHour.awake * (creature.variation.needs[tirednessNeed.id] ?? 1);
    // Plus the step since.
    const hours = hoursSinceNight + 1 / simulation.tickRateHz / 3600;
    if (tiredness > rate * hours + 1e-9) {
      problems.push(
        `${who}: tiredness ${tiredness.toFixed(3)} ${hoursSinceNight.toFixed(1)} h after the night, not rested`,
      );
    }
  }
  return problems;
}

/** The shelter a creature sleeps at, from its running `core:sleep`; null in the open or awake. */
export function sleepsAt(creature: CreatureState): string | null {
  const { action } = creature;
  if (!creature.asleep || action?.id !== "core:sleep") return null;
  const { placementId } = action.state as { placementId?: unknown };
  return typeof placementId === "string" ? placementId : null;
}

/**
 * Any two creatures asleep at the same shelter lie at least their two body radii plus
 * `SLEEPER_GAP` apart, centre to centre and ignoring height, as in the open (issue #158).
 */
export function shelterSpacingProblems(simulation: Simulation): string[] {
  const { state } = simulation;
  const byShelter = new Map<string, CreatureState[]>();
  for (const creature of state.creatures.values()) {
    const shelter = sleepsAt(creature);
    if (shelter !== null) byShelter.set(shelter, [...(byShelter.get(shelter) ?? []), creature]);
  }
  const radius = (c: CreatureState) =>
    state.pathfinderFor(c.speciesId)?.navigation.profile.radius ?? 0;
  const problems: string[] = [];
  for (const [shelter, sleepers] of byShelter) {
    for (const [i, a] of sleepers.entries()) {
      for (const b of sleepers.slice(i + 1)) {
        const apart = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
        const reach = radius(a) + radius(b) + SLEEPER_GAP;
        if (apart < reach) {
          problems.push(
            `${a.id} and ${b.id} asleep at ${shelter} ${apart.toFixed(3)} m apart, under ${reach.toFixed(3)} m`,
          );
        }
      }
    }
  }
  return problems;
}

/** Wall-clock time in a headless run: a fixed epoch plus simulated time and gaps. */
export const RUN_EPOCH_MS = Date.UTC(2026, 0, 1);

/** Whether two steps' outputs agree; their first difference otherwise. */
export function firstDifference(expected: unknown, actual: unknown, path = ""): string | undefined {
  if (isDeepStrictEqual(expected, actual)) return undefined;
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null;
  if (isObject(expected) && isObject(actual) && Array.isArray(expected) === Array.isArray(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const found = firstDifference(expected[key], actual[key], `${path}/${key}`);
      if (found) return found;
    }
  }
  const show = (v: unknown) => (v === undefined ? "missing" : JSON.stringify(v).slice(0, 200));
  return `at ${path || "/"}: expected ${show(expected)}, got ${show(actual)}`;
}
