import { parentPort, workerData } from "node:worker_threads";
import { runSoakSeed, type SoakConfig } from "./soak-seed";

// A worker thread of `pnpm soak --jobs N` (`soak.ts`): runs each seed it is sent and posts back its
// result. A seed that throws is left uncaught, so the soak sees the worker fail and counts that seed
// as failed, as it does a worker that dies any other way.

const config = workerData as SoakConfig;
parentPort?.on("message", (seed: number) => {
  parentPort?.postMessage(runSoakSeed(seed, config));
});
