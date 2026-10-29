import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { parseArgs } from "node:util";
import { LIVING_BEHAVIOR_CHECKS, runWithInvariants } from "./simulation-run";

// `pnpm soak`: the long-run invariant and living-behavior checks over many more seeds and a
// higher tick rate than `pnpm check` runs (ADR 0006 §12, ADR 0018 §20), with the meal and sleep
// checks on. Defaults: 32 seeds × one simulated day from noon at the app's 10 Hz, 3 creatures each.
// Each run also saves and restores at random ticks drawn from its seed, through JSON text and the
// schema (ADR 0019): a restore without a gap must carry on exactly as the unbroken run, compared
// tick by tick for 10 simulated minutes, and one restore after a long gap per run is checked
// against the catch-up rules (ADR 0018 §19).

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "32" },
    hours: { type: "string", default: "24" },
    hz: { type: "string", default: "10" },
    creatures: { type: "string", default: "3" },
    // Saves and restores per run; one of them after a long gap unless --no-long-gap.
    restores: { type: "string", default: "4" },
    "compare-minutes": { type: "string", default: "10" },
    "no-long-gap": { type: "boolean", default: false },
  },
});
const seeds = Number(values.seeds);
const tickRateHz = Number(values.hz);
const ticks = Math.round(Number(values.hours) * 3600 * tickRateHz);
const creatures = Number(values.creatures);
const saveRestore = {
  cycles: Number(values.restores),
  compareTicks: Math.round(Number(values["compare-minutes"]) * 60 * tickRateHz),
  longGap: !values["no-long-gap"],
};
let failed = 0;
let restores = 0;
let comparedTicks = 0;
let largestSave = 0;
const started = performance.now();
for (let seed = 1; seed <= seeds; seed++) {
  const report = runWithInvariants({
    register: registerBuiltInContent,
    worldId: "hollow:woodland-hollow",
    speciesId: "hollow:mossling",
    seed,
    ticks,
    tickRateHz,
    creatures,
    ...LIVING_BEHAVIOR_CHECKS,
    saveRestore,
  });
  restores += report.saveRestore.restores;
  comparedTicks += report.saveRestore.comparedTicks;
  largestSave = Math.max(largestSave, report.saveRestore.largestSaveBytes);
  const counts = report.eventCounts;
  const problems = [
    ...report.violations,
    ...(counts.creature_stuck ? [`${counts.creature_stuck} creature_stuck events`] : []),
    ...(counts.path_failed ? [`${counts.path_failed} path_failed events`] : []),
    ...(counts.first_use_of_structure === creatures
      ? []
      : ["not every creature crossed the bridge"]),
    ...(report.saveRestore.restores === saveRestore.cycles
      ? []
      : [`${report.saveRestore.restores} of ${saveRestore.cycles} restores done`]),
  ];
  if (problems.length > 0) failed++;
  console.log(
    `seed ${seed}: ${problems.length === 0 ? "ok" : "FAILED"}, ${report.decisions} decisions, ` +
      `first bridge use at tick ${report.firstStructureUse ?? "never"}, ` +
      `${report.saveRestore.restores} restores${describeLongGap(report.saveRestore.longGap)}, ` +
      `${Math.round(report.elapsedMs)} ms`,
  );
  for (const problem of problems) console.log(`  ${problem}`);
}
console.log(
  `${restores} saves restored, ${comparedTicks} ticks compared with unbroken runs, ` +
    `largest save ${(largestSave / 1024).toFixed(0)} KiB of JSON`,
);
console.log(
  `${seeds - failed}/${seeds} seeds clean in ${((performance.now() - started) / 1000).toFixed(0)} s`,
);
process.exitCode = failed > 0 ? 1 : 0;

function describeLongGap(longGap: { gapMs: number; at: string } | undefined): string {
  return longGap
    ? ` (one after ${(longGap.gapMs / 3_600_000).toFixed(1)} h away, back at ${longGap.at})`
    : "";
}
