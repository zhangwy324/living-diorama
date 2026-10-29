import { formatDiagnostic, type Result, type SizeClass } from "@living-diorama/content-schema";
import {
  envelope,
  openEnvelope,
  type AssetSummary,
  type Limit,
  type RequestCommand,
  type RestoreReport,
  type SimulationCommand,
  type SimulationEvent,
  type SimulationMessage,
  type SimulationSnapshot,
  type SpeciesSummary,
  type WorldContent,
} from "@living-diorama/simulation";
import { STARTUP, type StartupConfig } from "./startup";
import { systemWallClock, timeOfDayFeed, type WallClock } from "./time-of-day";

/**
 * The starting count `VITE_CREATURE_COUNT` gives every startup entry, or `undefined` when it is
 * unset or empty. Any build honours it when it is set at build time, so a release build can be
 * measured with many creatures or none (ADR 0016 §10); the release workflow checks it is unset.
 */
export function parseCountOverride(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const count = Number(raw);
  if (Number.isInteger(count) && count >= 0) return count;
  console.warn(`Ignoring VITE_CREATURE_COUNT=${raw}: not a whole number from 0`);
  return undefined;
}

/** The creature-count override this build was made with, if any. */
export const COUNT_OVERRIDE = parseCountOverride(import.meta.env.VITE_CREATURE_COUNT);

/** A species the worker registered, and where its creatures don't fit in this world (ADR 0013). */
export interface RegisteredSpecies {
  speciesId: string;
  limits: Limit[];
}

export interface SimulationClient {
  /**
   * Adds a species while the world runs (ADR 0012). Resolves once the worker has registered it
   * and `onSpeciesRegistered` has run, or with the diagnostics if it was rejected.
   */
  registerSpecies(species: unknown, appearanceUrl: string): Promise<Result<RegisteredSpecies>>;
  /**
   * Where creatures of this size and these capabilities wouldn't fit, without registering anything
   * (ADR 0015 §8). Errors among the limits mean such a species can't be added; the result fails
   * only for a size class or capability that doesn't exist.
   */
  checkLimits(sizeClass: SizeClass, capabilities: Record<string, number>): Promise<Result<Limit[]>>;
  /**
   * Adds a creature at a random spawn point. Resolves with its ID, or why it couldn't be added.
   * `released`: it comes from the Studio, so it gets the release grace (ADR 0018 amendments, §13).
   */
  spawn(speciesId: string, options?: { released?: boolean }): Promise<Result<string>>;
  /** Takes a creature out of the world. */
  despawn(creatureId: string): Promise<Result<string>>;
  /**
   * Adds the startup world's starting creatures (the count override's number of each, if set) and
   * resolves once the worker has answered every spawn. A creature that can't be added is logged.
   * For a world with no usable save (ADR 0019 §3).
   */
  spawnStartingCreatures(): Promise<void>;
  /**
   * Saves the world (ADR 0019), stamped with the wall-clock time now. Resolves with the save as
   * JSON text, ready to store, once every command sent before it has been applied.
   */
  save(): Promise<Result<string>>;
  /**
   * Replaces the world with the save in `json`, at the wall-clock time and time of day now
   * (ADR 0019 §3, §7). Resolves with what the restore left out and caught up, or with why the
   * save was rejected, in which case the world is as it was. `onRestored` runs first.
   */
  restore(json: string): Promise<Result<RestoreReport>>;
  /** Turns debug data (routes, needs, knowledge and home) in snapshots on or off. */
  setDebug(enabled: boolean): void;
  /** Stops or restarts the simulation clock. */
  setPaused(paused: boolean): void;
  /** Scales how fast simulation time passes; must be a positive number. */
  setSpeed(multiplier: number): void;
  /**
   * Fixes the time of day at `minutes` since midnight, or follows the local clock again when
   * undefined (ADR 0018 §5). For development: the player's world always follows the clock.
   */
  fixTimeOfDay(minutes: number | undefined): void;
  /** Asks the worker to stop its clock and close itself. */
  shutdown(): void;
  /** Ends the worker at once. */
  stop(): void;
}

