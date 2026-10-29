import type { Vec3 } from "@living-diorama/content-schema";
import * as THREE from "three";
import { SNAP_SECONDS } from "./cues";
import { SNAP_DISTANCE } from "./interpolation";

// Whole-body animation per locomotion profile (ADR 0020 §8): a walk's bob and waddle, a hop's
// squash and arc, a swim's sway and bob. Only whole-body transforms, no bones or bending. This
// module is the one place that turns a profile into motion, so per-part animation can replace it
// by swapping `trackMovement`, `locomotionMotion` and `locomotionTransform`. Profiles are plain names from the snapshot;
// the renderer never sees the capabilities behind them.

/** How a creature has been moving, carried from frame to frame. */
export interface Movement {
  /** Where it was last frame, or undefined before the first frame and after a break. */
  last: Vec3 | undefined;
  /** Metres per second, smoothed so a late snapshot doesn't make it stutter. */
  speed: number;
  /** Metres moved so far: drives the gait, so steps keep pace with the ground. */
  travelled: number;
}

export const restingMovement = (): Movement => ({ last: undefined, speed: 0, travelled: 0 });

/** Seconds the speed takes to follow a change by about two thirds. */
const SPEED_SMOOTHING = 0.2;

/**
 * Moves `movement` on to the creature's position `world` after `dt` seconds of animation time.
 * A teleport or a break (a gap longer than `SNAP_SECONDS`) starts afresh at rest. While no
 * animation time passes (the simulation is paused) the speed and distance hold, so the pose holds,
 * and the last of the blend towards the newest snapshot is taken as it is rather than counted as a
 * dash on resuming. Mutates and returns it.
 */
export function trackMovement(movement: Movement, world: Vec3, dt: number): Movement {
  if (!(dt >= 0)) dt = 0;
  const last = movement.last;
  const distance = last ? Math.hypot(world.x - last.x, world.y - last.y, world.z - last.z) : 0;
  if (!last || dt > SNAP_SECONDS || distance > SNAP_DISTANCE) {
    movement.last = { x: world.x, y: world.y, z: world.z };
    movement.speed = 0;
    return movement;
  }
  last.x = world.x;
  last.y = world.y;
  last.z = world.z;
  if (dt === 0) return movement;
  movement.speed += (distance / dt - movement.speed) * (1 - Math.exp(-dt / SPEED_SMOOTHING));
  movement.travelled += movement.speed * dt;
  return movement;
}

/** What a profile animates from. */
export interface LocomotionInput {
  /** The snapshot's animation profile, e.g. "walk", "hop", "swim". Unknown or none: no motion. */
  profile: string | undefined;
  /** Metres per second (`Movement.speed`). At rest the body is still. */
  speed: number;
  /** Metres moved so far (`Movement.travelled`). */
  travelled: number;
  /** Animation time in seconds. */
  time: number;
  /** The creature's own 0–1 phase, so neighbours don't move in step. */
  phase: number;
  /** The body's height in metres: bigger bodies take longer steps. */
  height: number;
}

/**
 * The body's pose for its way of moving, relative to its plain pose. Turns and scales are about
 * `pivot`, a point on the body; the lift moves it all.
 */
export interface LocomotionMotion {
  /** Rise, as a share of the body's height. Negative sinks it (only in water). */
  lift: number;
  /** Forward tilt in radians; positive dips the drawing's front (+X). */
  pitch: number;
  /** Sideways lean in radians about the drawing's forward axis; positive leans to its right. */
  roll: number;
  /** Turn in radians about the vertical, on top of the heading; positive turns it left. */
  yaw: number;
  scaleY: number;
  /** Horizontal scale, along the drawing and its depth. */
  scaleXZ: number;
  /** The point the body turns and scales about (`LocomotionBody.pivots`). */
  pivot: LocomotionPivot;
}

/**
 * Where a body turns and scales: on land about the ground below its center of gravity; in water
 * about a point near its front, so its tail sweeps from side to side like a fish's. Both come from
 * the anchors (ADR 0020 §10).
 */
export type LocomotionPivot = "centerOfGravity" | "front";

export const restingLocomotion = (): LocomotionMotion => ({
  lift: 0,
  pitch: 0,
  roll: 0,
  yaw: 0,
  scaleY: 1,
  scaleXZ: 1,
  pivot: "centerOfGravity",
});

