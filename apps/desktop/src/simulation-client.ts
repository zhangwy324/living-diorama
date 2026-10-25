import { formatDiagnostic } from "@living-diorama/content-schema";
import {
  envelope,
  openEnvelope,
  type SimulationCommand,
  type SimulationMessage,
} from "@living-diorama/simulation";
import { SPECIES_ID, WORLD_ID } from "./load-world";

const TICK_RATE_HZ = 10;

/**
 * Starts the simulation worker with one creature. Nothing draws its snapshots yet (M4); the seed
 * changes every launch and is logged so a run can be reproduced. Returns a function that stops it.
 */
export function startSimulation(): () => void {
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
      send({ type: "spawn", speciesId: SPECIES_ID });
    } else if (message.type === "error") {
      console.error(message.diagnostics.map(formatDiagnostic).join("\n"));
    }
  };
  send({ type: "init", worldId: WORLD_ID, seed, tickRateHz: TICK_RATE_HZ });

  return () => worker.terminate();
}
