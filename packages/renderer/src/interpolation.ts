import {
  MAX_SIZE_CLASS_RADIUS,
  SIZE_CLASSES,
  WORLD_TOLERANCES,
  jumpClearance,
  type SizeClass,
  type Vec3,
} from "@living-diorama/content-schema";
import type { CreatureSnapshot, Cue, SimulationSnapshot } from "@living-diorama/simulation";

// Creature poses between simulation snapshots (ADR 0007 §8). The renderer draws one tick behind
// the newest snapshot: when a snapshot arrives it starts blending from the previous one towards
// it, and reaches it about when the next one is due. A bank jump, made whole in one tick (ADR
// 0020 §4), is drawn as a short arc over a few ticks instead.

/**
 * The longest bank jump (ADR 0020 §4) any creature makes in its one tick, in metres: the
 * horizontal reach of the largest size class (its radius twice over plus `maxBankJumpGap`, as
 * navigation's `bankReach` has it) with `maxBankJumpHeight` of rise or fall. About 3.43 m.
 */
export const MAX_BANK_JUMP = Math.hypot(
  2 * MAX_SIZE_CLASS_RADIUS + WORLD_TOLERANCES.maxBankJumpGap,
  WORLD_TOLERANCES.maxBankJumpHeight,
);

/**
 * Moving further than this between two snapshots is a teleport (a catch-up after a gap, say),
 * drawn without sliding. A tick's walk is a few centimetres and a bank jump is made in a tick of
 * its own, so the longest real move is `MAX_BANK_JUMP`; the half metre on top is headroom for
 * surface heights sampled off the cell centres and for fast species. A restore resets the
 * interpolator instead, so it snaps at any distance.
 */
export const SNAP_DISTANCE = MAX_BANK_JUMP + 0.5;

/**
 * A change of medium with a move at least this long in one tick is a bank jump. Shorter, it is a
 * walk across an authored shore exit, which changes region on a cell edge at walking pace.
 * This assumes walking slower than 2 m/s at the default 10 Hz tick: `baseSpeed` is unbounded in
 * the schema, so a faster species crossing a shore exit would get a small arc too.
 */
export const MIN_BANK_JUMP = 0.2;

/** How long a bank jump's arc is drawn, in milliseconds (issue #132). */
export const JUMP_MS = 350;
/**
 * The arc never lasts more than this many snapshot intervals, so in a world sped up the drawn
 * creature doesn't trail far behind its own position.
 */
export const JUMP_MAX_INTERVALS = 4;

/** A species' size class, or undefined when unknown. `SpeciesResolver` fits. */
export type JumpSizeResolver = (speciesId: string) => { sizeClass: SizeClass } | undefined;

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
  animation: string | undefined;
  /** How far it sits in water, as a share of its body's height (0–1, ADR 0020 §9). Blended. */
  submersion: number;
  /**
   * How far through a bank jump's arc it is, 0–1, while in the air; undefined otherwise. The arc
   * is already in `world` and `submersion`; the body draws its leap from this.
   */
  jump?: number | undefined;
}

/** Blends two headings (radians) the short way round. */
export function lerpHeading(from: number, to: number, t: number): number {
  const turn = 2 * Math.PI;
  const delta = ((((to - from + Math.PI) % turn) + turn) % turn) - Math.PI;
  return from + delta * t;
}

const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

type MediumOf = Pick<CreatureSnapshot, "world" | "submersion" | "animation">;

/**
 * Whether a creature that went from `from` to `to` in one tick jumped across a bank (ADR 0020
 * §4): its medium changed, which the renderer sees as a change of submersion or animation
 * profile, and it moved further than a walk does in a tick but no further than a teleport.
 */
export function isBankJump(from: MediumOf, to: MediumOf): boolean {
  if (from.submersion === to.submersion && from.animation === to.animation) return false;
  const length = distance(from.world, to.world);
  return length >= MIN_BANK_JUMP && length <= SNAP_DISTANCE;
}

/**
 * The height `h` of the arc `y(s) = y0 + (y1 − y0)·s + 4h·s(1 − s)` from `y0` to `y1` whose
 * highest point lies `clearance` above the higher end. With `d = y1 − y0`, the parabola tops out
 * `(d + 4h)² / 16h` above `y0`; setting that to the wanted apex `A` and taking the larger root
 * gives `h = (2A − d + 2√(A(A − d))) / 4`.
 */
export function arcHeight(y0: number, y1: number, clearance: number): number {
  const d = y1 - y0;
  const apex = Math.max(0, d) + Math.max(0, clearance);
  return (2 * apex - d + 2 * Math.sqrt(apex * (apex - d))) / 4;
}

const smoothstep = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/**
 * The submersion `s` (0–1) of the way through a jump from submersion `from` to `to`: the body
 * leaves the water over the first half and enters it over the second, so it is clear at the apex.
 */
export function jumpSubmersion(from: number, to: number, s: number): number {
  return s < 0.5 ? from * (1 - smoothstep(2 * s)) : to * smoothstep(2 * s - 1);
}

