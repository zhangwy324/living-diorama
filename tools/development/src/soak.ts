import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { parseArgs } from "node:util";
import { LIVING_BEHAVIOR_CHECKS, runWithInvariants } from "./simulation-run";

// `pnpm soak`: the long-run invariant and living-behavior checks over many more seeds and a
// higher tick rate than `pnpm check` runs (ADR 0006 §12, ADR 0018 §20), with the meal and sleep
// checks on. Defaults: 32 seeds × one simulated day from noon at the app's 10 Hz, 3 creatures each.

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "32" },
    hours: { type: "string", default: "24" },
    hz: { type: "string", default: "10" },
    creatures: { type: "string", default: "3" },
  },
});
const seeds = Number(values.seeds);
const tickRateHz = Number(values.hz);
const ticks = Math.round(Number(values.hours) * 3600 * tickRateHz);
const creatures = Number(values.creatures);
let failed = 0;
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
  });
  const counts = report.eventCounts;
  const problems = [
    ...report.violations,
    ...(counts.creature_stuck ? [`${counts.creature_stuck} creature_stuck events`] : []),
    ...(counts.path_failed ? [`${counts.path_failed} path_failed events`] : []),
    ...(counts.first_use_of_structure === creatures
      ? []
      : ["not every creature crossed the bridge"]),
  ];
  if (problems.length > 0) failed++;
  console.log(
    `seed ${seed}: ${problems.length === 0 ? "ok" : "FAILED"}, ${report.decisions} decisions, ` +
      `first bridge use at tick ${report.firstStructureUse ?? "never"}, ${Math.round(report.elapsedMs)} ms`,
  );
  for (const problem of problems) console.log(`  ${problem}`);
}
console.log(
  `${seeds - failed}/${seeds} seeds clean in ${((performance.now() - started) / 1000).toFixed(0)} s`,
);
process.exitCode = failed > 0 ? 1 : 0;
