import {
  error,
  parseWorldEdit,
  parseWorldSave,
  validate,
  VoxelAssemblySchema,
  type Diagnostic,
  type Result,
  type SpeciesDefinition,
} from "@living-diorama/content-schema";
import {
  checkAssemblyTypes,
  sortedPartTypes,
  sortedPropCategories,
  type AssetEntry,
  type LocomotionRule,
  type Registries,
} from "@living-diorama/extension-api";
import { describeNavigation } from "../navigation/overlay";
import {
  envelope,
  openEnvelope,
  type AssetSummary,
  type RequestCommand,
  type SimulationCommand,
  type SimulationEvent,
  type SimulationMessage,
  type SpeciesSummary,
  type WorldContent,
} from "../protocol";
import { describeScene } from "../world/scene";
import { FixedClock, isValidSpeed, MAX_SPEED } from "./clock";
import type { RestoreReport } from "./save";
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
  /**
   * Wall-clock time in milliseconds since the epoch, e.g. `Date.now`, which moves on while the OS
   * sleeps. Only stamped on snapshots (`wallMs`); the tick loop runs on `now`.
   */
  wallNow(): number;
  /** Calls `callback` once after about `delayMs`, e.g. `setTimeout`. */
  schedule(callback: () => void, delayMs: number): void;
  /** Ends the host's process on `shutdown`, e.g. a worker's `close`. */
  close?(): void;
}

type QueuedCommand = Exclude<SimulationCommand, { type: "init" }>;

const invalidTimeOfDay = (minutes: unknown) =>
  error(
    "invalid_time_of_day",
    `The time of day must be a number of minutes, got ${String(minutes)}`,
  );

const summarizeAsset = ({ kind, url, scale }: AssetEntry): AssetSummary => ({
  kind,
  url,
  ...(scale === undefined ? {} : { scale }),
});

/**
 * A species as the main thread draws it. A voxel species' body plan is only how it moves: its
 * shape is in its assembly, which the renderer reads from the appearance asset (ADR 0022 §20).
 */
function summarizeSpecies(
  { appearance, sizeClass, body }: SpeciesDefinition,
  registries: Registries,
): SpeciesSummary {
  const kind = registries.assets.get(appearance)?.kind;
  return {
    appearance,
    sizeClass,
    body: kind === "voxel" ? { locomotion: body.locomotion } : { ...body },
  };
}

/** The world as the main thread draws it, as plain data so it survives `postMessage`. */
export function describeContent({ state }: Simulation): WorldContent {
  const { model, registries } = state;
  return {
    scene: describeScene(model),
    navigations: state.navigations.map((navigation) => describeNavigation(model, navigation)),
    assets: Object.fromEntries(registries.assets.values().map((a) => [a.id, summarizeAsset(a)])),
    species: Object.fromEntries(
      registries.species.values().map((s) => [s.id, summarizeSpecies(s, registries)]),
    ),
    props: Object.fromEntries(
      registries.props
        .values()
        .map(({ id, name, model, blockRadius, category }) => [
          id,
          { name, model, blockRadius, ...(category === undefined ? {} : { category }) },
        ]),
    ),
    propCategories: sortedPropCategories(registries).map(({ id, name }) => ({ id, name })),
    partTypes: sortedPartTypes(registries).map(({ id, role }) => ({
      id,
      ...(role === undefined ? {} : { role }),
    })),
  };
}

/**
 * Runs an edit or a dry run, turning a throw (a bug, or a pack hook that throws while the edit is
 * planned) into a rejection with `edit_failed`.
 */
function guardEdit<T extends { ok: boolean }>(
  run: () => T,
): T | { ok: false; diagnostics: Diagnostic[] } {
  try {
    return run();
  } catch (cause) {
    const message = `The edit failed: ${cause instanceof Error ? cause.message : String(cause)}`;
    return { ok: false, diagnostics: [error("edit_failed", message, [], "world edit")] };
  }
}

