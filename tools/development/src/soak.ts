import { availableParallelism } from "node:os";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { addEditReports, describeEdits, emptyEditReport } from "./edit-cycles";
import {
  AMPHIBIANS,
  crashedSeed,
  percent,
  runSoakSeed,
  type SeedResult,
  type SoakConfig,
} from "./soak-seed";

// `pnpm soak`: the long-run invariant and living-behavior checks over many more seeds and a
// higher tick rate than `pnpm check` runs (ADR 0006 §12, ADR 0018 §20), with the meal and sleep
// checks on. Defaults: 32 seeds × one simulated day from noon at the app's 10 Hz, 3 mosslings each,
// plus two amphibians, one with no preference between land and water and one that prefers the
// water (#163), and one water-only swimmer (the test species of `fixtures/hollow-creatures.ts`), so
// the per-capability invariants of ADR 0020 run on banks and in the river too. Each amphibian
// species' bank jumps and share of time in water are reported per seed and over all seeds. Each
// run also saves and restores at random ticks drawn from its seed, through JSON text and the
// schema (ADR 0019): a restore without a gap must carry on exactly as the unbroken run, compared
// tick by tick for 10 simulated minutes, and one restore after a long gap per run is checked
// against the catch-up rules (ADR 0018 §19).
//
// Each run also makes `--edits` random prop edits at steps drawn from its seed, some of them undos
// (ADR 0021, `edit-cycles.ts`), with every check held after each; the summary counts them by outcome
// and gives the `applyEdit` times.
//
// Each seed's line also gives the spread of bedtimes and wake times across the creatures the sleep
// check holds to (issue #159), and the summary the narrowest and widest of those spreads. A run is
// one day from noon, so that is about one bedtime and one wake time per creature: a spread across
// creatures, unlike `pnpm sim`'s per creature across nights.
//
// Seeds run `--jobs` at a time, each in a worker thread (`soak-worker.ts`); `--jobs 1` runs them
// one after another on this thread. Either way the seeds' lines come out in seed order, and a seed
// whose run throws or whose worker dies counts as failed.

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
    // Random prop edits per run, about one in five an undo; 0 for none.
    edits: { type: "string", default: "24" },
    // Seeds run at once, by default one per logical core: the fastest measured (docs/development.md).
    jobs: { type: "string", default: String(availableParallelism()) },
  },
});
const seeds = Number(values.seeds);
const tickRateHz = Number(values.hz);
if (!Number.isInteger(seeds) || seeds < 1) throw new Error(`--seeds must be a whole number ≥ 1`);
const jobs = Math.min(seeds, Number(values.jobs));
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs must be a whole number ≥ 1`);
const config: SoakConfig = {
  ticks: Math.round(Number(values.hours) * 3600 * tickRateHz),
  tickRateHz,
  creatures: Number(values.creatures),
  mosslingsOnly: values["mosslings-only"],
  saveRestore: {
    cycles: Number(values.restores),
    compareTicks: Math.round(Number(values["compare-minutes"]) * 60 * tickRateHz),
    longGap: !values["no-long-gap"],
  },
  edits: Number(values.edits),
};
if (!Number.isInteger(config.edits) || config.edits < 0) {
  throw new Error(`--edits must be a whole number ≥ 0`);
}

const started = performance.now();
/** Results by seed, printed as soon as every seed before them is in. */
const results: SeedResult[] = [];
let printed = 0;
const onResult = (result: SeedResult) => {
  results[result.seed - 1] = result;
  for (let next = results[printed]; next; next = results[printed]) {
    for (const line of next.lines) console.log(line);
    printed++;
  }
};
if (jobs === 1) {
  for (let seed = 1; seed <= seeds; seed++) {
    let result: SeedResult;
    try {
      result = runSoakSeed(seed, config);
    } catch (error) {
      result = crashedSeed(seed, error);
    }
    onResult(result);
  }
} else {
  await runInWorkers(onResult);
}

const sum = (of: (r: SeedResult) => number) => results.reduce((n, r) => n + of(r), 0);
const failed = results.filter((r) => r.failed).length;
console.log(
  `${sum((r) => r.restores)} saves restored (${sum((r) => r.editedRestores)} of an edited world), ` +
    `${sum((r) => r.comparedTicks)} ticks compared with unbroken runs, ` +
    `largest save ${(Math.max(0, ...results.map((r) => r.largestSaveBytes)) / 1024).toFixed(0)} KiB of JSON, ` +
    `${sum((r) => r.fullHomes)} sleepers caught up away from a full home`,
);
if (config.edits > 0) {
  console.log(
    describeEdits(results.reduce((sum, r) => addEditReports(sum, r.edits), emptyEditReport())),
  );
}
if (!config.mosslingsOnly) {
  AMPHIBIANS.forEach(({ name }, i) => {
    const per = results.flatMap((r) => r.amphibians[i] ?? []);
    const count = (test: (a: SeedResult["amphibians"][number]) => boolean) =>
      per.filter(test).length;
    const water = per.reduce((n, a) => n + a.water, 0);
    const land = per.reduce((n, a) => n + a.land, 0);
    const shares = per.map((a) => a.share);
    const range = shares.length
      ? ` (${percent(Math.min(...shares))}–${percent(Math.max(...shares))} per seed)`
      : "";
    console.log(
      `${name}: ${per.reduce((n, a) => n + a.jumps, 0)} bank jumps, ` +
        `in ${count((a) => a.jumps > 0)}/${seeds} seeds; ` +
        `on land and in water in ${count((a) => a.water > 0 && a.land > 0)}/${seeds} seeds; ` +
        `${percent(water / Math.max(1, water + land))} of time in water${range}`,
    );
  });
}
console.log(
  `spread across each seed's sleepers: ` +
    `bedtimes ${spreadRange(results.flatMap((r) => r.bedSpread ?? []))}, ` +
    `wake times ${spreadRange(results.flatMap((r) => r.wakeSpread ?? []))}`,
);
console.log(
  `${seeds - failed}/${seeds} seeds clean in ${((performance.now() - started) / 1000).toFixed(0)} s` +
    (jobs > 1 ? ` (${jobs} at a time)` : ""),
);
process.exitCode = failed > 0 ? 1 : 0;

