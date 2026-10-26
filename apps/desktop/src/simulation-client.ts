import { formatDiagnostic } from "@living-diorama/content-schema";
import {
  envelope,
  openEnvelope,
  type SimulationCommand,
  type SimulationMessage,
  type SimulationSnapshot,
} from "@living-diorama/simulation";
import { SPECIES_ID, WORLD_ID } from "./load-world";

const TICK_RATE_HZ = 10;
/** Default creature count (roadmap §1.9 Q3). */
const CREATURE_COUNT = 3;

export interface SimulationClient {
  /** Turns debug data (routes) in snapshots on or off. */
  setDebug(enabled: boolean): void;
  /** Stops or restarts the simulation clock. */
  setPaused(paused: boolean): void;
  stop(): void;
}

/**
 * Starts the simulation worker with a few creatures and hands every snapshot to `onSnapshot`. The
 * seed changes every launch and is logged so a run can be reproduced.
 */
export function startSimulation(
  onSnapshot: (snapshot: SimulationSnapshot) => void,
): SimulationClient {
  const worker = new Worker(new URL("./simulation.worker.ts", import.meta.url), {
    type: "module",
  });
  const send = (command: SimulationCommand) => worker.postMessage(envelope(command));
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

  worker.onmessage = (event: MessageEvent) => {
    const message = openEnvelope<SimulationMessage>(event.data);
    if (!message) {
      console.error("Simulation worker uses another protocol version");
    } else if (message.type === "ready") {
      console.info(`Simulation ready: ${message.worldId}, seed ${seed}`);
      for (let i = 0; i < CREATURE_COUNT; i++) send({ type: "spawn", speciesId: SPECIES_ID });
    } else if (message.type === "snapshot") {
      onSnapshot(message.snapshot);
    } else if (message.type === "error") {
      console.error(message.diagnostics.map(formatDiagnostic).join("\n"));
    }
  };
  send({ type: "init", worldId: WORLD_ID, seed, tickRateHz: TICK_RATE_HZ });

  return {
    setDebug: (enabled) => send({ type: "set_debug", enabled }),
    setPaused: (paused) => send({ type: paused ? "pause" : "resume" }),
    stop: () => worker.terminate(),
  };
}
