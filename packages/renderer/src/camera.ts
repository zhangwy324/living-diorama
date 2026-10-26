import type { SceneData } from "@living-diorama/simulation";
import * as THREE from "three";

// Camera limits (ADR 0007 §9): the orbit target stays over the world's footprint and the camera
// never dips below the terrain under it.

/** The camera stays at least this far above the terrain directly below it, in metres. */
export const MIN_CAMERA_CLEARANCE = 1.5;

/** Terrain height at (x, z), interpolated between samples and clamped to the grid's edge. */
export function terrainHeightAt(scene: SceneData, x: number, z: number): number {
  const { columns, rows, cellSize, heights } = scene.terrain;
  if (columns < 2 || rows < 2) return heights[0] ?? 0;
  const { min } = scene.bounds;
  const u = THREE.MathUtils.clamp((x - min.x) / cellSize, 0, columns - 1);
  const v = THREE.MathUtils.clamp((z - min.z) / cellSize, 0, rows - 1);
  const i = Math.min(Math.floor(u), columns - 2);
  const j = Math.min(Math.floor(v), rows - 2);
  const at = (a: number, b: number) => heights[b * columns + a] ?? 0;
  const fu = u - i;
  const fv = v - j;
  const top = at(i, j) * (1 - fu) + at(i + 1, j) * fu;
  const bottom = at(i, j + 1) * (1 - fu) + at(i + 1, j + 1) * fu;
  return top * (1 - fv) + bottom * fv;
}

/**
 * Applies the limits in place: moves the target back inside the world's bounds (taking the
 * camera along) and lifts the camera to its minimum clearance. Returns whether anything changed.
 */
export function limitCamera(
  scene: SceneData,
  position: THREE.Vector3,
  target: THREE.Vector3,
): boolean {
  const { min, max } = scene.bounds;
  const clamped = new THREE.Vector3(
    THREE.MathUtils.clamp(target.x, min.x, max.x),
    THREE.MathUtils.clamp(target.y, min.y, max.y),
    THREE.MathUtils.clamp(target.z, min.z, max.z),
  );
  let changed = false;
  if (!clamped.equals(target)) {
    position.add(clamped.clone().sub(target));
    target.copy(clamped);
    changed = true;
  }
  const floor = terrainHeightAt(scene, position.x, position.z) + MIN_CAMERA_CLEARANCE;
  if (position.y < floor) {
    position.y = floor;
    changed = true;
  }
  return changed;
}
