import { formatDiagnostic, parseWorldSave, type WorldSave } from "@living-diorama/content-schema";
import {
  hungerNeed,
  phaseSpans,
  Rng,
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
 * per-creature events), every creature fed, asleep in its sleeping phase (at home if it has one),
 * awake otherwise, and rested if its sleeping phase ended during the gap. A creature resumed
 * asleep counts as asleep from that first step. `checkSleep` says which creatures sleep at night
 * (the sleep check's filter).
 */
export function catchUpProblems(
  simulation: Simulation,
  save: WorldSave,
  report: RestoreReport,
  events: readonly SimulationEvent[],
  checkSleep: (creature: CreatureState) => boolean,
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
  const spans = phaseSpans(state.minutes, catchUp.gapMs);
  for (const creature of state.creatures.values()) {
    const who = creature.id;
    const hunger = creature.needs[hungerNeed.id];
    if (hunger !== undefined && !(hunger < hungerNeed.actAt)) {
      problems.push(`${who}: hunger ${hunger} after catch-up, not fed`);
    }
    if (!checkSleep(creature) || creature.releasedAtTick !== undefined) continue;
    const { sleeping } = sleepCycle(state.dayPhase, false);
    if (sleeping !== creature.asleep) {
      problems.push(`${who}: ${creature.asleep ? "asleep" : "awake"} at ${state.dayPhase}`);
    }
    if (sleeping && creature.home !== null) {
      const spot = simulation.spotFor(who, creature.home);
      if (!isDeepStrictEqual(spot, creature.position)) {
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