/** A bank jump being drawn: where it took off, how high it arcs, and when. */
export interface Jump {
  from: Vec3;
  fromSubmersion: number;
  /** The arc's height `h` (`arcHeight`), fixed at take-off from the two ends. */
  height: number;
  startedAt: number;
  durationMs: number;
  /** Where it was last drawn, so a jump made while this one is in the air takes off from there. */
  drawn: Pick<CreaturePose, "world" | "submersion">;
}

/**
 * Where a creature is `s` (0–1) of the way through `jump` towards `pose`, its blended pose now:
 * on the straight line between them, `s` of the way along, and above it by the arc. The blended
 * pose itself only leaves the take-off over the first snapshot interval, so the arc eases in over
 * that interval and then moves at an even pace. The landing moves on as the creature does once it
 * has landed, so the arc ends exactly on the blended pose.
 */
export function jumpPose(
  jump: Pick<Jump, "from" | "fromSubmersion" | "height">,
  pose: Pick<CreaturePose, "world" | "submersion">,
  s: number,
): Pick<CreaturePose, "world" | "submersion" | "jump"> {
  const { from } = jump;
  const to = pose.world;
  return {
    world: {
      x: from.x + (to.x - from.x) * s,
      y: from.y + (to.y - from.y) * s + 4 * jump.height * s * (1 - s),
      z: from.z + (to.z - from.z) * s,
    },
    submersion: jumpSubmersion(jump.fromSubmersion, pose.submersion, s),
    jump: s,
  };
}

export class SnapshotInterpolator {
  #previous: SimulationSnapshot | undefined;
  #latest: SimulationSnapshot | undefined;
  #receivedAt = 0;
  #intervalMs: number;
  #restarting = false;
  /** Bank jumps still in the air, by creature. */
  readonly #jumps = new Map<string, Jump>();

  readonly #sizeOf: JumpSizeResolver | undefined;

  /**
   * `intervalMs` is the first guess at the time between snapshots; arrivals refine it. `sizeOf`
   * gives a species' size class, which caps how high its bank jumps arc (`jumpClearance`).
   */
  constructor(intervalMs = 100, sizeOf?: JumpSizeResolver) {
    this.#intervalMs = intervalMs;
    this.#sizeOf = sizeOf;
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
    this.#trackJumps(previous, snapshot, now);
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
    const before = new Map(this.#previous?.creatures.map((c) => [c.id, c]));
    return this.#latest.creatures.map((creature) => {
      const pose = blend(creature, before.get(creature.id), t);
      const jump = this.#jumps.get(creature.id);
      if (!jump) return pose;
      const s = (now - jump.startedAt) / jump.durationMs;
      if (!(s < 1)) {
        this.#jumps.delete(creature.id);
        return pose;
      }
      const drawn = { ...pose, ...jumpPose(jump, pose, Math.max(0, s)) };
      jump.drawn = drawn;
      return drawn;
    });
  }

  /**
   * Starts an arc for each creature that jumped a bank since `previous`, from where it took off,
   * and forgets those of creatures gone. After a break or a reset there is no previous snapshot,
   * so nothing is in the air. A jump made while the last is still in the air takes off from where
   * that one was last drawn. That happens when a water leg of no length joins two bank crossings
   * (both banks pair with the same water cell): the simulation then jumps in two ticks running.
   */
  #trackJumps(previous: SimulationSnapshot | undefined, latest: SimulationSnapshot, now: number) {
    if (!previous) {
      this.#jumps.clear();
      return;
    }
    const before = new Map(previous.creatures.map((c) => [c.id, c]));
    const present = new Set<string>();
    for (const creature of latest.creatures) {
      present.add(creature.id);
      const from = before.get(creature.id);
      if (!from || !isBankJump(from, creature)) continue;
      // Still in the air from the last jump: take off from where it is drawn, not from its landing.
      const takeOff = this.#jumps.get(creature.id)?.drawn ?? from;
      const start = { ...takeOff.world };
      const { world } = creature;
      const horizontal = Math.hypot(world.x - start.x, world.z - start.z);
      const size = this.#sizeOf?.(creature.speciesId)?.sizeClass;
      const radius = size === undefined ? undefined : SIZE_CLASSES[size].radius;
      this.#jumps.set(creature.id, {
        from: start,
        fromSubmersion: takeOff.submersion,
        height: arcHeight(start.y, world.y, jumpClearance(horizontal, radius)),
        startedAt: now,
        durationMs: Math.min(JUMP_MS, JUMP_MAX_INTERVALS * this.#intervalMs),
        drawn: { world: start, submersion: takeOff.submersion },
      });
    }
    for (const id of this.#jumps.keys()) if (!present.has(id)) this.#jumps.delete(id);
  }
}

/** The pose of `creature` `t` (0–1) of the way from `from`, its previous snapshot. */
function blend(
  creature: CreatureSnapshot,
  from: CreatureSnapshot | undefined,
  t: number,
): CreaturePose {
  const { id, speciesId, world, heading, cues, cueProgress, animation, submersion } = creature;
  if (!from || distance(from.world, world) > SNAP_DISTANCE) {
    return { id, speciesId, world, heading, cues, cueProgress, animation, submersion };
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
    submersion: from.submersion + (submersion - from.submersion) * t,
  };
}
