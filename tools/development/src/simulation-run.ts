import {
  error,
  formatDiagnostic,
  type Result,
  type WorldDefinition,
  type WorldEdit,
  type WorldEditResult,
  type WorldSave,
} from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  formatClockTime,
  hungerNeed,
  isNocturnal,
  pointInPolygon,
  minutesAfter,
  registerCoreEngine,
  Simulation,
  speciesTraits,
  tirednessNeed,
  type CreatureState,
  type DecisionTrace,
  type RestoreReport,
  type Navigation,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { emptyEditReport, type EditReport, type EditRequest, type EditSource } from "./edit-cycles";
import {
  LongRunChecks,
  type CreatureFilter,
  type CreatureStats,
  type LongRunCheckOptions,
} from "./long-run-checks";
import {
  catchUpProblems,
  firstDifference,
  planRestores,
  restoreProblems,
  RUN_EPOCH_MS,
  saveThroughText,
  shelterSpacingProblems,
  type PlannedRestore,
  type SaveRestoreOptions,
} from "./save-cycles";

const FOOD = "core:food";

// Long randomized runs with the M3 invariants checked every tick (roadmap M3 tests), plus the
// living-behavior checks of ADR 0018 §20 (long-run-checks.ts). Shared by the Vitest suite (a few
// seeds), `pnpm soak` (many) and `pnpm sim`.

export interface RunOptions extends LongRunCheckOptions {
  register: (registries: Registries) => unknown;
  worldId: string;
  speciesId: string;
  seed: number;
  ticks: number;
  creatures: number;
  /**
   * More species to spawn after the `creatures` of `speciesId`, as species ID to count, e.g. an
   * amphibian and a water-only swimmer beside the mosslings in `pnpm soak`.
   */
  alsoSpawn?: Readonly<Record<string, number>>;
  /** Default 10, the app's rate. */
  tickRateHz?: number;
  /** Most creatures the world holds. No limit if omitted. */
  maxCreatures?: number;
  /**
   * The time of day the run starts at, in minutes since midnight; default noon. It then follows
   * simulation time, as the main thread's clock would at speed 1 (ADR 0018 §5).
   */
  startMinutes?: number;
  /**
   * A save to restore before the run (`pnpm sim --load`), with the wall-clock time and time of
   * day to restore it at; `creatures` are spawned after it. The time of day then follows
   * simulation time from `minutes`, and `startMinutes` is unused.
   */
  restore?: { save: WorldSave; nowMs: number; minutes: number };
  /** Save and restore mid-run at random ticks, checking each restore (`pnpm soak`). */
  saveRestore?: SaveRestoreOptions;
  /**
   * World edits to apply between steps (ADR 0021): a script (`pnpm sim --edits`) or random edits
   * (`pnpm soak`). Each is applied with `Simulation.applyEdit` and timed, and the creatures are
   * checked at once after it; an undo applies the inverse of the last edit applied and not undone.
   */
  edits?: EditSource;
  /** Called after each edit request, applied or refused. */
  onEdit?: (log: EditLog) => void;
  onTrace?: (trace: DecisionTrace) => void;
  /**
   * Called after every tick, e.g. to record trajectories. After a mid-run restore, it is passed
   * the restored simulation.
   */
  onTick?: (simulation: Simulation, events: SimulationEvent[]) => void;
  /** Called with the simulation as the run leaves it. */
  onEnd?: (simulation: Simulation) => void;
}

/** One edit request of a run and what came of it. */
export interface EditLog {
  /** The step it was applied before, counted from the run's start. */
  step: number;
  request: EditRequest;
  /** The edit applied, an undo's inverse included; undefined for an undo with nothing to undo. */
  edit?: WorldEdit;
  result: WorldEditResult;
  ms: number;
}

/** Where a run starts in the day unless told otherwise. */
export const DEFAULT_START_MINUTES = 12 * 60;

/**
 * Whether the meal check holds a creature to it: it gets hungry and, from where it is first seen,
 * it can reach its spot at some food (ADR 0018 §20).
 */