/** Moving at this many metres per second or faster shows a profile in full; slower, less. */
export const FULL_MOTION_SPEED = 0.3;

const TAU = 2 * Math.PI;
const smooth = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Metres per cycle for a body `height` tall: bigger bodies take longer strides, but not in step. */
const cycle = (base: number, perHeight: number, height: number) => base + perHeight * height;

type Profile = (input: LocomotionInput, weight: number, out: LocomotionMotion) => void;

// The walk: a bob up each step, a waddle from side to side over two, a slight lean into the walk,
// and a small squash as each foot lands. About the center of gravity.
const WALK_STEP = { base: 0.15, perHeight: 0.4 };
const WALK_BOB = 0.05;
const WALK_ROLL = 0.07;
const WALK_LEAN = 0.04;
const WALK_SQUASH = 0.04;

const walk: Profile = (input, w, out) => {
  const steps = input.travelled / cycle(WALK_STEP.base, WALK_STEP.perHeight, input.height);
  const stride = Math.sin(Math.PI * steps); // −1–1 over two steps
  const landing = 0.5 + 0.5 * Math.cos(TAU * steps); // 1 as each foot lands
  out.lift = w * WALK_BOB * (1 - landing);
  out.roll = w * WALK_ROLL * stride;
  out.pitch = w * WALK_LEAN;
  out.scaleY = 1 - w * WALK_SQUASH * landing;
  out.scaleXZ = 1 + w * WALK_SQUASH * 0.5 * landing;
  out.pivot = "centerOfGravity";
};

// The hop: on the ground the body squashes as it lands and stays low as it gathers for the next
// jump; in the air it stretches as it leaves and as it comes down, rising and falling in an arc,
// nose up then nose down. About the center of gravity.
const HOP_LENGTH = { base: 0.3, perHeight: 0.6 };
/** Share of each hop spent on the ground. */
const HOP_GROUND = 0.3;
const HOP_HEIGHT = 0.35;
const HOP_SQUASH = 0.16;
const HOP_STRETCH = 0.08;
const HOP_PITCH = 0.12;

const hop: Profile = (input, w, out) => {
  const hops = input.travelled / cycle(HOP_LENGTH.base, HOP_LENGTH.perHeight, input.height);
  const u = hops - Math.floor(hops);
  out.roll = 0;
  out.pivot = "centerOfGravity";
  if (u < HOP_GROUND) {
    const squash = w * HOP_SQUASH * Math.sin((Math.PI * u) / HOP_GROUND);
    out.lift = 0;
    out.pitch = 0;
    out.scaleY = 1 - squash;
    out.scaleXZ = 1 + squash * 0.5;
    return;
  }
  const a = (u - HOP_GROUND) / (1 - HOP_GROUND); // 0–1 through the air
  const stretch = w * HOP_STRETCH * Math.sin(TAU * a) ** 2;
  out.lift = w * HOP_HEIGHT * 4 * a * (1 - a);
  out.pitch = -w * HOP_PITCH * Math.sin(TAU * a);
  out.scaleY = 1 + stretch;
  out.scaleXZ = 1 - stretch * 0.5;
};

// The swim: the body sways from side to side about a point near its front, so the tail sweeps
// like a fish's, and rocks a little with it; the sway follows the speed. It bobs gently on its own
// slower time whether it moves or not, floating.
const SWIM_SWAY = { base: 0.4, perHeight: 0.8 };
const SWIM_YAW = 0.18;
const SWIM_ROLL = 0.05;
const SWIM_BOB = 0.03;
const SWIM_BOB_PERIOD = 2.2;

const swim: Profile = (input, w, out) => {
  const sways = input.travelled / cycle(SWIM_SWAY.base, SWIM_SWAY.perHeight, input.height);
  out.yaw = w * SWIM_YAW * Math.sin(TAU * sways);
  out.roll = -w * SWIM_ROLL * Math.cos(TAU * sways);
  out.lift = SWIM_BOB * Math.sin(TAU * (input.time / SWIM_BOB_PERIOD + input.phase));
  out.pitch = 0;
  out.scaleY = 1;
  out.scaleXZ = 1;
  out.pivot = "front";
};

