import type {
  BodyShape,
  Diagnostic,
  RegionPosition,
  SizeClass,
  Vec3,
} from "@living-diorama/content-schema";
import type { AssetKind, Cue, LocomotionRule } from "@living-diorama/extension-api";
import type { ActionEvent } from "./creatures/action-event";
import type { CreatureKnowledge } from "./creatures/knowledge";
import type { NavigationOverlay } from "./navigation/overlay";
import type { CatchUpReport, RestoreReport } from "./runtime/save";
import type { DayPhase } from "./runtime/time-of-day";
import type { SceneData } from "./world/scene";

// Messages between the main thread and the simulation Web Worker (roadmap §1.4).
// Bump PROTOCOL_VERSION on any incompatible change to these types.

export const PROTOCOL_VERSION = 13;

export type { ActionEvent } from "./creatures/action-event";

// ---- Main thread → worker -------------------------------------------------------------------

/**
 * Commands that may fail in normal use (ADR 0012). Their outcome comes back as a reply with the
 * same `requestId`: `species_registered`, `limits`, `spawned`, `despawned`, `saved`, `restored`
 * or `caught_up`, or `rejected`.
 */
export type RequestCommand =
  /**
   * Adds a species while the world runs, validated like pack content. Its appearance is an image
   * asset with the ID `species.appearance` and the species' version, served from `appearanceUrl`.
   */
  | { type: "register_species"; requestId?: string; species: unknown; appearanceUrl: string }
  /**
   * Adds a creature at the given spawn point, or a random one. `released`: it comes from the
   * Studio, so it gets the release grace (ADR 0018 amendments, §13).
   */
  | {
      type: "spawn";
      requestId?: string;
      speciesId: string;
      spawnPointId?: string;
      released?: boolean;
    }
  | { type: "despawn"; requestId?: string; creatureId: string }
  /**
   * Where creatures of this size class and these capabilities wouldn't fit, without registering
   * anything (ADR 0015 §8). Answered by `limits`.
   */
  | {
      type: "check_limits";
      requestId?: string;
      sizeClass: SizeClass;
      capabilities: Record<string, number>;
    }
  /**
   * Saves the world (ADR 0019), answered by `saved`. Applied between ticks, after the commands
   * sent before it (so a save sent after a spawn holds the new creature), and answered while
   * paused too. `savedAt` is the wall-clock time in milliseconds since the epoch (`Date.now()`),
   * a non-negative whole number.
   */
  | { type: "save"; requestId?: string; savedAt: number }
  /**
   * Replaces the world with a save (ADR 0019 §3, §7), answered by `restored`. `json` is the
   * stored text, as `saved` gave it, and untrusted: the worker parses and validates it. Text that
   * isn't JSON, or a save that fails validation, is of another world or world version, or
   * disagrees with itself, is answered by `rejected` and leaves the world as it was, so the
   * caller carries on with a fresh world. `nowMs` is the
   * wall-clock time in milliseconds since the epoch, from which the gap since the save is
   * computed; `minutes` is the present local time of day (ADR 0018 §5).
   */
  | { type: "restore"; requestId?: string; json: string; nowMs: number; minutes: number }
  /**
   * Catches the running world up for `gapMs` of wall-clock time it lost, e.g. while the OS slept
   * with the app open (issue #113), answered by `caught_up`. The gap rules and catch-up of
   * `restore` apply (ADR 0019 §5, §6), so the world ends up as a save of it restored after the
   * same gap would. `minutes` is the present local time of day, set first as `set_time_of_day`
   * sets it. Applied while paused too, though the main thread sends none then.
   */
  | { type: "catch_up"; requestId?: string; gapMs: number; minutes: number };

export type SimulationCommand =
  /**
   * First message. The worker loads content itself; only IDs and settings cross the boundary.
   * `maxCreatures` caps the creatures in the world. `minutes` is the local time of day, in
   * minutes since midnight (ADR 0018 §5).
   */
  | {
      type: "init";
      worldId: string;
      seed: number;
      tickRateHz: number;
      maxCreatures: number;
      minutes: number;
    }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "set_speed"; multiplier: number }
  /**
   * The local time of day, in minutes since midnight (ADR 0018 §5). Sent every minute and on
   * resume, and applied at a tick boundary like any other command, so a run replays from its log.
   */
  | { type: "set_time_of_day"; minutes: number }
  | RequestCommand
  /** Adds debug data (routes) to snapshots while enabled (ADR 0007 §10). */
  | { type: "set_debug"; enabled: boolean }
  | { type: "shutdown" };

// ---- Worker → main thread -------------------------------------------------------------------