export const reachesFood: CreatureFilter = (creature, simulation) =>
  Object.hasOwn(creature.needs, hungerNeed.id) &&
  (simulation.state.model.propsByAffordance.get(FOOD) ?? []).some(
    (prop) => simulation.spotFor(creature.id, prop.id) !== undefined,
  );

/**
 * Whether the sleep check holds a creature to it: it gets tired and sleeps at night (§20). A
 * `core:nocturnal` creature sleeps by day, so it skips the check.
 */
export const sleepsAtNight: CreatureFilter = (creature, simulation) => {
  const { registries } = simulation.state;
  const species = registries.species.get(creature.speciesId);
  return (
    Object.hasOwn(creature.needs, tirednessNeed.id) &&
    !!species &&
    !isNocturnal(speciesTraits(species, registries))
  );
};

/**
 * The meal and sleep checks of ADR 0018 §20, on for the creatures they apply to. Woodland Hollow
 * runs use them; a species that only wanders has no needs, so neither applies to it.
 */
export const LIVING_BEHAVIOR_CHECKS = {
  meals: { creatures: reachesFood },
  sleep: { creatures: sleepsAtNight },
} satisfies LongRunCheckOptions;

export interface RunReport {
  seed: number;
  ticks: number;
  tickRateHz: number;
  /** The first few invariant violations; empty when the run is clean. */
  violations: string[];
  eventCounts: Record<string, number>;
  /** Tick of the first `first_use_of_structure`, if any. */
  firstStructureUse?: number;
  /** Ticks spent in each region, over all creatures. */
  regionTicks: Record<string, number>;
  decisions: number;
  /** Per creature ID: decisions, interruptions, meals, hunger and sleep. */
  creatures: Record<string, CreatureStats>;
  elapsedMs: number;
  /** What restoring `RunOptions.restore` dropped, pruned and caught up. */
  restore?: RestoreReport;
  /** Mid-run saves and restores (`RunOptions.saveRestore`). */
  saveRestore: {
    restores: number;
    /** Ticks an unbroken twin ran beside a restored world. */
    comparedTicks: number;
    /**
     * Creatures put to bed by catch-up away from a home that was full (issue #158), as the
     * catch-up check found them.
     */
    fullHomes: number;
    /** The largest save, in UTF-16 code units of JSON text. */
    largestSaveBytes: number;
    /** The restore after a long gap, if any: the gap and the time of day it ended at. */
    longGap?: { gapMs: number; at: string };
  };
  /** World edits (`RunOptions.edits`). */
  edits: EditReport;
}

const MAX_VIOLATIONS = 20;
/** Added to the run's seed for the fresh worlds that saves are restored into mid-run. */
const RESTORED_SEED_OFFSET = 1_000_003;

/** The engine plus `register`, with references resolved. */
export function loadContent(register: RunOptions["register"]): Result<Registries> {
  const registries = createRegistries();
  registerCoreEngine(registries);
  register(registries);
  const { diagnostics } = resolveReferences(registries);
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: registries };
}

/**
 * A fresh simulation of `options.worldId`, or of `world` instead: a definition of that world as
 * edited, which a mid-run restore of an edited world starts from (see `runWithInvariants`).
 */
export function createSimulation(
  options: Omit<RunOptions, "ticks" | "creatures" | "speciesId" | "alsoSpawn">,
  world?: WorldDefinition,
) {
  const content = loadContent(options.register);
  if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
  const created = Simulation.create(content.value, {
    ...(world ? { world } : { worldId: options.worldId }),
    seed: options.seed,
    ...(options.tickRateHz === undefined ? {} : { tickRateHz: options.tickRateHz }),
    ...(options.maxCreatures === undefined ? {} : { maxCreatures: options.maxCreatures }),
    minutes: options.startMinutes ?? DEFAULT_START_MINUTES,
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });
  if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
  return created.value;
}

/** A simulation whose decision traces collect in `traces` until taken. */
interface Traced {
  simulation: Simulation;
  traces: DecisionTrace[];
}

