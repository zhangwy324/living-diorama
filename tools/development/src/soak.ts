import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { runWithInvariants } from "./simulation-run";

// `pnpm soak [seeds] [ticks]`: the long-run invariant check over many more seeds than
// `pnpm check` runs (ADR 0006 §12). Defaults: 32 seeds × 100k ticks, 3 creatures each.

const seeds = Number(process.argv[2] ?? 32);
const ticks = Number(process.argv[3] ?? 100_000);
let failed = 0;
for (let seed = 1; seed <= seeds; seed++) {
  const report = runWithInvariants({
    register: registerBuiltInContent,
    worldId: "hollow:woodland-hollow",
    speciesId: "hollow:mossling",
    seed,
    ticks,
    creatures: 3,
  });
  const counts = report.eventCounts;
  const problems = [
    ...report.violations,
    ...(counts.creature_stuck ? [`${counts.creature_stuck} creature_stuck events`] : []),
    ...(counts.path_failed ? [`${counts.path_failed} path_failed events`] : []),
    ...(counts.first_use_of_structure === 3 ? [] : ["not every creature crossed the bridge"]),
  ];
  if (problems.length > 0) failed++;
  console.log(
    `seed ${seed}: ${problems.length === 0 ? "ok" : "FAILED"}, ${report.decisions} decisions, ` +
      `first bridge use at tick ${report.firstStructureUse ?? "never"}, ${Math.round(report.elapsedMs)} ms`,
  );
  for (const problem of problems) console.log(`  ${problem}`);
}
console.log(`${seeds - failed}/${seeds} seeds clean`);
process.exitCode = failed > 0 ? 1 : 0;
