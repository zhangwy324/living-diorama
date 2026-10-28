import { registerBuiltInContent } from "@living-diorama/built-in-content";
import type { WorldDefinition } from "@living-diorama/content-schema";
import {
  formatClockTime,
  parseClockTime,
  type Navigation,
  type SimulationEvent,
  type WorldModel,
} from "@living-diorama/simulation";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { registerRiverCrossing } from "./fixtures/river-crossing";
import { runWithInvariants } from "./simulation-run";
import { renderDebugMap } from "./worldgen/debug-map";

// `pnpm sim`: the headless runner (ADR 0006 §12). Runs a world with the M3 invariants checked
// every tick, prints its events and a summary, writes every decision and event as NDJSON and
// draws the trajectories over the debug map. Exits with 1 on any invariant violation.

const WORLDS = {
  hollow: {
    register: registerBuiltInContent,
    worldId: "hollow:woodland-hollow",
    speciesId: "hollow:mossling",
  },
  river: {
    register: registerRiverCrossing,
    worldId: "fixture:river-crossing",
    speciesId: "fixture:pebble",
  },
};

const { values } = parseArgs({
  options: {
    world: { type: "string", default: "hollow" },
    seed: { type: "string", default: "1" },
    ticks: { type: "string", default: "6000" },
    creatures: { type: "string", default: "1" },
    // The time of day the run starts at; it follows simulation time from there (ADR 0018 §5).
    start: { type: "string", default: "12:00" },
    "no-map": { type: "boolean", default: false },
  },
});
const preset = WORLDS[values.world as keyof typeof WORLDS] as (typeof WORLDS)["hollow"] | undefined;
if (!preset) throw new Error(`--world must be one of: ${Object.keys(WORLDS).join(", ")}`);
const seed = Number(values.seed);
const ticks = Number(values.ticks);
const creatures = Number(values.creatures);
const startMinutes = parseClockTime(values.start);
if (startMinutes === undefined) throw new Error(`--start must be a time such as 21:30`);
const TICK_RATE_HZ = 10; // runWithInvariants uses the simulation default

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../out");
const base = resolve(outDir, `sim-${values.world}-${seed}`);
const lines: string[] = [];
const trajectories = new Map<string, { x: number; z: number }[]>();
let mapInputs: [WorldDefinition, WorldModel, Navigation] | undefined;

const time = (tick: number) => `${(tick / TICK_RATE_HZ).toFixed(1).padStart(7)} s`;
function describe(e: SimulationEvent): string {
  switch (e.type) {
    case "creature_spawned":
      return `spawned in ${e.regionId}`;
    case "species_introduced":
      return `first of ${e.speciesId}`;
    case "creature_despawned":
      return `despawned in ${e.regionId}`;
    case "entered_region":
      return `${e.fromRegionId} → ${e.toRegionId} via ${e.connectionId}`;
    case "first_use_of_structure":
      return `first use of ${e.structureId}`;
    case "path_failed":
      return `path failed (${e.reason}) to ${e.to.regionId} (${e.to.x.toFixed(1)}, ${e.to.z.toFixed(1)})`;
    case "creature_stuck":
      return `stuck for ${e.ticksStuck} ticks in ${e.position.regionId}`;
    case "day_phase_changed":
      return `${e.from} → ${e.to}`;
  }
}

const report = runWithInvariants({
  ...preset,
  seed,
  ticks,
  creatures,
  startMinutes,
  onTrace: (trace) => lines.push(JSON.stringify({ kind: "decision", ...trace })),
  onTick: (simulation, events) => {
    for (const event of events) {
      lines.push(JSON.stringify({ kind: "event", ...event }));
      const who = "creatureId" in event ? event.creatureId : "world";
      console.log(`${time(event.tick)}  ${who}  ${describe(event)}`);
    }
    for (const c of simulation.snapshot().creatures) {
      let points = trajectories.get(c.id);
      if (!points) trajectories.set(c.id, (points = []));
      points.push({ x: c.position.x, z: c.position.z });
    }
    if (!mapInputs) {
      const { model, registries } = simulation.state;
      const world = registries.worlds.get(preset.worldId) as WorldDefinition | undefined;
      const navigation = simulation.state.pathfinderFor(preset.speciesId)?.navigation;
      if (world && navigation) mapInputs = [world, model, navigation];
    }
  },
});

mkdirSync(outDir, { recursive: true });
writeFileSync(`${base}.ndjson`, lines.map((l) => `${l}\n`).join(""));
if (!values["no-map"] && mapInputs) {
  writeFileSync(`${base}.png`, renderDebugMap(...mapInputs, [...trajectories.values()]));
}

const total = Object.values(report.regionTicks).reduce((a, b) => a + b, 0);
console.log("");
console.log(
  `${preset.worldId}, seed ${seed}: ${ticks} ticks (${time(ticks).trim()}), ${creatures} creature(s) from ${formatClockTime(startMinutes)}, ` +
    `${Math.round(report.elapsedMs)} ms`,
);
console.log(`  decisions: ${report.decisions}`);
console.log(
  `  events: ${Object.entries(report.eventCounts)
    .map(([type, n]) => `${type} ${n}`)
    .join(", ")}`,
);
console.log(`  first structure use: ${report.firstStructureUse ?? "never"}`);
console.log(
  `  time per region: ${Object.entries(report.regionTicks)
    .map(([region, n]) => `${region} ${((100 * n) / total).toFixed(1)}%`)
    .join(", ")}`,
);
console.log(`  invariant violations: ${report.violations.length === 0 ? "none" : ""}`);
for (const v of report.violations) console.log(`    ${v}`);
console.log(`wrote ${base}.ndjson${!values["no-map"] && mapInputs ? ` and ${base}.png` : ""}`);
process.exitCode = report.violations.length > 0 ? 1 : 0;
