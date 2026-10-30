/**
 * Mesher timings, kept out of `pnpm check`: run `pnpm tsx packages/renderer/src/voxel/mesher.bench.ts`.
 * Prints the median and worst time per case over a few hundred runs, after a warm-up.
 */
import { MAX_PART_CUBES, meshVoxelParts, type VoxelPartGrid } from "./mesher";

const N = MAX_PART_CUBES;

function fill(
  size: [number, number, number],
  at: (x: number, y: number, z: number) => number,
): VoxelPartGrid {
  const [X, Y, Z] = size;
  const voxels = new Uint8Array(X * Y * Z);
  for (let z = 0, i = 0; z < Z; z++)
    for (let y = 0; y < Y; y++) for (let x = 0; x < X; x++, i++) voxels[i] = at(x, y, z);
  return { size, voxels, colors: ["#7fae5a", "#d9a066", "#3f3f74"] };
}

/** A ball filling its box, in three colour bands. */
const ball = (n: number) =>
  fill([n, n, n], (x, y, z) => {
    const r = n / 2;
    const d = (x + 0.5 - r) ** 2 + (y + 0.5 - r) ** 2 + (z + 0.5 - r) ** 2;
    return d <= r * r ? 1 + (y % 3) : 0;
  });

const cases: [string, VoxelPartGrid[]][] = [
  ["32³ solid", [fill([N, N, N], () => 1)]],
  ["32³ ball", [ball(N)]],
  // Deterministic half-filled noise: many open faces and every occlusion case.
  [
    "32³ noise",
    [fill([N, N, N], (x, y, z) => (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) >> 5) & 1)],
  ],
  ["32³ checkerboard (most faces)", [fill([N, N, N], (x, y, z) => (x + y + z) % 2)]],
  [
    // About a creature: 16³ torso, 12³ head, four 6×12×6 legs, a tail and two 2³ eyes.
    "9-part creature",
    [
      ball(16),
      ball(12),
      ...Array.from({ length: 4 }, () => fill([6, 12, 6], () => 1)),
      fill([12, 4, 4], () => 2),
      fill([2, 2, 2], () => 3),
      fill([2, 2, 2], () => 3),
    ],
  ],
];

for (const [name, parts] of cases) {
  for (let i = 0; i < 20; i++) meshVoxelParts(parts);
  const times: number[] = [];
  let vertices = 0;
  for (let i = 0; i < 200; i++) {
    const start = performance.now();
    vertices = meshVoxelParts(parts).vertexCount;
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = (times[times.length >> 1] ?? 0).toFixed(2);
  const worst = (times[times.length - 1] ?? 0).toFixed(2);
  console.log(`${name}: median ${median} ms, worst ${worst} ms, ${vertices} vertices`);
}
