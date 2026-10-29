import { parseArgs } from "node:util";
import { carp, otter, registerHollowCreatures } from "./fixtures/hollow-creatures";
import { LIVING_BEHAVIOR_CHECKS, runWithInvariants } from "./simulation-run";

// `pnpm soak`: the long-run invariant and living-behavior checks over many more seeds and a
// higher tick rate than `pnpm check` runs (ADR 0006 §12, ADR 0018 §20), with the meal and sleep
// checks on. Defaults: 32 seeds × one simulated day from noon at the app's 10 Hz, 3 mosslings each,
// plus one amphibian and one water-only swimmer (the test species of
// `fixtures/hollow-creatures.ts`), so the per-capability invariants of ADR 0020 run on banks and
// in the river too. Each run also saves and restores at random ticks drawn from its seed, through
// JSON text and the schema (ADR 0019): a restore without a gap must carry on exactly as the
// unbroken run, compared tick by tick for 10 simulated minutes, and one restore after a long gap
// per run is checked against the catch-up rules (ADR 0018 §19).

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "32" },
    hours: { type: "string", default: "24" },
    hz: { type: "string", default: "10" },
    // Mosslings per run.
    creatures: { type: "string", default: "3" },
    // Leave out the amphibian and the swimmer.
    "mosslings-only": { type: "boolean", default: false },
    // Saves and restores per run; one of them after a long gap unless --no-long-gap.
    restores: { type: "string", default: "4" },
    "compare-minutes": { type: "string", default: "10" },
    "no-long-gap": { type: "boolean", default: false },
  },
});
const MOSSLING = "hollow:mossling";
const seeds = Number(values.seeds);
const tickRateHz = Number(values.hz);
const ticks = Math.round(Number(values.hours) * 3600 * tickRateHz);
const creatures = Number(values.creatures);
const alsoSpawn = values["mosslings-only"] ? {} : { [otter.id]: 1, [carp.id]: 1 };
const saveRestore = {
  cycles: Number(values.restores),
  compareTicks: Math.round(Number(values["compare-minutes"]) * 60 * tickRateHz),
  longGap: !values["no-long-gap"],
};
let failed = 0;
let restores = 0;
let comparedTicks = 0;
let largestSave = 0;
/**
 * Bank jumps by the amphibians, the seeds in which they made any, and those in which they spent
 * time both on land and in the water (#140).
 */
let bankJumps = 0;
let seedsWithJumps = 0;
let seedsInBothMedia = 0;
const started = performance.now();
for (let seed = 1; seed <= seeds; seed++) {
  /** Creatures that used a structure, and each creature's jumps across a bank, by ID. */
  const structureUsers = new Set<string>();
  const jumpsBy = new Map<string, number>();
  /** Amphibian ticks in water and out of it. */
  const amphibianTicks = { water: 0, land: 0 };
  const report = runWithInvariants({
    register: registerHollowCreatures,
    worldId: "hollow:woodland-hollow",
    speciesId: MOSSLING,
    seed,
    ticks,
    tickRateHz,
    creatures,
    alsoSpawn,
    ...LIVING_BEHAVIOR_CHECKS,
    saveRestore,
    onTick: (simulation, events) => {
      for (const e of events) {
        if (e.type === "first_use_of_structure") structureUsers.add(e.creatureId);
        if (e.type === "entered_region" && e.connectionId === undefined) {
          jumpsBy.set(e.creatureId, (jumpsBy.get(e.creatureId) ?? 0) + 1);
        }
      }
      const { creatures, model } = simulation.state;
      for (const c of creatures.values()) {
        if (c.speciesId !== otter.id) continue;
        const kind = model.regions.get(c.position.regionId)?.kind;
        amphibianTicks[kind === "water" ? "water" : "land"]++;
      }
    },
  });
  restores += report.saveRestore.restores;
  comparedTicks += report.saveRestore.comparedTicks;
  largestSave = Math.max(largestSave, report.saveRestore.largestSaveBytes);
  const counts = report.eventCounts;
  const of = (speciesId: string) =>
    Object.entries(report.creatures).flatMap(([id, c]) => (c.speciesId === speciesId ? [id] : []));
  // Every mossling finds the bridge; the amphibian may cross by the banks instead.
  const mosslings = of(MOSSLING);
  const problems = [
    ...report.violations,
    ...(counts.creature_stuck ? [`${counts.creature_stuck} creature_stuck events`] : []),
    ...(counts.path_failed ? [`${counts.path_failed} path_failed events`] : []),
    ...(mosslings.every((id) => structureUsers.has(id))
      ? []
      : ["not every mossling crossed the bridge"]),
    ...(report.saveRestore.restores === saveRestore.cycles
      ? []
      : [`${report.saveRestore.restores} of ${saveRestore.cycles} restores done`]),
  ];
  if (problems.length > 0) failed++;
  const jumps = of(otter.id).reduce((n, id) => n + (jumpsBy.get(id) ?? 0), 0);
  bankJumps += jumps;
  if (jumps > 0) seedsWithJumps++;
  if (amphibianTicks.water > 0 && amphibianTicks.land > 0) seedsInBothMedia++;
  const inWater = amphibianTicks.water / Math.max(1, amphibianTicks.water + amphibianTicks.land);
  const swam = values["mosslings-only"]
    ? ""
    : `, ${jumps} amphibian bank jumps, ${(inWater * 100).toFixed(0)}% of its time in water`;
  console.log(
    `seed ${seed}: ${problems.length === 0 ? "ok" : "FAILED"}, ${report.decisions} decisions, ` +
      `first bridge use at tick ${report.firstStructureUse ?? "never"}${swam}, ` +
      `${report.saveRestore.restores} restores${describeLongGap(report.saveRestore.longGap)}, ` +
      `${Math.round(report.elapsedMs)} ms`,
  );
  for (const problem of problems) console.log(`  ${problem}`);
}
console.log(
  `${restores} saves restored, ${comparedTicks} ticks compared with unbroken runs, ` +
    `largest save ${(largestSave / 1024).toFixed(0)} KiB of JSON`,
);
if (!values["mosslings-only"]) {
  console.log(
    `${bankJumps} amphibian bank jumps, in ${seedsWithJumps}/${seeds} seeds; ` +
      `on land and in water in ${seedsInBothMedia}/${seeds} seeds`,
  );
}
console.log(
  `${seeds - failed}/${seeds} seeds clean in ${((performance.now() - started) / 1000).toFixed(0)} s`,
);
process.exitCode = failed > 0 ? 1 : 0;

function describeLongGap(longGap: { gapMs: number; at: string } | undefined): string {
  return longGap
    ? ` (one after ${(longGap.gapMs / 3_600_000).toFixed(1)} h away, back at ${longGap.at})`
    : "";
}