export function runWithInvariants(options: RunOptions): RunReport {
  const started = performance.now();
  let decisions = 0;
  const traced = (seed = options.seed, world?: WorldDefinition): Traced => {
    const traces: DecisionTrace[] = [];
    const simulation = createSimulation(
      { ...options, seed, onTrace: (trace) => traces.push(trace) },
      world,
    );
    return { simulation, traces };
  };
  let main = traced();
  let simulation = main.simulation;
  /**
   * The time of day follows simulation time from an anchor (ADR 0018 §5): `minutes` at `tick`.
   * A restore after a gap moves both.
   */
  let anchor = { tick: 0, minutes: options.startMinutes ?? DEFAULT_START_MINUTES };
  const minutesAt = (tick: number) =>
    minutesAfter(anchor.minutes, ((tick - anchor.tick) * 1000) / simulation.tickRateHz);
  let restoreReport: RestoreReport | undefined;
  if (options.restore) {
    const { save, nowMs, minutes } = options.restore;
    const restored = simulation.restore(save, { nowMs, minutes });
    if (!restored.ok) throw new Error(restored.diagnostics.map(formatDiagnostic).join("\n"));
    restoreReport = restored.value;
    anchor = { tick: simulation.tick, minutes };
  }
  /** The headless wall clock: simulated time and gaps since a fixed epoch, or since the restore. */
  let wallMs = options.restore?.nowMs ?? RUN_EPOCH_MS;
  const spawns: [string, number][] = [
    [options.speciesId, options.creatures],
    ...Object.entries(options.alsoSpawn ?? {}),
  ];
  for (const [speciesId, count] of spawns) {
    for (let n = 0; n < count; n++) {
      const spawned = simulation.spawn(speciesId);
      if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
    }
  }

  // Per species, since `onTick` may add species with other navigation profiles. Like the world
  // model, read afresh each time: an edit replaces both.
  const navigationOf = (speciesId: string) => simulation.state.pathfinderFor(speciesId)?.navigation;
  const report: RunReport = {
    seed: options.seed,
    ticks: options.ticks,
    tickRateHz: simulation.tickRateHz,
    violations: [],
    eventCounts: {},
    regionTicks: {},
    decisions: 0,
    creatures: {},
    elapsedMs: 0,
    ...(restoreReport ? { restore: restoreReport } : {}),
    saveRestore: { restores: 0, comparedTicks: 0, largestSaveBytes: 0, fullHomes: 0 },
    edits: emptyEditReport(),
  };
  const violation = (message: string) => {
    if (report.violations.length < MAX_VIOLATIONS) {
      report.violations.push(`seed ${options.seed}, tick ${simulation.tick}: ${message}`);
    }
  };
  const checks = new LongRunChecks(simulation.tickRateHz, options, violation);
  /** Per creature, whether the meal and sleep checks apply, decided when first seen. */
  const checked = new Map<string, { checkMeals: boolean; checkSleep: boolean }>();
  const checkedFor = (state: CreatureState) => {
    let entry = checked.get(state.id);
    if (!entry) {
      entry = {
        checkMeals: options.meals?.creatures?.(state, simulation) ?? true,
        checkSleep: options.sleep?.creatures?.(state, simulation) ?? true,
      };
      checked.set(state.id, entry);
    }
    return entry;
  };

  const restores = options.saveRestore
    ? planRestores(options.seed, options.ticks, options.saveRestore)
    : [];
  const tickMs = 1000 / simulation.tickRateHz;
  /** The world from before a restore without a gap, run on beside the restored one. */
  let twin: (Traced & { ticksLeft: number }) | undefined;
  /** Set by a restore with catch-up, which is checked after the step that follows. */
  let caughtUp: { save: WorldSave; report: RestoreReport } | undefined;

  /**
   * Every creature where it may be, after each tick and each edit: in a region its locomotion
   * covers, on a walkable cell of its own profile, on the region's surface, inside the bounds and
   * never under another water region's surface.
   */
  const checkPositions = (snapshot: ReturnType<Simulation["snapshot"]>) => {
    const { model } = simulation.state;
    const { min, max } = model.bounds;
    const water = [...model.regions.values()].filter((r) => r.kind === "water");
    for (const c of snapshot.creatures) {
      const { regionId, x, z } = c.position;
      const where = `${c.id} at "${regionId}" (${x.toFixed(3)}, ${z.toFixed(3)})`;
      if (!Number.isFinite(x) || !Number.isFinite(z)) {
        violation(`${where}: not a finite position`);
        continue;
      }
      const region = model.regions.get(regionId);
      if (!region) {
        violation(`${where}: unknown region`);
        continue;
      }
      // Per capability (ADR 0020): only in a region kind its locomotion covers, so a walker
      // never in water, and on a walkable cell of its own profile there.
      const navigation = navigationOf(c.speciesId);
      if (!navigation?.profile.maxSlopeByKind.has(region.kind)) {
        violation(`${where}: in a ${region.kind} region it can't move in`);
      }
      if (!navigation?.masks.get(regionId)?.isWalkableAt(x, z)) {
        violation(`${where}: not on a walkable cell`);
      }
      if (region.kind !== "water" && c.submersion !== 0) {
        violation(`${where}: submerged by ${c.submersion} out of the water`);
      }
      const y = c.world.y;
      if (!Number.isFinite(y) || y !== region.surface.heightAt(x, z)) {
        violation(`${where}: height ${y} is not on the region's surface`);
      }
      if (x < min.x || x > max.x || z < min.z || z > max.z || y < min.y || y > max.y) {
        violation(`${where}: outside the world bounds`);
      }
      for (const w of water) {
        // A swimmer is on its own water region's surface, never under another's.
        if (w === region) continue;
        const surface = w.surface.heightAt(x, z);
        if (surface !== undefined && pointInPolygon(x, z, w.footprint) && y <= surface) {
          violation(`${where}: under the surface of "${w.id}"`);
        }
      }
    }
  };

  /**
   * After an edit, decides afresh whether the meal check holds each creature it has seen: an edit
   * may take away the only food it could reach, or cut it off from all food, which the edit's
   * `disconnected_region` warning tells the editor. Its time without food in reach doesn't count
   * if food comes back. `EditReport.foodCutOff` counts the creatures that lose the check.
   */
  const refreshMealCheck = () => {
    if (!options.meals?.creatures) return;
    for (const [id, entry] of checked) {
      const creature = simulation.state.creatures.get(id);
      if (!creature) continue;
      const checkMeals = options.meals.creatures(creature, simulation);
      if (entry.checkMeals && !checkMeals) report.edits.foodCutOff++;
      if (!entry.checkMeals && checkMeals) checks.mealsResumed(id);
      entry.checkMeals = checkMeals;
    }
  };

  /** Inverses of the edits applied and not undone, the last on top. */
  const undoStack: WorldEdit[] = [];
  /**
   * Each species' navigation from before the first edit since the last step, to tell the routes
   * an edit took away (`EditReport.lostGoals`) from other failed paths.
   */
  let navigationsBeforeEdit: Map<string, Navigation | undefined> | undefined;
  /**
   * Applies one edit request between steps, to the unbroken twin too while one runs, which must
   * answer the same; then checks every creature's position at once.
   */
  const applyEditRequest = (step: number, request: EditRequest) => {
    const undo = "undo" in request;
    const edit = undo ? undoStack.pop() : request.edit;
    const { edits } = report;
    if (!edit) {
      const result: WorldEditResult = {
        ok: false,
        diagnostics: [error("nothing_to_undo", "No edit left to undo")],
      };
      edits.rejected.nothing_to_undo = (edits.rejected.nothing_to_undo ?? 0) + 1;
      options.onEdit?.({ step, request, result, ms: 0 });
      return;
    }
    navigationsBeforeEdit ??= new Map(
      [...simulation.state.creatures.values()].map((c) => [c.speciesId, navigationOf(c.speciesId)]),
    );
    const started = performance.now();
    const result = simulation.applyEdit(edit);
    const ms = performance.now() - started;
    edits.applyMs.push(ms);
    if (twin) {
      const differs = firstDifference(result, twin.simulation.applyEdit(edit));
      if (differs) violation(`an edit did otherwise in the unbroken run: ${differs}`);
    }
    if (result.ok) {
      edits.applied++;
      if (undo) edits.undos++;
      else undoStack.push(result.inverse);
      edits.relocated += result.relocated.length;
      refreshMealCheck();
      for (const w of result.warnings) edits.warnings[w.code] = (edits.warnings[w.code] ?? 0) + 1;
      checkPositions(simulation.snapshot());
    } else {
      const code = result.diagnostics[0]?.code ?? "unknown";
      edits.rejected[code] = (edits.rejected[code] ?? 0) + 1;
      // A refused undo leaves the history as it was.
      if (undo) undoStack.push(edit);
    }
    options.onEdit?.({ step, request, edit, result, ms });
  };

  for (let t = 0; t < options.ticks; t++) {
    for (const request of options.edits?.(t, simulation) ?? []) applyEditRequest(t, request);
    const minutes = minutesAt(simulation.tick);
    simulation.setTimeOfDay(minutes);
    // Where each creature stood before the tick, to check that a bank jump starts where one of
    // its crossings does.
    const before = new Map(
      [...simulation.state.creatures.values()].map((c) => [c.id, { ...c.position }]),
    );
    const events = simulation.step();
    wallMs += tickMs;
    const traces = main.traces.splice(0);
    decisions += traces.length;
    for (const trace of traces) {
      checks.trace(trace);
      options.onTrace?.(trace);
    }
    if (twin) {
      twin.simulation.setTimeOfDay(minutes);
      const expected = { events: twin.simulation.step(), traces: twin.traces.splice(0) };
      let differs = firstDifference(expected, { events, traces });
      if (!differs && --twin.ticksLeft === 0) {
        // Not the debug snapshot: its route comes from a cache of the last path walked, which a
        // restore clears, so a creature that arrived and is still at its action shows `[]` in
        // the unbroken run and no route after a restore. The save holds the rest of it.
        differs = firstDifference(
          [
            twin.simulation.save(0),
            twin.simulation.snapshot(),
            twin.simulation.state.model.definition,
          ],
          [simulation.save(0), simulation.snapshot(), simulation.state.model.definition],
        );
      }
      report.saveRestore.comparedTicks++;
      if (differs) violation(`the restored world differs from the unbroken run: ${differs}`);
      if (differs || twin.ticksLeft === 0) twin = undefined;
    }
    if (caughtUp) {
      const sleeps = (c: CreatureState) => checkedFor(c).checkSleep;
      const { save, report: restored } = caughtUp;
      const fullHome = () => void report.saveRestore.fullHomes++;
      for (const problem of catchUpProblems(simulation, save, restored, events, sleeps, fullHome)) {
        violation(problem);
      }
      caughtUp = undefined;
    }
    if (navigationsBeforeEdit) {
      // An edit replans every walk at once (ADR 0021 §6); one whose goal the edit covered or cut
      // off fails, with `path_failed`, and the walk is interrupted. That is the edit's doing.
      for (const event of events) {
        if (event.type !== "path_failed" || event.reason === "start_not_walkable") continue;
        const speciesId = simulation.state.creatures.get(event.creatureId)?.speciesId ?? "";
        const { regionId, x, z } = event.to;
        if (navigationsBeforeEdit.get(speciesId)?.masks.get(regionId)?.isWalkableAt(x, z)) {
          report.edits.lostGoals++;
        }
      }
      navigationsBeforeEdit = undefined;
    }
    for (const event of events) {
      report.eventCounts[event.type] = (report.eventCounts[event.type] ?? 0) + 1;
      checks.event(event, { dayPhase: simulation.state.dayPhase, minutes });
      if (event.type === "first_use_of_structure") report.firstStructureUse ??= event.tick;
      if (event.type === "entered_region") {
        // Regions change only through a connection that joins them, in a direction it allows,
        // or by a jump across a bank, either way between land and water, from where one of the
        // creature's own profile's bank crossings starts to where it lands (ADR 0020 §4,
        // "Contradictions resolved"). A jump starts the creature's move on its tick and ends it,
        // so it stood at the start before the tick and still stands where it landed.
        const { fromRegionId: from, toRegionId: to, connectionId } = event;
        const c = simulation.state.model.connections.find((c) => c.id === connectionId);
        const forward = c?.from === from && c.to === to;
        const backward = c?.bidirectional && c.to === from && c.from === to;
        const creature = simulation.state.creatures.get(event.creatureId);
        const landed = creature?.position;
        const left = before.get(event.creatureId);
        const jump =
          connectionId === undefined &&
          landed !== undefined &&
          left !== undefined &&
          simulation.state
            .pathfinderFor(creature?.speciesId ?? "")
            ?.bankCrossings(from)
            .some(
              (x) =>
                x.toRegionId === to &&
                x.from.x === left.x &&
                x.from.z === left.z &&
                x.to.x === landed.x &&
                x.to.z === landed.z,
            );
        if (!forward && !backward && !jump) {
          violation(
            `${event.creatureId} went ${from} → ${to} via ${connectionId === undefined ? "no connection" : `"${connectionId}"`}`,
          );
        }
      }
    }
    for (const problem of shelterSpacingProblems(simulation)) violation(problem);
    const snapshot = simulation.snapshot();
    checks.tick(
      simulation.tick,
      simulation.state.dayPhase,
      snapshot.creatures.map((c) => {
        // Every snapshot creature has state.
        const state = simulation.state.creatures.get(c.id) as CreatureState;
        const { needs, asleep } = state;
        return {
          id: c.id,
          speciesId: c.speciesId,
          needs,
          asleep,
          cues: c.cues,
          ...checkedFor(state),
        };
      }),
    );
    for (const c of snapshot.creatures) {
      const { regionId } = c.position;
      report.regionTicks[regionId] = (report.regionTicks[regionId] ?? 0) + 1;
    }
    checkPositions(snapshot);
    options.onTick?.(simulation, events);
    if (restores[0]?.afterStep === t) {
      const { gapMs } = restores.shift() as PlannedRestore;
      const savedAt = Math.round(wallMs);
      const saved = saveThroughText(simulation, savedAt);
      if (!saved.ok) {
        violation(saved.problem);
        continue;
      }
      const { save } = saved;
      report.saveRestore.largestSaveBytes = Math.max(
        report.saveRestore.largestSaveBytes,
        saved.bytes,
      );
      // A fresh world of another seed, as the app's at startup, then the save, which must bring
      // back the saved seed and the streams forked from it.
      //
      // TODO(M17 PR 4): a save doesn't carry an edited world or the generated-ID counter yet.
      // Until it does, a world edited in this run is restored into a fresh world built from the
      // edited definition, with the counter carried over by hand, standing in for what the save
      // will bring. Once PR 4 lands, drop `edited` here and the counter below, so the save alone
      // brings the edited world back into a fresh world of `worldId`.
      const edited = report.edits.applied > 0 ? simulation.state.model.definition : undefined;
      const next = traced(options.seed + RESTORED_SEED_OFFSET, edited);
      // Without a gap the next step's time of day; after one, that plus the gap.
      const present = minutesAfter(minutesAt(simulation.tick), gapMs);
      wallMs += gapMs;
      const restored = next.simulation.restore(save, { nowMs: savedAt + gapMs, minutes: present });
      if (!restored.ok) {
        violation(`restore failed: ${restored.diagnostics.map(formatDiagnostic).join("; ")}`);
        continue;
      }
      if (edited) next.simulation.state.nextPropId = simulation.state.nextPropId;
      report.saveRestore.restores++;
      for (const problem of restoreProblems(restored.value)) violation(problem);
      const previous = main;
      main = next;
      simulation = next.simulation;
      if (gapMs === 0) {
        twin = { ...previous, ticksLeft: options.saveRestore?.compareTicks ?? 0 };
        if (twin.ticksLeft <= 0) twin = undefined;
      } else {
        twin = undefined;
        anchor = { tick: simulation.tick, minutes: present };
        report.saveRestore.longGap = { gapMs, at: formatClockTime(present) };
        // Catch-up feeds every creature, so the meal check counts from here.
        checks.caughtUp();
        caughtUp = { save, report: restored.value };
      }
    }
  }
  checks.finish();
  options.onEnd?.(simulation);
  report.decisions = decisions;
  report.creatures = Object.fromEntries(checks.creatures);
  report.elapsedMs = performance.now() - started;
  return report;
}
