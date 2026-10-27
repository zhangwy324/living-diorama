import type { Diagnostic, RegionPosition, SizeClass, Vec3 } from "@living-diorama/content-schema";
import type { AssetKind } from "@living-diorama/extension-api";
import type { NavigationOverlay } from "./navigation/overlay";
import type { SceneData } from "./world/scene";

// Messages between the main thread and the simulation Web Worker (roadmap §1.4).
// Bump PROTOCOL_VERSION on any incompatible change to these types.

export const PROTOCOL_VERSION = 3;

// ---- Main thread → worker -------------------------------------------------------------------

export type SimulationCommand =
  /** First message. The worker loads content itself; only IDs and settings cross the boundary. */
  | { type: "init"; worldId: string; seed: number; tickRateHz: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "set_speed"; multiplier: number }
  | { type: "spawn"; speciesId: string; spawnPointId?: string }
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

/** What the renderer needs of a registered species. */
export interface SpeciesSummary {
  /** Asset ref of the appearance image. */
  appearance: string;
  sizeClass: SizeClass;
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
  creatures: CreatureSnapshot[];
}

interface EventBase {
  tick: number;
  creatureId: string;
}

/** v1 simulation events (roadmap M3 task 10). Structures are identified by placement ID. */
export type SimulationEvent =
  | (EventBase & { type: "creature_spawned"; speciesId: string; regionId: string })
  | (EventBase & {
      type: "entered_region";
      fromRegionId: string;
      toRegionId: string;
      connectionId: string;
    })
  | (EventBase & { type: "first_use_of_structure"; structureId: string; connectionId: string })
  | (EventBase & { type: "path_failed"; from: RegionPosition; to: RegionPosition; reason: string })
  | (EventBase & { type: "creature_stuck"; position: RegionPosition; ticksStuck: number });

export type SimulationMessage =
  | ({ type: "ready"; worldId: string } & WorldContent)
  /** Sent every tick; `events` are those emitted since the previous snapshot. */
  | { type: "snapshot"; snapshot: SimulationSnapshot; events: SimulationEvent[] }
  /** A command was rejected. After a failed `init` (e.g. content failed to load) the worker stays idle. */
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
