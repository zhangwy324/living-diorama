import { formatDiagnostic, type Result } from "@living-diorama/content-schema";
import {
  envelope,
  openEnvelope,
  type AssetSummary,
  type RequestCommand,
  type SimulationCommand,
  type SimulationEvent,
  type SimulationMessage,
  type SimulationSnapshot,
  type SpeciesSummary,
  type WorldContent,
} from "@living-diorama/simulation";
import { STARTUP, type StartupConfig } from "./startup";

/**
 * Development builds may override every starting count with `VITE_CREATURE_COUNT` to check the
 * app with many creatures (ADR 0009 §4).
 */
const COUNT_OVERRIDE = (import.meta.env.DEV && Number(import.meta.env.VITE_CREATURE_COUNT)) || 0;

export interface SimulationClient {
  /**
   * Adds a species while the world runs (ADR 0012). Resolves with its ID once the worker has
   * registered it and `onSpeciesRegistered` has run, or with the diagnostics if it was rejected.
   */
  registerSpecies(species: unknown, appearanceUrl: string): Promise<Result<string>>;
  /** Adds a creature at a random spawn point. Resolves with its ID, or why it couldn't be added. */
  spawn(speciesId: string): Promise<Result<string>>;
  /** Takes a creature out of the world. */
  despawn(creatureId: string): Promise<Result<string>>;
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
  /** A species was registered while the world runs; the renderer may now meet its creatures. */
  onSpeciesRegistered?(speciesId: string, species: SpeciesSummary, asset: AssetSummary): void;
  onSnapshot(snapshot: SimulationSnapshot, events: SimulationEvent[]): void;
  /**
   * The world failed to load, or the worker reported an error, crashed or speaks another protocol
   * version. The app only sends valid commands, so every one of these is fatal (ADR 0009 §2). A
   * rejected request is not a failure: it resolves its promise instead (ADR 0012).
   */
  onFailure(summary: string, details: string[]): void;
}

/** The part of a `Worker` the client uses; injectable for tests. */
export type WorkerLike = Pick<Worker, "postMessage" | "terminate"> & {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
};

const createWorker = (): WorkerLike =>
  new Worker(new URL("./simulation.worker.ts", import.meta.url), { type: "module" });

/** Most creatures the world holds: the startup cap, raised by the development count override. */
export function creatureCap(config: StartupConfig, countOverride = COUNT_OVERRIDE): number {
  const starting = config.creatures.reduce((sum, c) => sum + (countOverride || c.count), 0);
  return Math.max(config.maxCreatures, starting);
}

type Pending = (result: Result<string>) => void;

/**
 * Starts the simulation worker on the startup world, spawns its starting creatures and hands every
 * snapshot and its events to `onSnapshot`. The seed changes every launch and is logged so a run
 * can be reproduced.
 */
export function startSimulation(
  { onReady, onSpeciesRegistered, onSnapshot, onFailure }: SimulationCallbacks,
  config: StartupConfig = STARTUP,
  worker: WorkerLike = createWorker(),
): SimulationClient {
  let ready = false;
  let stopped = false;
  let nextRequest = 1;
  const pending = new Map<string, Pending>();
  const send = (command: SimulationCommand) => {
    if (!stopped) worker.postMessage(envelope(command));
  };
  /** Sends a request; it stays unanswered if the worker stops first. */
  const request = (command: RequestCommand) =>
    new Promise<Result<string>>((resolve) => {
      const requestId = String(nextRequest++);
      pending.set(requestId, resolve);
      send({ ...command, requestId });
    });
  const answer = (requestId: string | undefined, result: Result<string>) => {
    if (requestId === undefined) return;
    pending.get(requestId)?.(result);
    pending.delete(requestId);
  };
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

  const spawnStartingCreatures = () => {
    for (const { speciesId, count } of config.creatures) {
      for (let i = 0; i < (COUNT_OVERRIDE || count); i++) {
        void request({ type: "spawn", speciesId }).then((result) => {
          if (!result.ok) {
            console.warn(
              [
                `Could not add a starting ${speciesId}`,
                ...result.diagnostics.map(formatDiagnostic),
              ].join("\n  "),
            );
          }
        });
      }
    }
  };

  worker.onmessage = (event: MessageEvent) => {
    const message = openEnvelope<SimulationMessage>(event.data);
    if (!message) {
      onFailure("The simulation stopped", ["The simulation worker uses another protocol version"]);
      return;
    }
    switch (message.type) {
      case "ready":
        console.info(`Simulation ready: ${message.worldId}, seed ${seed}`);
        ready = true;
        onReady(message);
        spawnStartingCreatures();
        break;
      case "snapshot":
        onSnapshot(message.snapshot, message.events);
        break;
      case "species_registered":
        onSpeciesRegistered?.(message.speciesId, message.species, message.asset);
        answer(message.requestId, { ok: true, value: message.speciesId });
        break;
      case "spawned":
      case "despawned":
        answer(message.requestId, { ok: true, value: message.creatureId });
        break;
      case "rejected":
        answer(message.requestId, { ok: false, diagnostics: message.diagnostics });
        break;
      case "error": {
        // Until `ready`, the only command in flight is `init`, so an error means the world failed.
        const summary = ready ? "The simulation stopped" : "The world failed to load";
        onFailure(summary, message.diagnostics.map(formatDiagnostic));
        break;
      }
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
  send({
    type: "init",
    worldId: config.worldId,
    seed,
    tickRateHz: config.tickRateHz,
    maxCreatures: creatureCap(config),
  });

  return {
    registerSpecies: (species, appearanceUrl) =>
      request({ type: "register_species", species, appearanceUrl }),
    spawn: (speciesId) => request({ type: "spawn", speciesId }),
    despawn: (creatureId) => request({ type: "despawn", creatureId }),
    setDebug: (enabled) => send({ type: "set_debug", enabled }),
    setPaused: (paused) => send({ type: paused ? "pause" : "resume" }),
    shutdown: () => send({ type: "shutdown" }),
    stop: () => {
      stopped = true;
      pending.clear();
      worker.terminate();
    },
  };
}
