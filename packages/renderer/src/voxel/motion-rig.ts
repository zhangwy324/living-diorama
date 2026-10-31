import {
  PART_MOTIONS,
  VOXEL_UNIT,
  type PartMotion,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import type { WalkLegs } from "../locomotion";
import type { PartMotionResolver, VoxelBody } from "./body";

// A species' motion rig (M22): what per-part motion needs to know about a voxel body, derived once
// per species from its rest pose and kept for its creatures. It classifies the legs from where
// their sockets are, never from content IDs, and measures every part's length, so the gait gets
// one rhythm per creature and each part's swing fits its size. A later IK pass reuses it: the
// chains are `parent` links, the attach points `origin`s.

/** Gives a part instance's motion by its index in the assembly, or undefined for none. */
export type MotionLookup = (partIndex: number) => PartMotion | undefined;

/**
 * Which side of the root part's middle plane a part hangs on: left (−Z) or right (+Z), by its
 * attach point. A part on the plane counts as right when it is drawn reflected (the mirrored half
 * of a pair), else as left (ADR 0024 §11).
 */
export type RigSide = -1 | 1;

/** A part that swings with the gait (motion `swing`): a leg or an arm. */
export interface RigLeg {
  /** Ahead of the centre of gravity along X. */
  readonly front: boolean;
  /** Its lowest cube lies at the ground contact in the rest pose: it carries the body. */
  readonly grounded: boolean;
  /** Where in the gait cycle it swings, in cycles: 0 or ½, so legs alternate. */
  readonly offset: number;
  /**
   * Its walk swing either way, in radians: so its foot sweeps a quarter stride, capped at
   * `MAX_SWING`; an arm (a limb off the ground beside grounded legs) swings `ARM_SWING` of that.
   */
  readonly amplitude: number;
}

/** One part instance in the rig. Shared by a species' creatures: never written after building. */
export interface RigPart {
  /** The instance it hangs from, or −1 for the root. */
  readonly parent: number;
  /** Its motion; undefined for none, an unknown name, and the root, which the body's own motion moves. */
  readonly motion: PartMotion | undefined;
  /** Drawn reflected: its motion is mirrored, quaternion [x, y, z, w] → [−x, −y, z, w]. */
  readonly mirrored: boolean;
  readonly side: RigSide;
  /** Its attach point, its pivot, in the body frame (metres). */
  readonly origin: Readonly<THREE.Vector3>;
  /** How far its farthest cube corner lies from its attach point, in metres. */
  readonly length: number;
  /** The body's vertical in its joint's frame: the axis a squash (blink) shortens. */
  readonly up: Readonly<THREE.Vector3>;
  /** Set for a `swing` part. */
  readonly leg: RigLeg | undefined;
}

/** A species' motion rig: the body's rest pose and what its parts' motions need. */
export interface MotionRig {
  /** Per instance, in the body's order: every part after the one it hangs from. */
  readonly parts: readonly RigPart[];
  /** The body's rest joints, shapes and bones (`VoxelBody`), shared, never written. */
  readonly joints: readonly THREE.Matrix4[];
  readonly shapes: readonly THREE.Matrix4[];
  readonly bones: readonly THREE.Matrix4[];
  /** The `swing` parts' indices, front to back. */
  readonly legs: readonly number[];
  /** Metres the body travels per full gait cycle, in which every leg swings once each way. */
  readonly stride: number;
}

/** A leg's foot sweeps this share of the stride each way: a quarter, so a trot's feet keep pace. */
const SWEEP_PER_STRIDE = 0.25;
/**
 * The cadence, in steps per second at `speed` (metres per second, every species' base speed
 * today), is a leg's own swing as a pendulum, √(g ÷ length) ÷ π, kept within `min` and `max`:
 * a leg shorter than about 25 cm steps at `max`, a longer one slower. The stride grows to match,
 * so a short-legged creature takes long strides rather than pattering, and swings its legs up to
 * `MAX_SWING`. A creature moving faster or slower than `speed` steps faster or slower in
 * proportion, since the gait follows the distance travelled.
 */
export const WALK_CADENCE = { speed: 0.6, min: 0.8, max: 2 } as const;
/** Metres per second², for the pendulum. */
const GRAVITY = 9.81;
/** No motion turns a part further than this from its rest, in radians (45°). */
export const MAX_SWING = (45 * Math.PI) / 180;
/**
 * A limb off the ground (an arm) swings through this share of what a leg its length would, so arms
 * stay smaller than the legs they swing against. With no grounded limb, limbs swing in full.
 */
export const ARM_SWING = 0.6;
/**
 * A part whose lowest cube is within this many metres of the ground contact (y = 0, ADR 0022 §21)
 * is grounded: half the finest cube, more than any part's shrink (`instanceInset`) lifts it.
 */
const GROUNDED_WITHIN = VOXEL_UNIT;
/** A point this close to the middle plane, in metres, is on it. */
const MIDDLE_PLANE = 1e-6;

const isMotion = (name: unknown): name is PartMotion =>
  typeof name === "string" && (PART_MOTIONS as readonly string[]).includes(name);

const vertex = new THREE.Vector3();
const point = new THREE.Vector3();

/**
 * The motion rig of a voxel body: per part its motion from `motionOf` (by instance index), its
 * length and its attach point, and for the limbs (`swing` parts) their side, front or back, and
 * place in the gait. Grounded legs alternate per side in X order, front first, and the right side
 * starts half a cycle after the left: two legs alternate, four trot in diagonal pairs, six walk in
 * tripods. Limbs off the ground (arms) swing with the opposite side's legs. The stride follows
 * the longest grounded leg (the longest limb when none is grounded, half the body's height when
 * there are none). Pure: it reads the body and allocates the rig.
 */
export function buildMotionRig(body: VoxelBody, motionOf: MotionLookup): MotionRig {
  const count = body.joints.length;
  const lengths = new Array<number>(count).fill(0);
  const lowest = new Array<number>(count).fill(Infinity);
  // The root's cubes across Z in the body frame: its middle plane is the creature's own.
  let rootMin = Infinity;
  let rootMax = -Infinity;
  // Every cube corner on a visible face is a vertex, and the farthest corner of a part, or its
  // lowest, is always on its surface.
  const positions = body.geometry.getAttribute("position");
  const skin = body.geometry.getAttribute("skinIndex");
  for (let v = 0; v < positions.count; v++) {
    const i = skin.getX(v);
    const shape = body.shapes[i];
    const bone = body.bones[i];
    if (!shape || !bone) continue;
    vertex.fromBufferAttribute(positions, v);
    point.copy(vertex).applyMatrix4(shape);
    lengths[i] = Math.max(lengths[i] ?? 0, point.length());
    vertex.applyMatrix4(bone);
    lowest[i] = Math.min(lowest[i] ?? Infinity, vertex.y);
    if ((body.parents[i] ?? -1) < 0) {
      rootMin = Math.min(rootMin, vertex.z);
      rootMax = Math.max(rootMax, vertex.z);
    }
  }
  const middle = Number.isFinite(rootMin) ? (rootMin + rootMax) / 2 : 0;
  const sideOf = (z: number, mirrored: boolean): RigSide =>
    z - middle > MIDDLE_PLANE ? 1 : z - middle < -MIDDLE_PLANE ? -1 : mirrored ? 1 : -1;

  // Built here, then frozen behind `RigPart`'s readonly fields.
  type Building = { -readonly [K in keyof RigPart]: RigPart[K] };
  const parts: Building[] = body.joints.map((joint, i) => {
    const parent = body.parents[i] ?? -1;
    const motion = parent < 0 ? undefined : motionOf(i);
    const e = joint.elements;
    const origin = new THREE.Vector3().setFromMatrixPosition(joint);
    const mirrored = body.mirrored[i] ?? false;
    return {
      parent,
      motion: isMotion(motion) ? motion : undefined,
      mirrored,
      side: sideOf(origin.z, mirrored),
      origin,
      length: lengths[i] ?? 0,
      // The joint's rotation R is proper, so Rᵀ · (0, 1, 0) is its second row.
      up: new THREE.Vector3(e[1], e[5], e[9]).normalize(),
      leg: undefined,
    };
  });

  const legs = parts.flatMap((part, i) => (part.motion === "swing" ? [i] : []));
  const centre = body.measure.centerOfGravity;
  // Front to back, then top to bottom, then in the body's order, so ties stay stable.
  const at = (i: number) => parts[i]?.origin ?? new THREE.Vector3();
  legs.sort((a, b) => at(b).x - at(a).x || at(b).y - at(a).y || a - b);
  const isGrounded = (i: number) => (lowest[i] ?? Infinity) <= GROUNDED_WITHIN;
  const grounded = legs.filter(isGrounded);
  const carrying = grounded.length > 0 ? grounded : legs;
  const longest = carrying.reduce((best, i) => Math.max(best, parts[i]?.length ?? 0), 0);
  const stride = strideFor(longest > 0 ? longest : body.measure.height / 2);

  // Grounded legs first: per side in X order, alternating, the right side half a cycle on. A
  // limb off the ground (an arm) swings against the frontmost grounded leg on its side, so with
  // the opposite leg; on a side with no grounded leg it takes its place in the X order instead.
  const rank = new Map<RigSide, number>();
  const leading = new Map<RigSide, number>();
  for (const i of [...grounded, ...legs.filter((i) => !isGrounded(i))]) {
    const part = parts[i];
    if (!part) continue;
    const side = part.side;
    const lead = leading.get(side);
    let offset: number;
    if (!isGrounded(i) && lead !== undefined) offset = (lead + 0.5) % 1;
    else {
      const n = rank.get(side) ?? 0;
      rank.set(side, n + 1);
      offset = ((n + (side === 1 ? 1 : 0)) % 2) * 0.5;
      if (isGrounded(i) && lead === undefined) leading.set(side, offset);
    }
    const sweep = (SWEEP_PER_STRIDE * stride) / Math.max(part.length, 1e-6);
    const swing = Math.min(MAX_SWING, Math.asin(Math.min(1, sweep)));
    part.leg = {
      front: part.origin.x > centre.x,
      grounded: isGrounded(i),
      offset,
      amplitude: isGrounded(i) || grounded.length === 0 ? swing : ARM_SWING * swing,
    };
  }

  return {
    parts,
    joints: body.joints,
    shapes: body.shapes,
    bones: body.bones,
    legs,
    stride,
  };
}

/**
 * The stride, in metres per full gait cycle (two steps), of legs `length` metres long: at
 * `WALK_CADENCE.speed` they step at their pendulum cadence, within `WALK_CADENCE`'s range.
 */
export function strideFor(length: number): number {
  const pendulum = Math.sqrt(GRAVITY / Math.max(length, 1e-6)) / Math.PI;
  const cadence = Math.min(WALK_CADENCE.max, Math.max(WALK_CADENCE.min, pendulum));
  return (2 * WALK_CADENCE.speed) / cadence;
}

/**
 * The motion of each part instance of `assembly` by its index, from its part's type through
 * `partMotion` (ADR 0024 §8), for `buildMotionRig`. Without a resolver no part moves.
 */
export function instanceMotions(
  assembly: VoxelAssembly,
  partMotion: PartMotionResolver | undefined,
): MotionLookup {
  return (i) => {
    const instance = assembly.instances[i];
    const part = instance ? assembly.parts[instance.part] : undefined;
    return part ? partMotion?.(part.type) : undefined;
  };
}

/** How many weights `walkLegs` measures the drop at, from 0 to 1 evenly. */
export const WALK_DIP_SAMPLES = 9;

/**
 * What the walk profile needs to keep the whole body in step with `rig`'s legs (ADR 0024 §5):
 * metres per step, half the stride, and how far the body should drop as the legs swing out in
 * full, so the lowest foot stays on the ground. A swung leg's heel lifts but its toe sinks, so
 * this is measured on the cubes of every grounded leg of `body` (the body `rig` was built from),
 * and of the parts hanging from it, swung either way about its attach point: negative, a rise,
 * when a toe would sink further than any foot lifts. The gait's weight scales a leg's swing, and
 * the drop isn't proportional to the angle, so it is measured at `WALK_DIP_SAMPLES` weights.
 *
 * A leg is grounded by its own cubes (`RigLeg.grounded`), so a leg whose foot is a separate part
 * hanging from it isn't grounded, and a body whose legs are all like that doesn't dip. A rig with
 * no grounded leg doesn't dip. Reads the body's vertices: once per species.
 */
export function walkLegs(body: VoxelBody, rig: MotionRig): WalkLegs {
  const { parts } = rig;
  // Each part's grounded leg: itself, or the nearest `swing` part it hangs from, if grounded.
  const legOf = parts.map((_, i) => {
    let j = i;
    while (j >= 0 && !parts[j]?.leg) j = parts[j]?.parent ?? -1;
    return j >= 0 && parts[j]?.leg?.grounded ? j : -1;
  });
  const positions = body.geometry.getAttribute("position");
  const skin = body.geometry.getAttribute("skinIndex");
  const rest = new Map<number, number>();
  const swung = new Map<number, number[]>();
  for (let v = 0; v < positions.count; v++) {
    const i = skin.getX(v);
    const leg = legOf[i] ?? -1;
    const part = parts[leg];
    const bone = rig.bones[i];
    if (!part?.leg || !bone) continue;
    vertex.fromBufferAttribute(positions, v).applyMatrix4(bone);
    rest.set(leg, Math.min(rest.get(leg) ?? Infinity, vertex.y));
    // Turned about Z through the leg's attach point, as `swing` turns it, either way.
    const x = vertex.x - part.origin.x;
    const y = vertex.y - part.origin.y;
    const lows = swung.get(leg) ?? new Array<number>(WALK_DIP_SAMPLES).fill(Infinity);
    for (let k = 0; k < WALK_DIP_SAMPLES; k++) {
      const a = (part.leg.amplitude * k) / (WALK_DIP_SAMPLES - 1);
      const low = part.origin.y - Math.abs(x * Math.sin(a)) + y * Math.cos(a);
      lows[k] = Math.min(lows[k] ?? Infinity, low);
    }
    swung.set(leg, lows);
  }
  const dips = Array.from({ length: WALK_DIP_SAMPLES }, (_, k) => {
    let drop = Infinity;
    for (const [leg, lows] of swung) drop = Math.min(drop, (lows[k] ?? 0) - (rest.get(leg) ?? 0));
    return Number.isFinite(drop) ? drop : 0;
  });
  return { step: rig.stride / 2, dips };
}
