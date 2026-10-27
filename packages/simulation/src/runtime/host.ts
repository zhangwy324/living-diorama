import {
  error,
  type Diagnostic,
  type Result,
  type SpeciesDefinition,
} from "@living-diorama/content-schema";
import type { AssetEntry, Registries } from "@living-diorama/extension-api";
import { describeNavigation } from "../navigation/overlay";
import {
  envelope,
  openEnvelope,
  type AssetSummary,
  type RequestCommand,
  type SimulationCommand,
  type SimulationMessage,
  type SpeciesSummary,
  type WorldContent,
} from "../protocol";
import { describeScene } from "../world/scene";
import { FixedClock } from "./clock";
import { Simulation } from "./simulation";

// Runs a simulation behind the worker protocol (ADR 0006 §11). Everything host-specific is
// injected, so the same code runs in a Web Worker and in Node tests.

/** The part of a worker's message port the host needs. */
export interface HostPort {
  postMessage(data: unknown): void;
  onMessage(handler: (data: unknown) => void): void;
}

export interface HostOptions {
  /** Registries with the engine and every content pack registered and references resolved. */
  loadContent(): Result<Registries>;
  /** Monotonic wall-clock time in milliseconds, e.g. `performance.now`. */
  now(): number;
  /** Calls `callback` once after about `delayMs`, e.g. `setTimeout`. */
  schedule(callback: () => void, delayMs: number): void;
  /** Ends the host's process on `shutdown`, e.g. a worker's `close`. */
  close?(): void;
}

type QueuedCommand = Exclude<SimulationCommand, { type: "init" }>;

const summarizeAsset = ({ kind, url, scale }: AssetEntry): AssetSummary => ({
  kind,
  url,
  ...(scale === undefined ? {} : { scale }),
});

const summarizeSpecies = ({ appearance, sizeClass }: SpeciesDefinition): SpeciesSummary => ({
  appearance,
  sizeClass,
});

/** The world as the main thread draws it, as plain data so it survives `postMessage`. */
export function describeContent({ state }: Simulation): WorldContent {
  const { model, registries } = state;
  return {
    scene: describeScene(model),
    navigations: state.navigations.map((navigation) => describeNavigation(model, navigation)),
    assets: Object.fromEntries(registries.assets.values().map((a) => [a.id, summarizeAsset(a)])),
    species: Object.fromEntries(
      registries.species.values().map((s) => [s.id, summarizeSpecies(s)]),
    ),
  };
}

/**
 * Starts listening on `port`. `init` loads content and starts the tick loop; every other command
 * is queued and applied before the next tick. Each tick sends a snapshot with its events. A
 * request command answers with its reply or `rejected`; any other command that can't be applied
 * sends `error`. Only a failed `init` leaves the host idle.
 */
