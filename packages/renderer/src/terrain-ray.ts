import type { SceneData } from "@living-diorama/simulation";
import * as THREE from "three";

// Rays against the terrain heightfield, without raycasting its mesh: a walk along the ray in
// steps of a quarter cell, refined by bisection. The height is that of the drawn triangles, so
// hits lie on the mesh `terrainMesh` builds.

/** Ray steps per terrain cell. A peak narrower than this could be stepped over. */
const STEPS_PER_CELL = 4;
/** Bisection rounds; each halves the step, so 20 rounds is far below a millimetre. */
const BISECTIONS = 20;
/** At most this many steps, whatever the world's size. */
const MAX_STEPS = 20_000;

/**
 * The height of the terrain's drawn surface at (x, z): linear over each of the two triangles a
 * cell is split into along its v00–v11 diagonal, as `terrainMesh` draws it. Clamped to the grid.
 */
export function terrainSurfaceHeightAt(scene: SceneData, x: number, z: number): number {
  const { columns, rows, cellSize, heights } = scene.terrain;
  if (columns < 2 || rows < 2) return heights[0] ?? 0;
  const { min } = scene.bounds;
  const u = THREE.MathUtils.clamp((x - min.x) / cellSize, 0, columns - 1);
  const v = THREE.MathUtils.clamp((z - min.z) / cellSize, 0, rows - 1);
  const i = Math.min(Math.floor(u), columns - 2);
  const j = Math.min(Math.floor(v), rows - 2);
  const k = j * columns + i;
  const fu = u - i;
  const fv = v - j;
  const h00 = heights[k] ?? 0;
  const h10 = heights[k + 1] ?? 0;
  const h01 = heights[k + columns] ?? 0;
  const h11 = heights[k + columns + 1] ?? 0;
  return fu >= fv
    ? h00 + fu * (h10 - h00) + fv * (h11 - h10)
    : h00 + fv * (h01 - h00) + fu * (h11 - h01);
}

const ranges = new WeakMap<SceneData["terrain"], readonly [number, number]>();

/** The lowest and highest terrain sample, worked out once per terrain. */
function heightRange(terrain: SceneData["terrain"]): readonly [number, number] {
  let range = ranges.get(terrain);
  if (!range) {
    let low = Infinity;
    let high = -Infinity;
    for (const h of terrain.heights) {
      low = Math.min(low, h);
      high = Math.max(high, h);
    }
    range = [low, high];
    ranges.set(terrain, range);
  }
  return range;
}

export interface TerrainHit {
  point: THREE.Vector3;
  distance: number;
}

/**
 * Where `ray` first comes down onto the terrain's top surface inside the world's bounds, as a
 * front-face raycast of its mesh would find, skipping hits `accept` turns down (e.g. clipped
 * away). Undefined if it never does.
 */
export function terrainRayHit(
  scene: SceneData,
  ray: THREE.Ray,
  accept: (point: THREE.Vector3) => boolean = () => true,
): TerrainHit | undefined {
  const { origin: o, direction: d } = ray;
  const { min, max } = scene.bounds;
  const { cellSize } = scene.terrain;
  const [low, high] = heightRange(scene.terrain);
  if (!Number.isFinite(low)) return undefined;

  // The stretch of the ray over the world's footprint and between the lowest and highest ground.
  let from = 0;
  let to = Infinity;
  const slab = (origin: number, direction: number, lo: number, hi: number) => {
    if (Math.abs(direction) < 1e-12) {
      if (origin < lo || origin > hi) to = -Infinity;
      return;
    }
    const a = (lo - origin) / direction;
    const b = (hi - origin) / direction;
    from = Math.max(from, Math.min(a, b));
    to = Math.min(to, Math.max(a, b));
  };
  slab(o.x, d.x, min.x, max.x);
  slab(o.z, d.z, min.z, max.z);
  // A hair beyond the extremes, so a ray meeting the highest or lowest ground still crosses it.
  slab(o.y, d.y, low - 1e-3, high + 1e-3);
  if (!(from <= to) || !Number.isFinite(to)) return undefined;

  const horizontal = Math.hypot(d.x, d.z) * (to - from);
  const steps = Math.min(
    MAX_STEPS,
    Math.max(1, Math.ceil((horizontal * STEPS_PER_CELL) / cellSize)),
  );
  const dt = (to - from) / steps;
  const above = (t: number) =>
    o.y + d.y * t - terrainSurfaceHeightAt(scene, o.x + d.x * t, o.z + d.z * t);

  let t0 = from;
  let f0 = above(t0);
  for (let n = 1; n <= steps; n++) {
    const t1 = n === steps ? to : from + n * dt;
    const f1 = above(t1);
    // Coming down through the surface, as a front face is met.
    if (f0 > 0 && f1 <= 0) {
      let a = t0;
      let b = t1;
      for (let r = 0; r < BISECTIONS; r++) {
        const m = (a + b) / 2;
        if (above(m) > 0) a = m;
        else b = m;
      }
      const point = ray.at(b, new THREE.Vector3());
      if (accept(point)) return { point, distance: b };
    }
    t0 = t1;
    f0 = f1;
  }
  return undefined;
}