/** Checks the options and the untrusted save text, then restores; never throws on either. */
function restoreSave(
  sim: Simulation,
  { json, nowMs, minutes }: Extract<RequestCommand, { type: "restore" }>,
): Result<RestoreReport> {
  if (!Number.isFinite(nowMs)) {
    const message = `The wall-clock time must be a number of milliseconds, got ${String(nowMs)}`;
    return { ok: false, diagnostics: [error("invalid_wall_clock", message)] };
  }
  if (!Number.isFinite(minutes)) return { ok: false, diagnostics: [invalidTimeOfDay(minutes)] };
  let save: unknown;
  try {
    if (typeof json !== "string") throw new TypeError(`Expected text, got ${typeof json}`);
    save = JSON.parse(json);
  } catch (cause) {
    const message = `The save is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`;
    return { ok: false, diagnostics: [error("invalid_save_json", message)] };
  }
  const parsed = parseWorldSave(save);
  return parsed.ok ? sim.restore(parsed.value, { nowMs, minutes }) : parsed;
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
  const sendSnapshot = (sim: Simulation, paused: boolean, events: SimulationEvent[] = []) =>
    send({
      type: "snapshot",
      snapshot: sim.snapshot({ paused, debug }),
      events,
      wallMs: options.wallNow(),
    });

  const init = (command: Extract<SimulationCommand, { type: "init" }>) => {
    if (simulation) {
      reject([error("already_initialized", "The simulation is already initialized")]);
      return;
    }
    const { tickRateHz, maxCreatures, minutes } = command;
    if (!(Number.isFinite(tickRateHz) && tickRateHz > 0)) {
      reject([error("invalid_tick_rate", `Tick rate must be positive, got ${tickRateHz}`)]);
      return;
    }
    if (!Number.isFinite(minutes)) {
      reject([invalidTimeOfDay(minutes)]);
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
      minutes,
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
        if (isValidSpeed(command.multiplier)) {
          ticks.setSpeed(command.multiplier);
        } else {
          reject([
            error(
              "invalid_speed",
              `Speed must be above 0 and at most ${MAX_SPEED}, got ${String(command.multiplier)}`,
            ),
          ]);
        }
        break;
      case "set_time_of_day":
        if (Number.isFinite(command.minutes)) {
          sim.setTimeOfDay(command.minutes);
          // No tick runs while paused, so the paused world shows the new time this way.
          if (ticks.paused) sendSnapshot(sim, true);
        } else {
          reject([invalidTimeOfDay(command.minutes)]);
        }
        break;
      case "set_debug":
        debug = command.enabled === true;
        break;
      case "register_species":
      case "spawn":
      case "despawn":
      case "check_limits":
      case "check_assembly":
      case "save":
      case "restore":
      case "catch_up":
      case "edit":
      case "validate_edit":
        request(sim, ticks, command);
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

  const request = (sim: Simulation, ticks: FixedClock, command: RequestCommand) => {
    const requestId = command.requestId === undefined ? {} : { requestId: command.requestId };
    let diagnostics: Diagnostic[];
    switch (command.type) {
      case "register_species": {
        const registered = sim.registerSpecies(
          command.species,
          command.appearanceUrl,
          command.appearanceKind,
        );
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
          species: summarizeSpecies(species, sim.state.registries),
          asset: summarizeAsset(asset),
          limits,
        });
        return;
      }
      case "spawn": {
        const spawned = sim.spawn(command.speciesId, command.spawnPointId, {
          released: command.released === true,
        });
        if (!spawned.ok) {
          diagnostics = spawned.diagnostics;
          break;
        }
        send({ type: "spawned", ...requestId, creatureId: spawned.value.id });
        return;
      }
      case "check_limits": {
        const checked = sim.checkLimits(command.sizeClass, command.capabilities);
        if (!checked.ok) {
          diagnostics = checked.diagnostics;
          break;
        }
        const locomotion: Record<string, LocomotionRule> = {};
        for (const id of Object.keys(command.capabilities)) {
          const rule = sim.state.registries.capabilities.get(id)?.locomotion;
          if (rule) locomotion[id] = rule;
        }
        send({ type: "limits", ...requestId, limits: checked.value, locomotion });
        return;
      }
      case "check_assembly": {
        // Checked and dropped: the worker never keeps the cubes (ADR 0022 §20).
        const assembly = validate(VoxelAssemblySchema, command.assembly, "assembly");
        send({
          type: "assembly_checked",
          ...requestId,
          diagnostics: assembly.ok
            ? checkAssemblyTypes(sim.state.registries, assembly.value, "assembly")
            : assembly.diagnostics,
        });
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
      case "save": {
        const { savedAt } = command;
        // What the save schema accepts, so every save can be restored.
        if (!(Number.isInteger(savedAt) && savedAt >= 0)) {
          diagnostics = [
            error(
              "invalid_saved_at",
              `The save time must be a whole number of milliseconds since the epoch, got ${String(savedAt)}`,
            ),
          ];
          break;
        }
        send({ type: "saved", ...requestId, json: JSON.stringify(sim.save(savedAt)) });
        return;
      }
      case "restore": {
        const before = sim.state.model;
        const restored = restoreSave(sim, command);
        if (!restored.ok) {
          diagnostics = restored.diagnostics;
          break;
        }
        // Time owed to the replaced world must not tick the restored one in a burst.
        ticks.restart();
        send({ type: "restored", ...requestId, report: restored.value });
        if (sim.state.model !== before) {
          const { scene, navigations } = describeContent(sim);
          send({ type: "world_changed", scene, navigations });
        }
        // No tick runs while paused, so the paused world shows the restored one this way.
        if (ticks.paused) sendSnapshot(sim, true);
        return;
      }
      case "catch_up": {
        const { gapMs, minutes } = command;
        if (!Number.isFinite(gapMs)) {
          const message = `The gap must be a number of milliseconds, got ${String(gapMs)}`;
          diagnostics = [error("invalid_gap", message)];
          break;
        }
        if (!Number.isFinite(minutes)) {
          diagnostics = [invalidTimeOfDay(minutes)];
          break;
        }
        const report = sim.catchUp({ gapMs, minutes });
        // Time owed from before the gap must not tick the caught-up world in a burst.
        if (report.applied) ticks.restart();
        send({ type: "caught_up", ...requestId, report });
        if (ticks.paused) sendSnapshot(sim, true);
        return;
      }
      case "edit": {
        const parsed = parseWorldEdit(command.edit, "world edit");
        // `applyEdit` throws only while planning, before anything changed (`#reconcile` never
        // throws), so a throw is a rejection and the world goes on as it was.
        const result = parsed.ok ? guardEdit(() => sim.applyEdit(parsed.value)) : parsed;
        if (!result.ok) {
          diagnostics = [...result.diagnostics];
          break;
        }
        send({ type: "edited", ...requestId, result });
        const { scene, navigations } = describeContent(sim);
        send({ type: "world_changed", scene, navigations });
        // No tick runs while paused, so the paused world shows the edit this way.
        if (ticks.paused) sendSnapshot(sim, true);
        return;
      }
      case "validate_edit": {
        const parsed = parseWorldEdit(command.edit, "world edit");
        const check = parsed.ok ? guardEdit(() => sim.validateEdit(parsed.value)) : parsed;
        if (!check.ok && check.diagnostics.some((d) => d.code === "edit_failed")) {
          diagnostics = [...check.diagnostics];
          break;
        }
        send({ type: "edit_checked", ...requestId, check });
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
    for (let n = 0; n < due; n++) sendSnapshot(simulation, false, simulation.step());
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
