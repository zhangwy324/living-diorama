import type { Vec3 } from "@living-diorama/content-schema";
import type { SimulationSnapshot } from "@living-diorama/simulation";

// Creature poses between simulation snapshots (ADR 0007 §8). The renderer draws one tick behind
// the newest snapshot: when a snapshot arrives it starts blending from the previous one towards
// it, and reaches it about when the next one is due.

/** Moving further than this between two snapshots is a teleport, drawn without sliding. */
export const SNAP_DISTANCE = 3;
const MIN_INTERVAL_MS = 1000 / 120;
const MAX_INTERVAL_MS = 1000;
/** Weight of the newest gap in the running estimate of the snapshot interval. */
const INTERVAL_SMOOTHING = 0.2;

export interface CreaturePose {
  id: string;
  speciesId: string;
  world: Vec3;
  heading: number;
}

/** Blends two headings (radians) the short way round. */
export function lerpHeading(from: number, to: number, t: number): number {
  const turn = 2 * Math.PI;
  const delta = ((((to - from + Math.PI) % turn) + turn) % turn) - Math.PI;
  return from + delta * t;
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class SnapshotInterpolator {
  #previous: SimulationSnapshot | undefined;
  #latest: SimulationSnapshot | undefined;
  #receivedAt = 0;
  #intervalMs: number;

  /** `intervalMs` is the first guess at the time between snapshots; arrivals refine it. */
  constructor(intervalMs = 100) {
    this.#intervalMs = intervalMs;
  }

  /** Adds a snapshot received at `now` (milliseconds). Snapshots of an older or the same tick are ignored. */
  push(snapshot: SimulationSnapshot, now: number): void {
    if (this.#latest) {
      if (snapshot.tick <= this.#latest.tick) return;
      const gap = now - this.#receivedAt;
      this.#intervalMs = Math.min(
        MAX_INTERVAL_MS,
        Math.max(MIN_INTERVAL_MS, this.#intervalMs + (gap - this.#intervalMs) * INTERVAL_SMOOTHING),
      );
    }
    this.#previous = this.#latest;
    this.#latest = snapshot;
    this.#receivedAt = now;
  }

  /** Poses of the newest snapshot's creatures at `now`. */
  sample(now: number): CreaturePose[] {
    if (!this.#latest) return [];
    const t = Math.min(1, Math.max(0, (now - this.#receivedAt) / this.#intervalMs));
    const before = new Map(this.#previous?.creatures.map((c) => [c.id, c]));
    return this.#latest.creatures.map(({ id, speciesId, world, heading }) => {
      const from = before.get(id);
      if (!from || distance(from.world, world) > SNAP_DISTANCE) {
        return { id, speciesId, world, heading };
      }
      return {
        id,
        speciesId,
        world: {
          x: from.world.x + (world.x - from.world.x) * t,
          y: from.world.y + (world.y - from.world.y) * t,
          z: from.world.z + (world.z - from.world.z) * t,
        },
        heading: lerpHeading(from.heading, heading, t),
      };
    });
  }
}
