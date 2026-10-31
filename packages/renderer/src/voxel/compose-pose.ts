import * as THREE from "three";
import type { MotionRig } from "./motion-rig";
import type { MotionPose } from "./part-motion";

// The pose composer (M22): turns a `MotionPose`'s local joint rotations into bone matrices, down
// the joint chain. A part turns about its attach point, in the body frame's axes, after its rest
// joint; its children turn with it through the joints alone, so no parent's step, shrink or
// squash passes to a child (ADR 0022, "Joints, for M22"). bone = turn · joint · squash · shape.

const rotation = new THREE.Matrix4();
const quaternion = new THREE.Quaternion();
const squashMatrix = new THREE.Matrix4();
const turned = new THREE.Vector3();

/**
 * Writes each part's bone matrix for `pose` into `bones` (one per part, in the rig's order: a
 * skeleton's bones' `matrixWorld`, say), and each part's turn from its rest pose into
 * `pose.turns`. At rest every bone is its rest bone. Allocates nothing.
 */
export function composePose(
  rig: MotionRig,
  pose: MotionPose,
  bones: readonly THREE.Matrix4[],
): void {
  const { rotations, squash, turns } = pose;
  const parts = rig.parts;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const turnMatrix = turns[i];
    if (!part || !turnMatrix) continue;
    // The turn about the attach point o: R, then the translation o − R · o.
    rotation.makeRotationFromQuaternion(quaternion.fromArray(rotations, 4 * i));
    const o = part.origin;
    turned.copy(o).applyMatrix4(rotation);
    rotation.setPosition(o.x - turned.x, o.y - turned.y, o.z - turned.z);
    // Parents come first, so the parent's turn is already this frame's.
    const parentTurn = part.parent >= 0 ? turns[part.parent] : undefined;
    if (parentTurn) turnMatrix.multiplyMatrices(parentTurn, rotation);
    else turnMatrix.copy(rotation);
    const bone = bones[i];
    const rest = rig.bones[i];
    const joint = rig.joints[i];
    const shape = rig.shapes[i];
    if (!bone || !rest || !joint || !shape) continue;
    const s = squash[i] ?? 1;
    if (s === 1) {
      bone.multiplyMatrices(turnMatrix, rest);
      continue;
    }
    bone.multiplyMatrices(turnMatrix, joint);
    bone.multiply(squashAlong(part.up, s, squashMatrix));
    bone.multiply(shape);
  }
}

/** A scale by `s` along the unit `axis` about the joint's origin, the attach point: I + (s − 1) · a · aᵀ. */
function squashAlong(axis: THREE.Vector3, s: number, out: THREE.Matrix4): THREE.Matrix4 {
  const k = s - 1;
  const { x: a, y: b, z: c } = axis;
  const m00 = 1 + k * a * a;
  const m01 = k * a * b;
  const m02 = k * a * c;
  const m11 = 1 + k * b * b;
  const m12 = k * b * c;
  const m22 = 1 + k * c * c;
  return out.set(m00, m01, m02, 0, m01, m11, m12, 0, m02, m12, m22, 0, 0, 0, 0, 1);
}
