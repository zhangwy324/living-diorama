import {
  formatDiagnostic,
  parseWorldSave,
  type WorldDefinition,
  type WorldSave,
} from "@living-diorama/content-schema";
import {
  formatClockTime,
  minutesAfter,
  parseClockTime,
  type Navigation,
  type RestoreReport,
  type SimulationEvent,
  type WorldModel,
} from "@living-diorama/simulation";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { carp, otter, registerHollowCreatures, toad } from "./fixtures/hollow-creatures";
import { registerRiverCrossing } from "./fixtures/river-crossing";
import { HUNGRY_FROM, MEAL_EVENT } from "./long-run-checks";
import { saveThroughText } from "./save-cycles";
import { LIVING_BEHAVIOR_CHECKS, runWithInvariants, type RunReport } from "./simulation-run";
import { renderDebugMap } from "./worldgen/debug-map";

// `pnpm sim`: the headless runner (ADR 0006 §12). Runs a world with the M3 invariants checked
// every tick, prints its events, a summary and a line per creature, writes every decision and
// event as NDJSON and draws the trajectories over the debug map. Exits with 1 on any invariant
// violation.
//
// `--save <file>` writes the world as the run leaves it, in the app's save format (ADR 0019), and
// `--load <file>` starts from such a save instead of a fresh world, with `--gap <minutes>` of
// wall-clock time away (default 0, an exact resume), so a gap of 2 minutes or more is caught up
// as in the app. Both run at the app's tick rate only: a save doesn't record the rate, and its
// tick-based timers (cooldowns, the release grace) mean simulated time only at the rate they
// were counted at.
//
// `--species` picks who lives in the world, a comma-separated list of names from its species
// table, `--creatures` of each. Woodland Hollow has `mossling` (the default), `amphibian`,
// `swimmer` and `hopper`, the last three the test species of `fixtures/hollow-creatures.ts`
// (ADR 0020).

/** The app's tick rate, the only one saves are made and loaded at. */
const APP_TICK_RATE_HZ = 10;

const WORLDS = {
  hollow: {
    register: registerHollowCreatures,
    worldId: "hollow:woodland-hollow",
    species: {
      mossling: "hollow:mossling",
      amphibian: otter.id,
      swimmer: carp.id,
      hopper: toad.id,
    } as Record<string, string>,
    ...LIVING_BEHAVIOR_CHECKS,
  },
  river: {
    register: registerRiverCrossing,
    worldId: "fixture:river-crossing",
    species: { pebble: "fixture:pebble" } as Record<string, string>,
    // Short walks in a small world (see LongRunCheckOptions).
    maxDecisionsPer10Seconds: 2,
  },
};

const { values } = parseArgs({
  options: {
    // Default hollow, or with --load the world of the save.
    world: { type: "string" },
    // Unused with --load: the save's seed carries on.
    seed: { type: "string", default: "1" },
    ticks: { type: "string", default: "6000" },
    // Default 1, or none added to a loaded save.
    creatures: { type: "string" },
    hz: { type: "string", default: String(APP_TICK_RATE_HZ) },
    // The time of day the run starts at; it follows simulation time from there (ADR 0018 §5).
    // Unused with --load: the time of day carries on from the save's, moved on by --gap.
    start: { type: "string", default: "12:00" },
    save: { type: "string" },
    load: { type: "string" },
    // Wall-clock minutes between the save and the load.
    gap: { type: "string", default: "0" },
    // Comma-separated names from the world's species table; default its first.
    species: { type: "string" },
    "no-map": { type: "boolean", default: false },
  },
});
const TICK_RATE_HZ = Number(values.hz);
if ((values.save !== undefined || values.load !== undefined) && TICK_RATE_HZ !== APP_TICK_RATE_HZ) {
  throw new Error(
    `--save and --load run at the app's ${APP_TICK_RATE_HZ} Hz only, not --hz ${values.hz}: ` +
      "a save doesn't record its tick rate, and its tick-based timers would count wrongly at another",
  );
}
const loaded = values.load === undefined ? undefined : readSave(values.load);
const worldName =
  values.world ??
  Object.entries(WORLDS).find(([, w]) => w.worldId === loaded?.world.id)?.[0] ??
  "hollow";
const preset = WORLDS[worldName as keyof typeof WORLDS] as (typeof WORLDS)["hollow"] | undefined;
if (!preset) throw new Error(`--world must be one of: ${Object.keys(WORLDS).join(", ")}`);
const speciesIds = (values.species ?? Object.keys(preset.species)[0] ?? "")
  .split(",")
  .map((name) => {
    const id = preset.species[name.trim()];
    if (!id) {
      throw new Error(`--species must be names from: ${Object.keys(preset.species).join(", ")}`);
    }
    return id;
  });