/**
 * Runs every seed in `jobs` worker threads, handing each worker the next seed as it finishes one.
 * A worker that dies fails its seed and is replaced while seeds are left; workers are terminated
 * once there are none, so none outlive the soak.
 */
function runInWorkers(report: (result: SeedResult) => void): Promise<void> {
  return new Promise((resolve) => {
    let nextSeed = 1;
    let done = 0;
    const finish = (result: SeedResult) => {
      report(result);
      if (++done === seeds) resolve();
    };
    const start = () => {
      const worker = new Worker(new URL("./soak-worker.ts", import.meta.url), {
        workerData: config,
      });
      /** The seed the worker is running, if any. */
      let running: number | undefined;
      let retired = false;
      const handOut = () => {
        if (nextSeed > seeds) {
          retired = true;
          void worker.terminate();
          return;
        }
        running = nextSeed++;
        worker.postMessage(running);
      };
      const crashed = (error: unknown) => {
        if (running === undefined) return;
        const seed = running;
        running = undefined;
        finish(crashedSeed(seed, error));
      };
      worker.on("message", (result: SeedResult) => {
        running = undefined;
        handOut();
        finish(result);
      });
      worker.on("error", crashed);
      worker.on("exit", (code) => {
        crashed(`the worker exited with code ${code}`);
        if (!retired && nextSeed <= seeds) start();
      });
      handOut();
    };
    for (let n = 0; n < jobs; n++) start();
  });
}

/** The narrowest and widest of the seeds' spreads, and in how many seeds there was one. */
function spreadRange(spreads: readonly number[]): string {
  if (spreads.length === 0) return "n/a";
  const min = Math.round(Math.min(...spreads));
  const max = Math.round(Math.max(...spreads));
  return `${min}–${max} min apart (in ${spreads.length}/${seeds} seeds)`;
}
