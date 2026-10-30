import type { VoxelAssemblyInput, VoxelPartInput } from "@living-diorama/content-schema";

// Test fixtures shared by the voxel body's and the assembly view's tests.

/** A box of `x × y × z` cubes of 2.5 cm, all of one colour. */
export function box(
  x: number,
  y: number,
  z: number,
  options: Partial<VoxelPartInput> = {},
): VoxelPartInput {
  return {
    type: "test:torso",
    size: { x, y, z },
    step: 0.025,
    colors: ["#7fae5a"],
    voxels: [x * y * z, 1],
    attach: { x: x / 2, y: 0, z: z / 2 },
    sockets: [],
    ...options,
  };
}

/**
 * An arm that tells its sides apart: 2 × 4 × 3 cubes with only one column filled at z = 0 below
 * the top row, so a reflection shows. A hand socket at its tip, a hand of the detail step on it.
 */
const ARM_VOXELS = (() => {
  const grid: number[] = [];
  for (let z = 0; z < 3; z++) {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 2; x++) grid.push(y === 3 || (z === 0 && x === 0) ? 1 : y > 0 ? 2 : 0);
    }
  }
  const runs: number[] = [];
  for (let i = 0; i < grid.length;) {
    let end = i + 1;
    while (end < grid.length && grid[end] === grid[i]) end++;
    runs.push(end - i, grid[i] ?? 0);
    i = end;
  }
  return runs;
})();

/**
 * A torso with a mirror pair of arms, each turned a quarter about X, and a hand on each arm (so
 * the right hand is reflected through its arm though its own flag is false), and a tail turned a
 * quarter about Y with a mirror pair of fins. Turns about X and Y don't commute with the
 * reflection z → −z, so the order of the mirror and the rotation matters.
 */
export function creature(): VoxelAssemblyInput {
  return {
    parts: {
      torso: box(8, 4, 6, {
        attach: { x: 4, y: 2, z: 3 },
        sockets: [
          { id: "left", type: "test:shoulder", position: { x: 6, y: 3, z: 1 } },
          {
            id: "right",
            type: "test:shoulder",
            position: { x: 6, y: 3, z: 5 },
            mirrors: "left",
          },
          { id: "tail", type: "test:tail-base", position: { x: 1, y: 2, z: 3 } },
        ],
      }),
      arm: box(2, 4, 3, {
        type: "test:arm",
        colors: ["#c08040", "#4060a0"],
        voxels: ARM_VOXELS,
        attach: { x: 1, y: 3, z: 1 },
        sockets: [{ id: "hand", type: "test:hand", position: { x: 1, y: 2, z: 1.5 } }],
      }),
      hand: box(2, 1, 3, {
        type: "test:hand",
        step: 0.0125,
        voxels: [2, 1, 4, 0],
        attach: { x: 1, y: 0, z: 1 },
      }),
      tail: box(3, 2, 4, {
        type: "test:tail",
        attach: { x: 2, y: 0, z: 2 },
        sockets: [
          { id: "a", type: "test:fin", position: { x: 1, y: 1, z: 1 } },
          { id: "b", type: "test:fin", position: { x: 1, y: 1, z: 3 }, mirrors: "a" },
        ],
      }),
      fin: box(1, 2, 1, { type: "test:fin", attach: { x: 0, y: 2, z: 0 } }),
    },
    instances: [
      { id: "torso", part: "torso" },
      {
        id: "left-arm",
        part: "arm",
        parent: { instance: "torso", socket: "left" },
        rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
      },
      {
        id: "right-arm",
        part: "arm",
        parent: { instance: "torso", socket: "right" },
        rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
        mirrored: true,
      },
      { id: "left-hand", part: "hand", parent: { instance: "left-arm", socket: "hand" } },
      { id: "right-hand", part: "hand", parent: { instance: "right-arm", socket: "hand" } },
      {
        id: "tail",
        part: "tail",
        parent: { instance: "torso", socket: "tail" },
        rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      },
      { id: "fin-a", part: "fin", parent: { instance: "tail", socket: "a" } },
      { id: "fin-b", part: "fin", parent: { instance: "tail", socket: "b" }, mirrored: true },
    ],
  };
}
