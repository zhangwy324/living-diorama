import { formatDiagnostic, type Result } from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  pointInPolygon,
  registerCoreEngine,
  Simulation,
  type DecisionTrace,
  type SimulationEvent,
} from "@living-diorama/simulation";

// Long randomized runs with the M3 invariants checked every tick (roadmap M3 tests). Shared by
// the Vitest suite (a few seeds) and `pnpm soak` (many).

export interface RunOptions {
  register: (registries: Registries) => unknown;
  worldId: string;
  speciesId: string;
  seed: number;
  ticks: number;
  creatures: number;
  /** Most creatures the world holds. No limit if omitted. */
  maxCreatures?: number;
  onTrace?: (trace: DecisionTrace) => void;
  /** Called after every tick, e.g. to record trajectories. */
  onTick?: (simulation: Simulation, events: SimulationEvent[]) => void;
}

export interface RunReport {
  seed: number;
  ticks: number;
  /** The first few invariant violations; empty when the run is clean. */
  violations: string[];
  eventCounts: Record<string, number>;
  /** Tick of the first `first_use_of_structure`, if any. */
  firstStructureUse?: number;
  /** Ticks spent in each region, over all creatures. */
  regionTicks: Record<string, number>;
  decisions: number;
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
    ...(options.maxCreatures === undefined ? {} : { maxCreatures: options.maxCreatures }),
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });
  if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
  return created.value;
}

export function runWithInvariants(options: RunOptions): RunReport {
  const started = performance.now();
  let decisions = 0;
  const simulation = createSimulation({
    ...options,
    onTrace: (trace) => {
      decisions++;
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
    violations: [],
    eventCounts: {},
    regionTicks: {},
    decisions: 0,
    elapsedMs: 0,
  };
  const violation = (message: string) => {
    if (report.violations.length < MAX_VIOLATIONS) {
      report.violations.push(`seed ${options.seed}, tick ${simulation.tick}: ${message}`);
    }
  };

  for (let t = 0; t < options.ticks; t++) {
    const events = simulation.step();
    for (const event of events) {
      report.eventCounts[event.type] = (report.eventCounts[event.type] ?? 0) + 1;
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
    for (const c of simulation.snapshot().creatures) {
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
  report.decisions = decisions;
  report.elapsedMs = performance.now() - started;
  return report;
}
