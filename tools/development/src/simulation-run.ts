import { formatDiagnostic, type Result } from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  pointInPolygon,
  minutesAfter,
  registerCoreEngine,
  Simulation,
  type DecisionTrace,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { LongRunChecks, type CreatureStats, type LongRunCheckOptions } from "./long-run-checks";

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
  /** Default 10, the app's rate. */
  tickRateHz?: number;
  /** Most creatures the world holds. No limit if omitted. */
  maxCreatures?: number;
  /**
   * The time of day the run starts at, in minutes since midnight; default noon. It then follows
   * simulation time, as the main thread's clock would at speed 1 (ADR 0018 §5).
   */
  startMinutes?: number;
  onTrace?: (trace: DecisionTrace) => void;
  /** Called after every tick, e.g. to record trajectories. */
  onTick?: (simulation: Simulation, events: SimulationEvent[]) => void;
}

/** Where a run starts in the day unless told otherwise. */
export const DEFAULT_START_MINUTES = 12 * 60;

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
}

const MAX_VIOLATIONS = 20;

/** The engine plus `register`, with references resolved. */
export function loadContent(register: RunOptions["register"]): Result<Registries> {
  const registries = createRegistries();
  registerCoreEngine(registries);
  register(registries);
  const { diagnostics } = resolveReferences(registries);
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, value: registries };
}

export function createSimulation(options: Omit<RunOptions, "ticks" | "creatures" | "speciesId">) {
  const content = loadContent(options.register);
  if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
  const created = Simulation.create(content.value, {
    worldId: options.worldId,
    seed: options.seed,
    ...(options.tickRateHz === undefined ? {} : { tickRateHz: options.tickRateHz }),
    ...(options.maxCreatures === undefined ? {} : { maxCreatures: options.maxCreatures }),
    minutes: options.startMinutes ?? DEFAULT_START_MINUTES,
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });
  if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
  return created.value;
}

export function runWithInvariants(options: RunOptions): RunReport {
  const started = performance.now();
  let decisions = 0;
  /** This tick's traces, for the checks. */
  const traces: DecisionTrace[] = [];
  const simulation = createSimulation({
    ...options,
    onTrace: (trace) => {
      decisions++;
      traces.push(trace);
      options.onTrace?.(trace);
    },
  });
  for (let n = 0; n < options.creatures; n++) {
    const spawned = simulation.spawn(options.speciesId);
    if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
  }

  const { model } = simulation.state;
  // Per species, since `onTick` may add species with other navigation profiles.
  const masksOf = (speciesId: string) =>
    simulation.state.pathfinderFor(speciesId)?.navigation.masks;
  const water = [...model.regions.values()].filter((r) => r.kind === "water");
  const { min, max } = model.bounds;
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
  };
  const violation = (message: string) => {
    if (report.violations.length < MAX_VIOLATIONS) {
      report.violations.push(`seed ${options.seed}, tick ${simulation.tick}: ${message}`);
    }
  };
  const checks = new LongRunChecks(simulation.tickRateHz, options, violation);

  const startMinutes = options.startMinutes ?? DEFAULT_START_MINUTES;
  for (let t = 0; t < options.ticks; t++) {
    simulation.setTimeOfDay(
      minutesAfter(startMinutes, (simulation.tick * 1000) / simulation.tickRateHz),
    );
    const events = simulation.step();
    for (const trace of traces) checks.trace(trace);
    traces.length = 0;
    for (const event of events) {
      report.eventCounts[event.type] = (report.eventCounts[event.type] ?? 0) + 1;
      checks.event(event);
      if (event.type === "first_use_of_structure") report.firstStructureUse ??= event.tick;
      if (event.type === "entered_region") {
        // Regions change only through a connection that joins them, in a direction it allows.
        const c = model.connections.find((c) => c.id === event.connectionId);
        const forward = c?.from === event.fromRegionId && c.to === event.toRegionId;
        const backward =
          c?.bidirectional && c.to === event.fromRegionId && c.from === event.toRegionId;
        if (!forward && !backward) {
          violation(
            `${event.creatureId} went ${event.fromRegionId} → ${event.toRegionId} via "${event.connectionId}"`,
          );
        }
      }
    }
    const snapshot = simulation.snapshot();
    checks.tick(
      simulation.tick,
      simulation.state.dayPhase,
      snapshot.creatures.map((c) => {
        const state = simulation.state.creatures.get(c.id);
        const needs = state?.needs ?? {};
        return {
          id: c.id,
          speciesId: c.speciesId,
          needs,
          asleep: state?.asleep ?? false,
          cues: c.cues,
        };
      }),
    );
    for (const c of snapshot.creatures) {
      const { regionId, x, z } = c.position;
      const where = `${c.id} at "${regionId}" (${x.toFixed(3)}, ${z.toFixed(3)})`;
      report.regionTicks[regionId] = (report.regionTicks[regionId] ?? 0) + 1;
      const region = model.regions.get(regionId);
      if (!region) {
        violation(`${where}: unknown region`);
        continue;
      }
      if (region.kind === "water") violation(`${where}: in a water region`);
      if (!masksOf(c.speciesId)?.get(regionId)?.isWalkableAt(x, z)) {
        violation(`${where}: not on a walkable cell`);
      }
      const y = c.world.y;
      if (!Number.isFinite(y) || y !== region.surface.heightAt(x, z)) {
        violation(`${where}: height ${y} is not on the region's surface`);
      }
      if (x < min.x || x > max.x || z < min.z || z > max.z || y < min.y || y > max.y) {
        violation(`${where}: outside the world bounds`);
      }
      for (const w of water) {
        const surface = w.surface.heightAt(x, z);
        if (surface !== undefined && pointInPolygon(x, z, w.footprint) && y <= surface) {
          violation(`${where}: under the surface of "${w.id}"`);
        }
      }
    }
    options.onTick?.(simulation, events);
  }
  checks.finish();
  report.decisions = decisions;
  report.creatures = Object.fromEntries(checks.creatures);
  report.elapsedMs = performance.now() - started;
  return report;
}