export interface SimulationCallbacks {
  /**
   * The worker loaded and checked the world, which is still empty: the caller restores a save or
   * spawns the starting creatures next (ADR 0019 §3).
   */
  onReady(content: WorldContent): void;
  /**
   * The world was replaced by a save. The next snapshot shows it, and its tick may be older than
   * the last one or far ahead of it. Runs before that snapshot and before `restore` resolves.
   */
  onRestored?(report: RestoreReport): void;
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

/** Most creatures the world holds: the startup cap, raised by a larger count override. */
export function creatureCap(config: StartupConfig, countOverride = COUNT_OVERRIDE): number {
  const starting = config.creatures.reduce((sum, c) => sum + (countOverride ?? c.count), 0);
  return Math.max(config.maxCreatures, starting);
}

type Pending = (result: Result<unknown>) => void;

/**
 * Starts the simulation worker on the startup world, still empty, and hands every snapshot and its
 * events to `onSnapshot`. The seed changes every launch and is logged so a run can be reproduced;
 * a restored save brings its own (ADR 0019 §8). The worker gets the local time of day at init,
 * whenever the minute changes and on resume (ADR 0018 §5).
 */
export function startSimulation(
  { onReady, onSpeciesRegistered, onRestored, onSnapshot, onFailure }: SimulationCallbacks,
  config: StartupConfig = STARTUP,
  worker: WorkerLike = createWorker(),
  countOverride = COUNT_OVERRIDE,
  clock: WallClock = systemWallClock,
): SimulationClient {
  let ready = false;
  let stopped = false;
  let nextRequest = 1;
  const pending = new Map<string, Pending>();
  const send = (command: SimulationCommand) => {
    if (!stopped) worker.postMessage(envelope(command));
  };
  /** Sends a request; it stays unanswered if the worker stops first. */
  const request = <T>(command: RequestCommand) =>
    new Promise<Result<T>>((resolve) => {
      const requestId = String(nextRequest++);
      pending.set(requestId, resolve as Pending);
      send({ ...command, requestId });
    });
  const answer = (requestId: string | undefined, result: Result<unknown>) => {
    if (requestId === undefined) return;
    pending.get(requestId)?.(result);
    pending.delete(requestId);
  };
  const timeOfDay = timeOfDayFeed((minutes) => send({ type: "set_time_of_day", minutes }), clock);
  const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

  const spawnStartingCreatures = async () => {
    const spawning = config.creatures.flatMap(({ speciesId, count }) =>
      Array.from({ length: countOverride ?? count }, () =>
        request<string>({ type: "spawn", speciesId }).then((result) => {
          if (!result.ok) {
            console.warn(
              [
                `Could not add a starting ${speciesId}`,
                ...result.diagnostics.map(formatDiagnostic),
              ].join("\n  "),
            );
          }
        }),
      ),
    );
    await Promise.all(spawning);
  };

  worker.onmessage = (event: MessageEvent) => {
    // A message already queued when the client stopped must not start anything again.
    if (stopped) return;
    const message = openEnvelope<SimulationMessage>(event.data);
    if (!message) {
      onFailure("The simulation stopped", ["The simulation worker uses another protocol version"]);
      return;
    }
    switch (message.type) {
      case "ready":
        console.info(`Simulation ready: ${message.worldId}, seed ${seed}`);
        if (countOverride !== undefined)
          console.info(`Starting count overridden: ${countOverride}`);
        ready = true;
        timeOfDay.start();
        onReady(message);
        break;
      case "snapshot":
        onSnapshot(message.snapshot, message.events);
        break;
      case "species_registered":
        onSpeciesRegistered?.(message.speciesId, message.species, message.asset);
        answer(message.requestId, {
          ok: true,
          value: { speciesId: message.speciesId, limits: message.limits },
        });
        break;
      case "limits":
        answer(message.requestId, { ok: true, value: message.limits });
        break;
      case "spawned":
      case "despawned":
        answer(message.requestId, { ok: true, value: message.creatureId });
        break;
      case "saved":
        answer(message.requestId, { ok: true, value: message.json });
        break;
      case "restored":
        onRestored?.(message.report);
        answer(message.requestId, { ok: true, value: message.report });
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
      default: {
        // An answer this client doesn't read would leave its request waiting forever.
        const unread: never = message;
        onFailure("The simulation stopped", [
          `Unexpected simulation message: ${(unread as { type: string }).type}`,
        ]);
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
    maxCreatures: creatureCap(config, countOverride),
    minutes: timeOfDay.minutes,
  });

  return {
    registerSpecies: (species, appearanceUrl) =>
      request({ type: "register_species", species, appearanceUrl }),
    checkLimits: (sizeClass, capabilities) =>
      request({ type: "check_limits", sizeClass, capabilities }),
    spawn: (speciesId, { released = false } = {}) =>
      request({ type: "spawn", speciesId, ...(released ? { released } : {}) }),
    despawn: (creatureId) => request({ type: "despawn", creatureId }),
    spawnStartingCreatures,
    save: () => request({ type: "save", savedAt: clock.now() }),
    restore: (json) =>
      request({ type: "restore", json, nowMs: clock.now(), minutes: timeOfDay.minutes }),
    setDebug: (enabled) => send({ type: "set_debug", enabled }),
    setPaused: (paused) => {
      // Before resuming, so the snapshot sent on resume already shows the time of day.
      if (!paused) timeOfDay.resync();
      send({ type: paused ? "pause" : "resume" });
    },
    setSpeed: (multiplier) => send({ type: "set_speed", multiplier }),
    fixTimeOfDay: (minutes) => timeOfDay.fix(minutes),
    shutdown: () => send({ type: "shutdown" }),
    stop: () => {
      stopped = true;
      timeOfDay.stop();
      pending.clear();
      worker.terminate();
    },
  };
}
