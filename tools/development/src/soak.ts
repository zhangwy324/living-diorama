import { parseArgs } from "node:util";
import { beaver, carp, otter, registerHollowCreatures } from "./fixtures/hollow-creatures";
import { LIVING_BEHAVIOR_CHECKS, runWithInvariants } from "./simulation-run";
import { spread } from "./time-spread";

// `pnpm soak`: the long-run invariant and living-behavior checks over many more seeds and a
// higher tick rate than `pnpm check` runs (ADR 0006 §12, ADR 0018 §20), with the meal and sleep
// checks on. Defaults: 32 seeds × one simulated day from noon at the app's 10 Hz, 3 mosslings each,
// plus two amphibians, one with no preference between land and water and one that prefers the
// water (#163), and one water-only swimmer (the test species of `fixtures/hollow-creatures.ts`), so
// the per-capability invariants of ADR 0020 run on banks and in the river too. Each amphibian
// species' bank jumps and share of time in water are reported per seed and over all seeds. Each run also saves and restores at random ticks drawn from its seed, through
// JSON text and the schema (ADR 0019): a restore without a gap must carry on exactly as the
// unbroken run, compared tick by tick for 10 simulated minutes, and one restore after a long gap
// per run is checked against the catch-up rules (ADR 0018 §19).
//
// Each seed's line also gives the spread of bedtimes and wake times across the creatures the sleep
// check holds to (issue #159), and the summary the narrowest and widest of those spreads. A run is
// one day from noon, so that is about one bedtime and one wake time per creature: a spread across
// creatures, unlike `pnpm sim`'s per creature across nights.

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "32" },
    hours: { type: "string", default: "24" },
    hz: { type: "string", default: "10" },
    // Mosslings per run.
    creatures: { type: "string", default: "3" },
    // Leave out the amphibians and the swimmer.
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
/**
 * The amphibian species reported on, by the name the report gives them, each with its totals over
 * all seeds: bank jumps, the seeds in which it made any, those in which it spent time both on land
 * and in the water (#140), its ticks in water and out of it, and each seed's share of time in
 * water (#163).
 */
const AMPHIBIANS = [
  { name: "amphibian", id: otter.id },
  { name: "water-loving amphibian", id: beaver.id },
].map((species) => ({
  ...species,
  totals: { jumps: 0, seedsWithJumps: 0, seedsInBothMedia: 0, water: 0, land: 0 },
  shares: [] as number[],
}));
const alsoSpawn = values["mosslings-only"] ? {} : { [otter.id]: 1, [beaver.id]: 1, [carp.id]: 1 };
const saveRestore = {
  cycles: Number(values.restores),
  compareTicks: Math.round(Number(values["compare-minutes"]) * 60 * tickRateHz),
  longGap: !values["no-long-gap"],
};
let failed = 0;
let restores = 0;
let comparedTicks = 0;
let largestSave = 0;
/** Per seed with any, how many minutes apart its earliest and latest bedtimes, and wake times. */
const bedSpreads: number[] = [];
const wakeSpreads: number[] = [];
const started = performance.now();
for (let seed = 1; seed <= seeds; seed++) {
  /** Creatures that used a structure, and each creature's jumps across a bank, by ID. */
  const structureUsers = new Set<string>();
  const jumpsBy = new Map<string, number>();
  /** Per amphibian species, ticks in water and out of it, summed over its creatures. */
  const amphibianTicks = new Map(AMPHIBIANS.map(({ id }) => [id, { water: 0, land: 0 }]));
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
        const ticksOf = amphibianTicks.get(c.speciesId);
        if (!ticksOf) continue;
        const kind = model.regions.get(c.position.regionId)?.kind;
        ticksOf[kind === "water" ? "water" : "land"]++;
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
  const swims: string[] = [];
  for (const { name, id: speciesId, totals, shares } of AMPHIBIANS) {
    const ticksOf = amphibianTicks.get(speciesId) ?? { water: 0, land: 0 };
    const jumps = of(speciesId).reduce((n, id) => n + (jumpsBy.get(id) ?? 0), 0);
    totals.jumps += jumps;
    if (jumps > 0) totals.seedsWithJumps++;
    if (ticksOf.water > 0 && ticksOf.land > 0) totals.seedsInBothMedia++;
    totals.water += ticksOf.water;
    totals.land += ticksOf.land;
    const inWater = ticksOf.water / Math.max(1, ticksOf.water + ticksOf.land);
    shares.push(inWater);
    swims.push(`${name} ${jumps} bank jumps, ${percent(inWater)} of time in water`);
  }
  // A restore after a long gap may skip a night's events, so a seed may have no times at all.
  const sleepers = Object.entries(report.creatures).filter(([, c]) => c.sleepChecked);
  const bedtimes = sleepers.flatMap(([, c]) => c.bedtimes);
  const wakeTimes = sleepers.flatMap(([, c]) => c.wakeTimes);
  if (bedtimes.length > 0) bedSpreads.push(Math.max(...bedtimes) - Math.min(...bedtimes));
  if (wakeTimes.length > 0) wakeSpreads.push(Math.max(...wakeTimes) - Math.min(...wakeTimes));
  const swam = values["mosslings-only"] ? "" : `, ${swims.join(", ")}`;
  console.log(
    `seed ${seed}: ${problems.length === 0 ? "ok" : "FAILED"}, ${report.decisions} decisions, ` +
      `first bridge use at tick ${report.firstStructureUse ?? "never"}${swam}, ` +
      `bed ${spread(bedtimes, "n/a")}, woke ${spread(wakeTimes, "n/a")} across ${sleepers.length} ` +
      `sleepers, ${report.saveRestore.restores} restores${describeLongGap(report.saveRestore.longGap)}, ` +
      `${Math.round(report.elapsedMs)} ms`,
  );
  for (const problem of problems) console.log(`  ${problem}`);
}
console.log(
  `${restores} saves restored, ${comparedTicks} ticks compared with unbroken runs, ` +
    `largest save ${(largestSave / 1024).toFixed(0)} KiB of JSON`,
);
if (!values["mosslings-only"]) {
  for (const { name, totals: t, shares } of AMPHIBIANS) {
    console.log(
      `${name}: ${t.jumps} bank jumps, in ${t.seedsWithJumps}/${seeds} seeds; ` +
        `on land and in water in ${t.seedsInBothMedia}/${seeds} seeds; ` +
        `${percent(t.water / Math.max(1, t.water + t.land))} of time in water ` +
        `(${percent(Math.min(...shares))}–${percent(Math.max(...shares))} per seed)`,
    );
  }
}
console.log(
  `spread across each seed's sleepers: bedtimes ${spreadRange(bedSpreads)}, ` +
    `wake times ${spreadRange(wakeSpreads)}`,
);
console.log(
  `${seeds - failed}/${seeds} seeds clean in ${((performance.now() - started) / 1000).toFixed(0)} s`,
);
process.exitCode = failed > 0 ? 1 : 0;

function percent(share: number): string {
  return `${(share * 100).toFixed(0)}%`;
}

function describeLongGap(longGap: { gapMs: number; at: string } | undefined): string {
  return longGap
    ? ` (one after ${(longGap.gapMs / 3_600_000).toFixed(1)} h away, back at ${longGap.at})`
    : "";
}

/** The narrowest and widest of the seeds' spreads, and in how many seeds there was one. */
function spreadRange(spreads: readonly number[]): string {
  if (spreads.length === 0) return "n/a";
  const min = Math.round(Math.min(...spreads));
  const max = Math.round(Math.max(...spreads));
  return `${min}–${max} min apart (in ${spreads.length}/${seeds} seeds)`;
}
