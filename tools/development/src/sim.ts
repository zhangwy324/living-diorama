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
import { HUNGRY_FROM, MEAL_EVENT } from "./long-run-checks";
import { runWithInvariants, type RunReport } from "./simulation-run";
import { renderDebugMap } from "./worldgen/debug-map";

// `pnpm sim`: the headless runner (ADR 0006 §12). Runs a world with the M3 invariants checked
// every tick, prints its events, a summary and a line per creature, writes every decision and
// event as NDJSON and draws the trajectories over the debug map. Exits with 1 on any invariant
// violation.

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
    // Short walks in a small world (see LongRunCheckOptions).
    maxDecisionsPer10Seconds: 2,
  },
};

const { values } = parseArgs({
  options: {
    world: { type: "string", default: "hollow" },
    seed: { type: "string", default: "1" },
    ticks: { type: "string", default: "6000" },
    creatures: { type: "string", default: "1" },
    hz: { type: "string", default: "10" },
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
const TICK_RATE_HZ = Number(values.hz);

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
    case "ate":
      return `ate at ${e.placementId}, hunger now ${e.hunger.toFixed(2)}`;
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
  tickRateHz: TICK_RATE_HZ,
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
console.log("  per creature:");
for (const line of describeCreatures(report)) console.log(`    ${line}`);
console.log(`  invariant violations: ${report.violations.length === 0 ? "none" : ""}`);
for (const v of report.violations) console.log(`    ${v}`);
console.log(`wrote ${base}.ndjson${!values["no-map"] && mapInputs ? ` and ${base}.png` : ""}`);
process.exitCode = report.violations.length > 0 ? 1 : 0;

/** Per creature: meals, sleep, time hungry, and decisions and interruptions (ADR 0018 §20). */
function describeCreatures({ creatures, tickRateHz }: RunReport): string[] {
  const hours = (ticks: number) => `${(ticks / tickRateHz / 3600).toFixed(1)} h`;
  return Object.entries(creatures).map(([id, c]) => {
    const night =
      c.nightTicks > 0
        ? ` (${((100 * c.asleepAtNightTicks) / c.nightTicks).toFixed(0)}% of the night)`
        : "";
    const per10s = (10 * tickRateHz * c.decisions) / Math.max(1, c.ticks);
    return (
      `${id}: ${c.meals} meals (${MEAL_EVENT}), asleep ${hours(c.asleepTicks)}${night}, ` +
      `hungry ${hours(c.hungryTicks)} (cue or hunger ≥ ${HUNGRY_FROM}), ` +
      `${c.decisions} decisions (${per10s.toFixed(2)} per 10 s), ` +
      `${c.interruptions} interruptions (at most ${c.peakInterruptionsPerMinute} in a minute)`
    );
  });
}
