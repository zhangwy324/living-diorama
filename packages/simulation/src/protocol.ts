import type { Diagnostic, RegionPosition, Vec3 } from "@living-diorama/content-schema";

// Messages between the main thread and the simulation Web Worker (roadmap §1.4).
// Bump PROTOCOL_VERSION on any incompatible change to these types.

export const PROTOCOL_VERSION = 1;

// ---- Main thread → worker -------------------------------------------------------------------

export type SimulationCommand =
  /** First message. The worker loads content itself; only IDs and settings cross the boundary. */
  | { type: "init"; worldId: string; seed: number; tickRateHz: number }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "set_speed"; multiplier: number }
  | { type: "spawn"; speciesId: string; spawnPointId?: string }
  | { type: "shutdown" };

// ---- Worker → main thread -------------------------------------------------------------------

export interface CreatureSnapshot {
  id: string;
  speciesId: string;
  /** Region-relative position, authoritative. */
  position: RegionPosition;
  /** World position resolved from the region's surface, so the renderer needs no lookups. */
  world: Vec3;
  heading: number;
  currentAction?: string;
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
  | { type: "ready"; worldId: string }
  /** Sent every tick; `events` are those emitted since the previous snapshot. */
  | { type: "snapshot"; snapshot: SimulationSnapshot; events: SimulationEvent[] }
  /** Content failed to load or validate; the worker stays idle. */
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
