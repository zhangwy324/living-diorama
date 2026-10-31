import type * as THREE from "three";
import type { CueWeights } from "../cues";
import type { LocomotionInput } from "../locomotion";
import { composePose } from "./compose-pose";
import type { MotionRig } from "./motion-rig";
import { createMotionPose, writeMotion, type MotionInput, type MotionPose } from "./part-motion";

// One voxel creature's parts posed for a frame (ADR 0024 §16): the strip's creatures and the
// Studio's previews drive their parts through here, so the motion → (IK) → compose pipeline has
// one place where a later IK pass plugs in.

/** A creature's own part pose and the bone matrices it is composed into, for its species' rig. */
export interface PosedParts {
  readonly rig: MotionRig;
  readonly pose: MotionPose;
  /** Per part, in the rig's order: e.g. a skinned mesh's bones' `matrixWorld`s. */
  readonly bones: readonly THREE.Matrix4[];
}

/** A creature's parts at rest for `rig`, composed into `bones` from now on. */
export function posedParts(rig: MotionRig, bones: readonly THREE.Matrix4[]): PosedParts {
  return { rig, pose: createMotionPose(rig), bones };
}

/** A part-motion input to reuse every frame. */
export const restingMotionInput = (): MotionInput => ({
  time: 0,
  travelled: 0,
  speed: 0,
  gait: undefined,
  leap: undefined,
  phase: 0,
  height: 0,
  cues: { eating: 0, sleeping: 0, hungry: 0 },
});

/**
 * Fills `out` from what the whole-body motion is given this frame (`body`: its profile is the
 * gait), the bank leap's progress while in the air, and the cue weights, so the parts move with
 * the body. Returns it.
 */
export function motionInputFrom(
  out: MotionInput,
  body: Readonly<LocomotionInput>,
  leap: number | undefined,
  cues: CueWeights,
): MotionInput {
  out.time = body.time;
  out.travelled = body.travelled;
  out.speed = body.speed;
  out.gait = body.profile;
  out.leap = leap;
  out.phase = body.phase;
  out.height = body.height;
  out.cues = cues;
  return out;
}

/** Poses `parts` for `input` and writes their bones. Allocates nothing. */
export function posePartsFrame(parts: PosedParts, input: MotionInput): void {
  writeMotion(parts.rig, input, parts.pose);
  // The IK slot (ADR 0024 §16): a later IK pass goes here. It may override or blend
  // `parts.pose.rotations` per chain (`RigPart.parent` links) before they are composed, and may
  // keep state of its own between frames, such as foot locks. None yet: the motion's rotations
  // pass through unchanged.
  composePose(parts.rig, parts.pose, parts.bones);
}
