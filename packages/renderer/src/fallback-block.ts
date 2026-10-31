import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

// The grey block a creature shows until its species' voxel body is built, or when it can't be
// (ADR 0011 §8, ADR 0025 §11): its size class's height, facing +X, feet at y = 0.

/** The block's width along X, as a share of its height. */
const ASPECT = 0.75;
/**
 * The block's depth along Z, as a share of its height: fixed, the depth every drawn body had by
 * default (ADR 0025, PR 4), now that species have no thickness.
 */
const DEPTH = 0.4;
/** Its rounded edge, as a share of its height. */
const RADIUS = 0.04;
const COLOR = "#8f8a82";
const ROUGHNESS = 0.9;

export interface FallbackBlock {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Where its center of gravity and tail anchors lie, in metres (ADR 0020 §10). */
  centerOfGravity: THREE.Vector3;
  tail: THREE.Vector3;
  dispose(): void;
}

/** A neutral rounded block `height` metres tall. */
export function fallbackBlock(height: number): FallbackBlock {
  const width = height * ASPECT;
  const geometry = new RoundedBoxGeometry(
    width,
    height,
    height * DEPTH,
    2,
    height * RADIUS,
  ).translate(0, height / 2, 0);
  const material = new THREE.MeshStandardMaterial({
    color: COLOR,
    roughness: ROUGHNESS,
    // Drawn into the shadow map by its faces towards the sun, as voxel bodies are (ADR 0011 §10).
    shadowSide: THREE.FrontSide,
  });
  return {
    geometry,
    material,
    // The middle of the block, and the middle of its rear face.
    centerOfGravity: new THREE.Vector3(0, height / 2, 0),
    tail: new THREE.Vector3(-width / 2, height / 2, 0),
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
