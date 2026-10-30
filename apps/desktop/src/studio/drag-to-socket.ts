import {
  scoreSockets,
  type SocketProbe,
  type SocketRef,
  type Vec3,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import { targetsFor } from "./assembly-state";
import type { PartsKit } from "./parts-kit";

// Drag-to-socket (ADR 0023 §4): a part dragged from the tray over the assembly view goes to the
// socket the pointer points at best, by PR 1's distance and angle scorer, among the sockets a click
// could put it on (free, and taken ones it can replace).

/**
 * How far from a socket on screen, in CSS pixels, the pointer still finds it. Generous, since the
 * view is small and a socket's marker is a few pixels across.
 */
export const DRAG_REACH_PX = 48;

/**
 * Radians a metre further from the camera costs a socket: a tie-break, so of two sockets in line
 * the one in front wins, too small to pull the choice off a socket the pointer is on.
 */
export const DRAG_DISTANCE_WEIGHT = 0.1;

/** Radians between two directions; 0 for a zero vector. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const lengths = Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z);
  if (!(lengths > 0)) return 0;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / lengths;
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

/**
 * The socket a part `partId` dragged along `probe` would go to: of the sockets it can go on with
 * Mirror as given, those within `reach` radians of the probe's ray, the best by `scoreSockets`.
 * Undefined when none is within reach.
 */
export function dragTarget(
  kit: PartsKit,
  assembly: VoxelAssembly,
  partId: string,
  mirror: boolean,
  probe: SocketProbe,
  reach: number,
): SocketRef | undefined {
  const { free, occupied } = targetsFor(kit, assembly, partId, mirror);
  if (free.length === 0 && occupied.length === 0) return undefined;
  const best = scoreSockets(assembly, [...free, ...occupied], probe, {
    distanceWeight: DRAG_DISTANCE_WEIGHT,
  }).find(({ angle }) => angle <= reach);
  return best && { instance: best.instance, socket: best.socket };
}