/** The profiles by name. A name not here draws no motion (ADR 0020 §8). */
const PROFILES: Readonly<Record<string, Profile>> = { walk, hop, swim };

/**
 * The body's motion for its way of moving. Writes into `out` and returns it, so the frame loop
 * allocates nothing. For an unknown profile it is the resting motion; at rest a profile shows
 * only what it does standing still, which for `swim` is its bob and for the others nothing.
 */
export function locomotionMotion(input: LocomotionInput, out: LocomotionMotion): LocomotionMotion {
  const name = input.profile;
  // Own names only, so "toString" is as unknown as any other name.
  const profile = name !== undefined && Object.hasOwn(PROFILES, name) ? PROFILES[name] : undefined;
  const weight = smooth(input.speed / FULL_MOTION_SPEED);
  out.lift = 0;
  out.pitch = 0;
  out.roll = 0;
  out.yaw = 0;
  out.scaleY = 1;
  out.scaleXZ = 1;
  out.pivot = "centerOfGravity";
  // Each profile scales its moving parts by the weight, so at rest they vanish.
  profile?.(input, weight, out);
  return out;
}

/** What the transform needs to know about a body, in its own metres: feet at the origin, facing +X. */
export interface LocomotionBody {
  height: number;
  /** How far the body reaches back (negative) and forward along X. */
  minX: number;
  maxX: number;
  /** From the middle plane to the front or back face. */
  halfDepth: number;
  /** The pivots on the body, as `placePivots` puts them. */
  pivots: Readonly<Record<LocomotionPivot, THREE.Vector3>>;
}

/** The swim's pivot sits this share of the way from the front back towards the tail. */
const FRONT_PIVOT_INSET = 0.25;

/**
 * Puts the pivots of `body` (its `minX` and `maxX` set) from its center of gravity and tail
 * anchors, in its metres. The body rocks and squashes about the ground below its center of
 * gravity, so wherever that is placed on the body only its x is taken. The front pivot lies on
 * the line from the tail through the body, a little behind the front: the tail mirrored onto the
 * front, moved back by `FRONT_PIVOT_INSET`.
 */
export function placePivots(
  body: LocomotionBody,
  centerOfGravity: THREE.Vector3,
  tail: THREE.Vector3,
): void {
  body.pivots.centerOfGravity.set(centerOfGravity.x, 0, centerOfGravity.z);
  const front = body.minX + body.maxX - tail.x;
  body.pivots.front.set(front + (tail.x - front) * FRONT_PIVOT_INSET, tail.y, tail.z);
}

const turn = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, "YZX");
const scale = new THREE.Vector3();
const unpivot = new THREE.Matrix4();

/**
 * Writes into `out` the body's turn and scale for `motion` about its pivot, in the body's own
 * frame: the yaw about the vertical, the pitch about the depth axis, the roll about the drawing's
 * forward axis. Returns how far to lift the body, in metres: the motion's own lift plus, for a tilt
 * about the center of gravity, enough that its front, rear or side doesn't dip into the ground.
 * Turns about another pivot happen in water, where nothing needs lifting.
 */
export function locomotionTransform(
  motion: LocomotionMotion,
  body: LocomotionBody,
  out: THREE.Matrix4,
): number {
  const pivot = body.pivots[motion.pivot];
  euler.set(motion.roll, motion.yaw, -motion.pitch);
  out.compose(
    pivot,
    turn.setFromEuler(euler),
    scale.set(motion.scaleXZ, motion.scaleY, motion.scaleXZ),
  );
  out.multiply(unpivot.makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  return motion.lift * body.height + groundClearance(motion, body, pivot);
}

/** How far a body tilted about the ground point `pivot` would dip below the ground. */
function groundClearance(motion: LocomotionMotion, body: LocomotionBody, pivot: THREE.Vector3) {
  if (motion.pivot !== "centerOfGravity") return 0;
  const { pitch, roll, scaleXZ } = motion;
  // Measured from the pivot, since the center of gravity may be placed anywhere along the body.
  const front = Math.max(0, body.maxX - pivot.x);
  const back = Math.max(0, pivot.x - body.minX);
  const tilt = (pitch >= 0 ? front : back) * Math.sin(Math.abs(pitch));
  return (tilt + body.halfDepth * Math.abs(Math.sin(roll))) * scaleXZ;
}