const [speciesId = "", ...others] = speciesIds;
const seed = loaded?.seed ?? Number(values.seed);
const ticks = Number(values.ticks);
const creatures = Number(values.creatures ?? (loaded ? 0 : 1));
const startMinutes = parseClockTime(values.start);
if (startMinutes === undefined) throw new Error(`--start must be a time such as 21:30`);
const gapMs = Math.round(Number(values.gap) * 60_000);
if (!Number.isFinite(gapMs)) throw new Error(`--gap must be a number of minutes`);
const restore = loaded && {
  save: loaded,
  nowMs: loaded.savedAt + gapMs,
  // The save's time of day is that of its last tick; the next is one tick on, then the gap.
  minutes: minutesAfter(loaded.minutes, 1000 / TICK_RATE_HZ + gapMs),
};

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../out");
const base = resolve(outDir, `sim-${worldName}-${seed}`);
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
      return `${e.fromRegionId} → ${e.toRegionId} via ${e.connectionId ?? "the bank"}`;
    case "first_use_of_structure":
      return `first use of ${e.structureId}`;
    case "path_failed":
      return `path failed (${e.reason}) to ${e.to.regionId} (${e.to.x.toFixed(1)}, ${e.to.z.toFixed(1)})`;
    case "creature_stuck":
      return `stuck for ${e.ticksStuck} ticks in ${e.position.regionId}`;
    case "ate":
      return `ate at ${e.placementId}, hunger now ${e.hunger.toFixed(2)}`;
    case "fell_asleep":
      return `fell asleep ${e.placementId === null ? "where it stood" : `at ${e.placementId}`}, tiredness ${e.tiredness.toFixed(2)}`;
    case "woke_up":
      return `woke up (${e.reason}), tiredness ${e.tiredness.toFixed(2)}`;
    case "new_home_selected":
      return `new home ${e.placementId}${e.previous === null ? "" : ` (was ${e.previous})`}`;
    case "day_phase_changed":
      return `${e.from} → ${e.to}`;
  }
}

const report = runWithInvariants({
  ...preset,
  speciesId,
  alsoSpawn: Object.fromEntries(others.map((id) => [id, creatures])),
  seed,
  ticks,
  creatures,
  startMinutes,
  tickRateHz: TICK_RATE_HZ,
  ...(restore ? { restore } : {}),
  onEnd: (simulation) => {
    if (values.save === undefined) return;
    const saved = saveThroughText(simulation, Date.now());
    if (!saved.ok) throw new Error(saved.problem);
    const file = resolve(values.save);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(saved.save));
  },
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
      const navigation = simulation.state.pathfinderFor(speciesId)?.navigation;
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
const from = restore
  ? `resumed from ${values.load} at ${formatClockTime(restore.minutes)}, ${creatures} creature(s) of each species added`
  : `${creatures} creature(s) of each species from ${formatClockTime(startMinutes)}`;
console.log(
  `${preset.worldId}, seed ${seed}: ${ticks} ticks (${time(ticks).trim()}), ${from}, ` +
    `${Math.round(report.elapsedMs)} ms`,
);
if (report.restore) console.log(`  restore: ${describeRestore(report.restore)}`);
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
if (values.save !== undefined) console.log(`saved the world to ${resolve(values.save)}`);
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

/** A save file, read and checked as the app's worker does; throws with the reason otherwise. */
function readSave(file: string): WorldSave {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`--load ${file}: not a readable JSON file (${String(error)})`, {
      cause: error,
    });
  }
  const parsed = parseWorldSave(json);
  if (!parsed.ok) {
    throw new Error(`--load ${file}:\n${parsed.diagnostics.map(formatDiagnostic).join("\n")}`);
  }
  return parsed.value;
}

/** The gap, whether it was caught up, and whatever the restore dropped, pruned or failed at. */
function describeRestore({ gapMs, catchUp, ...dropped }: RestoreReport): string {
  const away = `${(gapMs / 60_000).toFixed(1)} min away`;
  const caught = catchUp.applied
    ? `caught up ${(catchUp.gapMs / 3_600_000).toFixed(2)} h`
    : `no catch-up (${catchUp.skipped})`;
  const lists = Object.entries({ ...dropped, catchUpFailures: catchUp.failures })
    .filter(([, list]) => list.length > 0)
    .map(([name, list]) => `${name} ${JSON.stringify(list)}`);
  return [away, caught, ...lists].join(", ");
}
