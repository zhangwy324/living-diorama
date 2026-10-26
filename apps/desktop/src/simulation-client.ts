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
/**
 * Creature count (roadmap §1.9 Q3). Development builds may override it with `VITE_CREATURE_COUNT`
 * to check the app with many creatures (ADR 0009 §4).
 */
const CREATURE_COUNT = (import.meta.env.DEV && Number(import.meta.env.VITE_CREATURE_COUNT)) || 3;

export interface SimulationClient {
  /** Turns debug data (routes) in snapshots on or off. */
  setDebug(enabled: boolean): void;
  /** Stops or restarts the simulation clock. */
  setPaused(paused: boolean): void;
  /** Asks the worker to stop its clock and close itself. */
  shutdown(): void;
  /** Ends the worker at once. */
  stop(): void;
}

export interface SimulationCallbacks {
  onSnapshot(snapshot: SimulationSnapshot): void;
  /**
   * The worker rejected a command, crashed or speaks another protocol version. The app only sends
   * valid commands, so every one of these is a bug and fatal (ADR 0009 §2).
   */
  onFailure(details: string[]): void;
}

/**
 * Starts the simulation worker with a few creatures and hands every snapshot to `onSnapshot`. The
 * seed changes every launch and is logged so a run can be reproduced.
 */
export function startSimulation({ onSnapshot, onFailure }: SimulationCallbacks): SimulationClient {
  const worker = new Worker(new URL("./simulation.worker.ts", import.meta.url), {
    type: "module",
  });
  const send = (command: SimulationCommand) => worker.postMessage(envelope(command));
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

  worker.onmessage = (event: MessageEvent) => {
    const message = openEnvelope<SimulationMessage>(event.data);
    if (!message) {
      onFailure(["The simulation worker uses another protocol version"]);
    } else if (message.type === "ready") {
      console.info(`Simulation ready: ${message.worldId}, seed ${seed}`);
      for (let i = 0; i < CREATURE_COUNT; i++) send({ type: "spawn", speciesId: SPECIES_ID });
    } else if (message.type === "snapshot") {
      onSnapshot(message.snapshot);
    } else if (message.type === "error") {
      onFailure(message.diagnostics.map(formatDiagnostic));
    }
  };
  // A worker that fails to load or throws reports an ErrorEvent; one whose message can't be
  // deserialized reports messageerror.
  worker.onerror = (event: ErrorEvent) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno})` : "";
    onFailure([`The simulation worker failed: ${event.message || "unknown error"}${where}`]);
  };
  worker.onmessageerror = () => onFailure(["A simulation message could not be read"]);
  send({ type: "init", worldId: WORLD_ID, seed, tickRateHz: TICK_RATE_HZ });

  return {
    setDebug: (enabled) => send({ type: "set_debug", enabled }),
    setPaused: (paused) => send({ type: paused ? "pause" : "resume" }),
    shutdown: () => send({ type: "shutdown" }),
    stop: () => worker.terminate(),
  };
}
