import type {
  BodyShape,
  Diagnostic,
  RegionPosition,
  SizeClass,
  Vec3,
} from "@living-diorama/content-schema";
import type { AssetKind } from "@living-diorama/extension-api";
import type { NavigationOverlay } from "./navigation/overlay";
import type { DayPhase } from "./runtime/time-of-day";
import type { SceneData } from "./world/scene";

// Messages between the main thread and the simulation Web Worker (roadmap §1.4).
// Bump PROTOCOL_VERSION on any incompatible change to these types.

export const PROTOCOL_VERSION = 6;

// ---- Main thread → worker -------------------------------------------------------------------

/**
 * Commands that may fail in normal use (ADR 0012). Their outcome comes back as a reply with the
 * same `requestId`: `species_registered`, `spawned` or `despawned`, or `rejected`.
 */
export type RequestCommand =
  /**
   * Adds a species while the world runs, validated like pack content. Its appearance is an image
   * asset with the ID `species.appearance` and the species' version, served from `appearanceUrl`.
   */
  | { type: "register_species"; requestId?: string; species: unknown; appearanceUrl: string }
  /** Adds a creature at the given spawn point, or a random one. */
  | { type: "spawn"; requestId?: string; speciesId: string; spawnPointId?: string }
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
    };

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
  currentAction?: string;
  /** Waypoints still to reach, per region, from where the creature stands. Only with debug on. */
  route?: RouteLegSnapshot[];
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
      connectionId: string;
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
  | (CreatureEventBase & { type: "creature_stuck"; position: RegionPosition; ticksStuck: number });

/** Events about the world as a whole, with no creature (ADR 0018 §17). */
export type WorldEvent =
  /**
   * The day phase changed. Not emitted for the time of day the world starts at. A jump across
   * several phases emits one event, from the phase before the jump to the one after it.
   */
  WorldEventBase & { type: "day_phase_changed"; from: DayPhase; to: DayPhase };

export type SimulationEvent = CreatureEvent | WorldEvent;

export type SimulationMessage =
  | ({ type: "ready"; worldId: string } & WorldContent)
  /** Sent every tick; `events` are those emitted since the previous snapshot. */
  | { type: "snapshot"; snapshot: SimulationSnapshot; events: SimulationEvent[] }
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
   * errors that keep it out of the world entirely (e.g. `no_spawn_point`).
   */
  | { type: "limits"; requestId?: string; limits: Limit[] }
  | { type: "spawned"; requestId?: string; creatureId: string }
  | { type: "despawned"; requestId?: string; creatureId: string }
  /** A request command could not be applied. Not a fault: the world keeps running. */
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
