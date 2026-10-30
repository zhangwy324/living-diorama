import { VOXEL_UNIT } from "@living-diorama/content-schema";
import * as THREE from "three";
import type { VoxelBody } from "./body";

// A species' motion rig (M22): what per-part motion needs to know about a voxel body, derived once
// per species from its rest pose and kept for its creatures. It classifies the legs from where
// their sockets are, never from content IDs, and measures every part's length, so the gait gets
// one rhythm per creature and each part's swing fits its size. A later IK pass reuses it: the
// chains are `parent` links, the attach points `origin`s.

/**
 * The motions a part type may name. Mirrors the content-schema enum of motion names (M22); the
 * wiring PR swaps this for the schema's type once that lands.
 */
export const MOTION_NAMES = ["swing", "wag", "bob", "paddle", "flop", "blink"] as const;
export type MotionName = (typeof MOTION_NAMES)[number];

/** Gives a part instance's motion by its index in the assembly, or undefined for none. */
export type MotionLookup = (partIndex: number) => MotionName | undefined;

/**
 * Which side of the body's middle plane a part hangs on: left (−Z) or right (+Z). A part on the
 * plane counts as right when it is drawn reflected (the mirrored half of a pair), else as left.
 */
export type RigSide = -1 | 1;

/** A part that swings with the gait (motion `swing`): a leg or an arm. */
export interface RigLeg {
  side: RigSide;
  /** Ahead of the centre of gravity along X. */
  front: boolean;
  /** Its cubes reach the ground in the rest pose: it carries the body. */
  grounded: boolean;
  /** Where in the gait cycle it swings, in cycles: 0 or ½, so legs alternate. */
  offset: number;
  /** Its walk swing either way, in radians: so its foot sweeps a quarter stride, capped. */
  amplitude: number;
}

/** One part instance in the rig. */
export interface RigPart {
  /** The instance it hangs from, or −1 for the root. */
  parent: number;
  /** Its motion; undefined for none, an unknown name, and the root, which the body's own motion moves. */
  motion: MotionName | undefined;
  /** Drawn reflected: its motion is mirrored, quaternion [x, y, z, w] → [−x, −y, z, w]. */
  mirrored: boolean;
  /** Its attach point, its pivot, in the body frame (metres). */
  origin: THREE.Vector3;
  /** How far its farthest cube corner lies from its attach point, in metres. */
  length: number;
  /** The body's vertical in its joint's frame: the axis a squash (blink) shortens. */
  up: THREE.Vector3;
  /** Set for a `swing` part. */
  leg: RigLeg | undefined;
}

/** A species' motion rig: the body's rest pose and what its parts' motions need. */
export interface MotionRig {
  /** Per instance, in the body's order: every part after the one it hangs from. */
  parts: readonly RigPart[];
  /** The body's rest joints, shapes and bones (`VoxelBody`), shared, never written. */
  joints: readonly THREE.Matrix4[];
  shapes: readonly THREE.Matrix4[];
  bones: readonly THREE.Matrix4[];
  /** The `swing` parts' indices, front to back. */
  legs: readonly number[];
  /** Metres the body travels per full gait cycle, in which every leg swings once each way. */
  stride: number;
  /** The body's height in metres. */
  height: number;
}

/** A leg's foot sweeps this share of the stride each way: a quarter, so a trot's feet keep pace. */
const SWEEP_PER_STRIDE = 0.25;
/** The stride is this many lengths of the longest leg: about 22° of swing for that leg. */
export const STRIDE_PER_LEG = 1.5;
/** Strides are kept within these metres, so tiny legs don't patter and huge ones don't crawl. */
export const STRIDE_RANGE = { min: 0.06, max: 0.6 } as const;
/** No motion turns a part further than this from its rest, in radians (35°). */
export const MAX_SWING = (35 * Math.PI) / 180;
/**
 * A part whose lowest cube is within this many metres of the ground contact (y = 0, ADR 0022 §21)
 * is grounded: half the finest cube, more than any part's shrink (`instanceInset`) lifts it.
 */
const GROUNDED_WITHIN = VOXEL_UNIT;
/** A point this close to the middle plane, in metres, is on it. */
const MIDDLE_PLANE = 1e-6;

const isMotion = (name: unknown): name is MotionName =>
  typeof name === "string" && (MOTION_NAMES as readonly string[]).includes(name);

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
    lowest[i] = Math.min(lowest[i] ?? Infinity, vertex.applyMatrix4(bone).y);
  }

  const parts: RigPart[] = body.joints.map((joint, i) => {
    const parent = body.parents[i] ?? -1;
    const motion = parent < 0 ? undefined : motionOf(i);
    const e = joint.elements;
    return {
      parent,
      motion: isMotion(motion) ? motion : undefined,
      mirrored: body.mirrored[i] ?? false,
      origin: new THREE.Vector3().setFromMatrixPosition(joint),
      length: lengths[i] ?? 0,
      // The joint's rotation R is proper, so Rᵀ · (0, 1, 0) is its second row.
      up: new THREE.Vector3(e[1], e[5], e[9]).normalize(),
      leg: undefined,
    };
  });

  const legs = parts.flatMap((part, i) => (part.motion === "swing" ? [i] : []));
  const centre = body.measure.centerOfGravity;
  const sideOf = (part: RigPart): RigSide =>
    part.origin.z > MIDDLE_PLANE ? 1 : part.origin.z < -MIDDLE_PLANE || !part.mirrored ? -1 : 1;
  // Front to back, then top to bottom, then in the body's order, so ties stay stable.
  const at = (i: number) => parts[i]?.origin ?? new THREE.Vector3();
  legs.sort((a, b) => at(b).x - at(a).x || at(b).y - at(a).y || a - b);
  const isGrounded = (i: number) => (lowest[i] ?? Infinity) <= GROUNDED_WITHIN;
  const grounded = legs.filter(isGrounded);
  const carrying = grounded.length > 0 ? grounded : legs;
  const longest = carrying.reduce((best, i) => Math.max(best, parts[i]?.length ?? 0), 0);
  const height = body.measure.height;
  const stride = Math.min(
    STRIDE_RANGE.max,
    Math.max(STRIDE_RANGE.min, STRIDE_PER_LEG * (longest > 0 ? longest : height / 2)),
  );

  // Grounded legs first: per side in X order, alternating, the right side half a cycle on. A
  // limb off the ground (an arm) swings against the frontmost grounded leg on its side, so with
  // the opposite leg; on a side with no grounded leg it takes its place in the X order instead.
  const rank = new Map<RigSide, number>();
  const leading = new Map<RigSide, number>();
  for (const i of [...grounded, ...legs.filter((i) => !isGrounded(i))]) {
    const part = parts[i];
    if (!part) continue;
    const side = sideOf(part);
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
    part.leg = {
      side,
      front: part.origin.x > centre.x,
      grounded: isGrounded(i),
      offset,
      amplitude: Math.min(MAX_SWING, Math.asin(Math.min(1, sweep))),
    };
  }

  return {
    parts,
    joints: body.joints,
    shapes: body.shapes,
    bones: body.bones,
    legs,
    stride,
    height,
  };
}
