import { formatDiagnostic } from "@living-diorama/content-schema";
import {
  envelope,
  openEnvelope,
  type SimulationCommand,
  type SimulationEvent,
  type SimulationMessage,
  type SimulationSnapshot,
  type WorldContent,
} from "@living-diorama/simulation";
import { STARTUP, type StartupConfig } from "./startup";

/**
 * Development builds may override every starting count with `VITE_CREATURE_COUNT` to check the
 * app with many creatures (ADR 0009 §4).
 */
const COUNT_OVERRIDE = (import.meta.env.DEV && Number(import.meta.env.VITE_CREATURE_COUNT)) || 0;

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
  /** The worker loaded and checked the world; the starting creatures are spawned right after. */
  onReady(content: WorldContent): void;
  onSnapshot(snapshot: SimulationSnapshot, events: SimulationEvent[]): void;
  /**
   * The world failed to load, or the worker rejected a command, crashed or speaks another
   * protocol version. The app only sends valid commands, so every one of these is fatal (ADR 0009
   * §2).
   */
  onFailure(summary: string, details: string[]): void;
}

/**
 * Starts the simulation worker on the startup world, spawns its starting creatures and hands every
 * snapshot and its events to `onSnapshot`. The seed changes every launch and is logged so a run
 * can be reproduced.
 */
export function startSimulation(
  { onReady, onSnapshot, onFailure }: SimulationCallbacks,
  config: StartupConfig = STARTUP,
): SimulationClient {
  const worker = new Worker(new URL("./simulation.worker.ts", import.meta.url), {
    type: "module",
  });
  let ready = false;
  let stopped = false;
  const send = (command: SimulationCommand) => {
    if (!stopped) worker.postMessage(envelope(command));
  };
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

  worker.onmessage = (event: MessageEvent) => {
    const message = openEnvelope<SimulationMessage>(event.data);
    if (!message) {
      onFailure("The simulation stopped", ["The simulation worker uses another protocol version"]);
    } else if (message.type === "ready") {
      console.info(`Simulation ready: ${message.worldId}, seed ${seed}`);
      ready = true;
      onReady(message);
      for (const { speciesId, count } of config.creatures) {
        for (let i = 0; i < (COUNT_OVERRIDE || count); i++) send({ type: "spawn", speciesId });
      }
    } else if (message.type === "snapshot") {
      onSnapshot(message.snapshot, message.events);
    } else if (message.type === "error") {
      // Until `ready`, the only command in flight is `init`, so an error means the world failed.
      const summary = ready ? "The simulation stopped" : "The world failed to load";
      onFailure(summary, message.diagnostics.map(formatDiagnostic));
    }
  };
  // A worker that fails to load or throws reports an ErrorEvent; one whose message can't be
  // deserialized reports messageerror.
  worker.onerror = (event: ErrorEvent) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno})` : "";
    onFailure("The simulation stopped", [
      `The simulation worker failed: ${event.message || "unknown error"}${where}`,
    ]);
  };
  worker.onmessageerror = () =>
    onFailure("The simulation stopped", ["A simulation message could not be read"]);
  send({ type: "init", worldId: config.worldId, seed, tickRateHz: config.tickRateHz });

  return {
    setDebug: (enabled) => send({ type: "set_debug", enabled }),
    setPaused: (paused) => send({ type: paused ? "pause" : "resume" }),
    shutdown: () => send({ type: "shutdown" }),
    stop: () => {
      stopped = true;
      worker.terminate();
    },
  };
}