/** What the renderer needs of a registered asset. */
export interface AssetSummary {
  kind: AssetKind;
  url: string;
  scale?: number;
}

/**
 * Where a navigation profile's creatures don't fit in the world (ADR 0013): a diagnostic, and the
 * structure it is about, if any, so the player can be told its name.
 */
export interface Limit extends Diagnostic {
  structure?: { id: string; name: string };
}

/** What the renderer needs of a registered species. */
export interface SpeciesSummary {
  /** Asset ref of the appearance image. */
  appearance: string;
  sizeClass: SizeClass;
  /** How its body is built from the appearance. */
  body: BodyShape;
}

/**
 * Everything the main thread needs to draw the world, resolved by the worker, which is the only
 * place content is registered and checked (ADR 0010).
 */
export interface WorldContent {
  scene: SceneData;
  /** Debug overlay per navigation profile. */
  navigations: NavigationOverlay[];
  /** Every registered asset and species, by ID. */
  assets: Record<string, AssetSummary>;
  species: Record<string, SpeciesSummary>;
}

/** The part of a remaining route inside one region, with world positions of its waypoints. */
export interface RouteLegSnapshot {
  regionId: string;
  points: Vec3[];
}

export interface CreatureSnapshot {
  id: string;
  speciesId: string;
  /** Region-relative position, authoritative. */
  position: RegionPosition;
  /** World position resolved from the region's surface, so the renderer needs no lookups. */
  world: Vec3;
  heading: number;
  /**
   * The animation profile of the capability in use where the creature is (ADR 0020 §8): `walk`
   * or `hop` on land (the species' gait), `swim` in water, or another name a pack declares.
   * Undefined for none; the renderer draws an unknown or missing profile with no motion.
   */
  animation: string | undefined;
  /**
   * How far the body sits below the surface, as a share of its height from 0 to 1, from the
   * capability in use (ADR 0020 §9). 0 on land.
   */
  submersion: number;
  currentAction?: string;
  /**
   * What the creature visibly shows (ADR 0018 §15), so the renderer needs no action or need IDs:
   * its action's cue (`eating`, `sleeping`) while that action isn't walking, then the cue of
   * each need at or above the value it shows from (`hungry`).
   */
  cues: Cue[];
  /**
   * How far through the action showing its cue the creature is, 0–1, if the action reports it.
   * The renderer currently draws it only for the `eating` cue.
   */
  cueProgress?: number;
  /**
   * The placement ID the creature heads for to answer a need whose cue it shows, e.g. the food it
   * goes to while `hungry` (issue #110): its action's target, when the behavior that chose the
   * action acts on that need. Absent while it has no such target, e.g. exploring for food. It
   * doesn't say which cue it goes with, so the renderer reads it only with `hungry`.
   */
  cueTarget?: string;
  /** Waypoints still to reach, per region, from where the creature stands. Only with debug on. */
  route?: RouteLegSnapshot[];
  /** Need ID → value in [0, 1]. Only with debug on. */
  needs?: Record<string, number>;
  /** Places seen and cells visited. Only with debug on. */
  knowledge?: CreatureKnowledge;
  /** The placement ID of its home, or null. Only with debug on. */
  home?: string | null;
}

export interface SimulationSnapshot {
  tick: number;
  /** Simulation time at this tick, in milliseconds. */
  timeMs: number;
  paused: boolean;
  /** The time of day the simulation runs at, in minutes since local midnight (ADR 0018 §6). */
  timeOfDay: number;
  creatures: CreatureSnapshot[];
}

interface WorldEventBase {
  tick: number;
}

interface CreatureEventBase extends WorldEventBase {
  creatureId: string;
}

/**
 * Events about one creature (roadmap M3 task 10, M9 task 5). Structures are identified by
 * placement ID.
 */
export type CreatureEvent =
  | (CreatureEventBase & { type: "creature_spawned"; speciesId: string; regionId: string })
  /** The first creature of a species in this world; follows its `creature_spawned`. */
  | (CreatureEventBase & { type: "species_introduced"; speciesId: string })
  | (CreatureEventBase & { type: "creature_despawned"; speciesId: string; regionId: string })
  | (CreatureEventBase & {
      type: "entered_region";
      fromRegionId: string;
      toRegionId: string;
      /** The connection crossed; absent for a jump across a bank between land and water (ADR 0020 §4). */
      connectionId?: string;
    })
  | (CreatureEventBase & {
      type: "first_use_of_structure";
      structureId: string;
      connectionId: string;
    })
  | (CreatureEventBase & {
      type: "path_failed";
      from: RegionPosition;
      to: RegionPosition;
      reason: string;
    })
  | (CreatureEventBase & { type: "creature_stuck"; position: RegionPosition; ticksStuck: number })
  /** The creature took `placementId` as its home (ADR 0018 §14); `previous` is the old one. */
  | (CreatureEventBase & {
      type: "new_home_selected";
      placementId: string;
      previous: string | null;
    })
  | (CreatureEventBase & ActionEvent);

