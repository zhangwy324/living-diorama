import type { Vec3 } from "@living-diorama/content-schema";
import type { Cue, SimulationSnapshot } from "@living-diorama/simulation";

// Creature poses between simulation snapshots (ADR 0007 §8). The renderer draws one tick behind
// the newest snapshot: when a snapshot arrives it starts blending from the previous one towards
// it, and reaches it about when the next one is due.

/** Moving further than this between two snapshots is a teleport, drawn without sliding. */
export const SNAP_DISTANCE = 3;
const MIN_INTERVAL_MS = 1000 / 120;
/**
 * A longer wait between snapshots is a break (a pause, a hidden window, the PC sleeping), not
 * the pace of the simulation: the next snapshot is drawn as it is and the wait is not learnt.
 */
const MAX_INTERVAL_MS = 1000;
/** Weight of the newest gap in the running estimate of the snapshot interval. */
const INTERVAL_SMOOTHING = 0.2;

export interface CreaturePose {
  id: string;
  speciesId: string;
  world: Vec3;
  heading: number;
  /**
   * What the creature shows (ADR 0018 §15): the cues of the snapshot the pose blends from, the
   * newest once the pose reaches it, so cues don't lead the body. The creatures fade them.
   */
  cues: readonly Cue[];
  /** How far through the action showing its cue the creature is, 0–1, if the action says. */
  cueProgress?: number | undefined;
  /**
   * How it moves now (ADR 0020 §8), e.g. "walk", "hop", "swim": the profile of the snapshot the
   * pose blends from, like its cues. None or an unknown name draws no motion.
   */
  animation?: string | undefined;
  /** How far it sits in water, as a share of its body's height (0–1, ADR 0020 §9). Blended. */
  submersion?: number;
}

/**
 * The snapshot fields the animation reads. Until the simulation sends them (M16 PR 2) they are
 * read as optional here, the one place that does; then this becomes `CreatureSnapshot` itself.
 */
type AnimatedSnapshot = SimulationSnapshot["creatures"][number] & {
  animation?: string | undefined;
  submersion?: number;
};

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
  #restarting = false;

  /** `intervalMs` is the first guess at the time between snapshots; arrivals refine it. */
  constructor(intervalMs = 100) {
    this.#intervalMs = intervalMs;
  }

  /** Adds a snapshot received at `now` (milliseconds). Snapshots of an older or the same tick are ignored. */
  push(snapshot: SimulationSnapshot, now: number): void {
    let previous = this.#restarting ? undefined : this.#latest;
    this.#restarting = false;
    if (previous) {
      if (snapshot.tick <= previous.tick) return;
      const gap = now - this.#receivedAt;
      if (gap > MAX_INTERVAL_MS) {
        previous = undefined;
      } else {
        this.#intervalMs = Math.max(
          MIN_INTERVAL_MS,
          this.#intervalMs + (gap - this.#intervalMs) * INTERVAL_SMOOTHING,
        );
      }
    }
    this.#previous = previous;
    this.#latest = snapshot;
    this.#receivedAt = now;
  }

  /**
   * Takes the next snapshot as it is, whatever its tick, and blends nothing into it: for when the
   * world was replaced (a restored save), whose ticks may run behind or far ahead of these. Until
   * then the newest snapshot is still drawn.
   */
  reset(): void {
    this.#restarting = true;
  }

  /** Poses of the newest snapshot's creatures at `now`. */
  sample(now: number): CreaturePose[] {
    if (!this.#latest) return [];
    const t = Math.min(1, Math.max(0, (now - this.#receivedAt) / this.#intervalMs));
    const previous: readonly AnimatedSnapshot[] = this.#previous?.creatures ?? [];
    const latest: readonly AnimatedSnapshot[] = this.#latest.creatures;
    const before = new Map(previous.map((c) => [c.id, c]));
    return latest.map((creature) => {
      const { id, speciesId, world, heading, cues, cueProgress, animation } = creature;
      const submersion = creature.submersion ?? 0;
      const from = before.get(id);
      if (!from || distance(from.world, world) > SNAP_DISTANCE) {
        return { id, speciesId, world, heading, cues, cueProgress, animation, submersion };
      }
      const fromSubmersion = from.submersion ?? 0;
      return {
        id,
        speciesId,
        world: {
          x: from.world.x + (world.x - from.world.x) * t,
          y: from.world.y + (world.y - from.world.y) * t,
          z: from.world.z + (world.z - from.world.z) * t,
        },
        heading: lerpHeading(from.heading, heading, t),
        // The cues of the snapshot the pose blends from, until it arrives, so cues don't lead the body.
        cues: t < 1 ? from.cues : cues,
        // Blended when both snapshots have it, so a progress ring fills smoothly between ticks; a
        // lower one is a new meal, taken as it is so the ring never sweeps backwards.
        cueProgress:
          from.cueProgress !== undefined && cueProgress !== undefined
            ? cueProgress < from.cueProgress
              ? cueProgress
              : from.cueProgress + (cueProgress - from.cueProgress) * t
            : t < 1
              ? from.cueProgress
              : cueProgress,
        animation: t < 1 ? from.animation : animation,
        // Blended, so a creature sinks smoothly as it goes into the water and rises as it leaves.
        submersion: fromSubmersion + (submersion - fromSubmersion) * t,
      };
    });
  }
}