export function runSimulationHost(port: HostPort, options: HostOptions): void {
  let simulation: Simulation | undefined;
  let clock: FixedClock | undefined;
  let stopped = false;
  let debug = false;
  const queue: QueuedCommand[] = [];

  const send = (message: SimulationMessage) => port.postMessage(envelope(message));
  const reject = (diagnostics: Diagnostic[]) => send({ type: "error", diagnostics });
  const sendSnapshot = (sim: Simulation, paused: boolean) =>
    send({ type: "snapshot", snapshot: sim.snapshot({ paused, routes: debug }), events: [] });

  const init = (command: Extract<SimulationCommand, { type: "init" }>) => {
    if (simulation) {
      reject([error("already_initialized", "The simulation is already initialized")]);
      return;
    }
    const { tickRateHz, maxCreatures } = command;
    if (!(Number.isFinite(tickRateHz) && tickRateHz > 0)) {
      reject([error("invalid_tick_rate", `Tick rate must be positive, got ${tickRateHz}`)]);
      return;
    }
    if (!(Number.isInteger(maxCreatures) && maxCreatures > 0)) {
      reject([
        error(
          "invalid_max_creatures",
          `The creature cap must be a positive whole number, got ${String(maxCreatures)}`,
        ),
      ]);
      return;
    }
    const content = options.loadContent();
    if (!content.ok) {
      reject(content.diagnostics);
      return;
    }
    const created = Simulation.create(content.value, {
      worldId: command.worldId,
      seed: command.seed,
      tickRateHz,
      maxCreatures,
    });
    if (!created.ok) {
      reject(created.diagnostics);
      return;
    }
    simulation = created.value;
    clock = new FixedClock({ tickRateHz });
    clock.advance(options.now());
    send({ type: "ready", worldId: command.worldId, ...describeContent(simulation) });
    options.schedule(loop, clock.tickMs);
  };

  const apply = (sim: Simulation, ticks: FixedClock, command: QueuedCommand) => {
    switch (command.type) {
      case "pause":
        ticks.pause();
        sendSnapshot(sim, true);
        break;
      case "resume":
        ticks.resume();
        sendSnapshot(sim, false);
        break;
      case "set_speed":
        if (Number.isFinite(command.multiplier) && command.multiplier > 0) {
          ticks.setSpeed(command.multiplier);
        } else {
          reject([
            error("invalid_speed", `Speed must be positive, got ${String(command.multiplier)}`),
          ]);
        }
        break;
      case "set_debug":
        debug = command.enabled === true;
        break;
      case "register_species":
      case "spawn":
      case "despawn":
        request(sim, command);
        break;
      case "shutdown":
        stopped = true;
        options.close?.();
        break;
      default: {
        const { type } = command as { type: unknown };
        reject([error("unknown_command", `Unknown command "${String(type)}"`)]);
      }
    }
  };

  const request = (sim: Simulation, command: RequestCommand) => {
    const requestId = command.requestId === undefined ? {} : { requestId: command.requestId };
    let diagnostics: Diagnostic[];
    switch (command.type) {
      case "register_species": {
        const registered = sim.registerSpecies(command.species, command.appearanceUrl);
        if (!registered.ok) {
          diagnostics = registered.diagnostics;
          break;
        }
        const { species, limits } = registered.value;
        const asset = sim.state.registries.assets.get(species.appearance);
        if (!asset) throw new Error(`"${species.id}" was registered without its appearance`);
        send({
          type: "species_registered",
          ...requestId,
          speciesId: species.id,
          species: summarizeSpecies(species),
          asset: summarizeAsset(asset),
          limits,
        });
        return;
      }
      case "spawn": {
        const spawned = sim.spawn(command.speciesId, command.spawnPointId);
        if (!spawned.ok) {
          diagnostics = spawned.diagnostics;
          break;
        }
        send({ type: "spawned", ...requestId, creatureId: spawned.value.id });
        return;
      }
      case "despawn": {
        const despawned = sim.despawn(command.creatureId);
        if (!despawned.ok) {
          diagnostics = despawned.diagnostics;
          break;
        }
        send({ type: "despawned", ...requestId, creatureId: command.creatureId });
        return;
      }
    }
    send({ type: "rejected", ...requestId, command: command.type, diagnostics });
  };

  const loop = () => {
    if (stopped || !simulation || !clock) return;
    for (const command of queue.splice(0)) {
      apply(simulation, clock, command);
      if (stopped) return;
    }
    const due = clock.advance(options.now());
    for (let n = 0; n < due; n++) {
      const events = simulation.step();
      send({ type: "snapshot", snapshot: simulation.snapshot({ routes: debug }), events });
    }
    options.schedule(loop, clock.tickMs);
  };

  port.onMessage((data) => {
    if (stopped) return;
    const command = openEnvelope<SimulationCommand>(data);
    if (!command) {
      reject([error("protocol_mismatch", "Received a message with another protocol version")]);
    } else if (command.type === "init") {
      init(command);
    } else if (!simulation) {
      reject([error("not_initialized", `"${command.type}" was sent before "init"`)]);
    } else {
      queue.push(command);
    }
  });
}