/** Events about the world as a whole, with no creature (ADR 0018 §17). */
export type WorldEvent =
  /**
   * The day phase changed. Not emitted for the time of day the world starts at. A jump across
   * several phases emits one event, from the phase before the jump to the one after it.
   */
  WorldEventBase & { type: "day_phase_changed"; from: DayPhase; to: DayPhase };

export type SimulationEvent = CreatureEvent | WorldEvent;

/** What `limits` answers `check_limits` with (ADR 0015 §8, issue #136). */
export interface CheckedLimits {
  /** Where the profile's creatures don't fit, or the errors that keep it out of the world. */
  limits: Limit[];
  /** The locomotion rule of each asked capability that is a way of moving, by its ID. */
  locomotion: Record<string, LocomotionRule>;
}

export type SimulationMessage =
  | ({ type: "ready"; worldId: string } & WorldContent)
  /**
   * Sent every tick; `events` are those emitted since the previous snapshot. `wallMs` is the
   * worker's wall-clock time (`Date.now()`) when it was sent, so the main thread can tell time the
   * worker lost from a late delivery (issue #113).
   */
  | {
      type: "snapshot";
      snapshot: SimulationSnapshot;
      events: SimulationEvent[];
      wallMs: number;
    }
  /**
   * A species was registered: what the main thread needs to draw its creatures, and where they
   * don't fit in this world, as warnings (ADR 0013).
   */
  | {
      type: "species_registered";
      requestId?: string;
      speciesId: string;
      species: SpeciesSummary;
      asset: AssetSummary;
      limits: Limit[];
    }
  /**
   * The answer to `check_limits`: warnings where the profile's creatures don't fit, or the
   * errors that keep it out of the world entirely (e.g. `no_spawn_point`). With them, how the
   * asked capabilities move a creature, so the Studio's preview needn't repeat it (issue #136).
   */
  | ({ type: "limits"; requestId?: string } & CheckedLimits)
  | { type: "spawned"; requestId?: string; creatureId: string }
  | { type: "despawned"; requestId?: string; creatureId: string }
  /**
   * The answer to `save`: the save as JSON text, ready to store. It is serialized in the worker,
   * so the main thread neither copies the world as objects nor stringifies it.
   */
  | { type: "saved"; requestId?: string; json: string }
  /**
   * The answer to `restore`: the world is now the save's, and the next snapshot shows it. The
   * report says how long the world was away and what no longer fit it.
   */
  | { type: "restored"; requestId?: string; report: RestoreReport }
  /**
   * The answer to `catch_up`: what catch-up did. When it ran, the next snapshot shows the world
   * caught up, its tick far ahead of the last one.
   */
  | { type: "caught_up"; requestId?: string; report: CatchUpReport }
  /**
   * A request command could not be applied. Not a fault: the world keeps running. For `restore`
   * the save is unusable and the world is unchanged, so start fresh. The diagnostics say why:
   * `invalid_save_json`, the schema's (e.g. `unsupported_save_version`), `save_world_mismatch`
   * or `save_inconsistent`, or `invalid_wall_clock` / `invalid_time_of_day` for the options;
   * for `catch_up`, `invalid_gap` or `invalid_time_of_day`.
   */
  | {
      type: "rejected";
      requestId?: string;
      command: RequestCommand["type"];
      diagnostics: Diagnostic[];
    }
  /**
   * A command was misused: sent before `init`, with another protocol version, unknown or with
   * invalid settings. After a failed `init` (e.g. content failed to load) the worker stays idle.
   */
  | { type: "error"; diagnostics: Diagnostic[] };

// ---- Envelope -------------------------------------------------------------------------------

export interface Envelope<T> {
  protocolVersion: number;
  message: T;
}

export function envelope<T>(message: T): Envelope<T> {
  return { protocolVersion: PROTOCOL_VERSION, message };
}

/** Unwraps a received envelope, or returns undefined if it was sent with another protocol version. */
export function openEnvelope<T>(data: unknown): T | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { protocolVersion, message } = data as Partial<Envelope<T>>;
  return protocolVersion === PROTOCOL_VERSION ? message : undefined;
}
