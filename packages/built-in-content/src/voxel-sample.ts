import {
  encodeVoxels,
  IDENTITY_QUATERNION,
  voxelIndex,
  type VoxelAssembly,
  type VoxelPart,
  type VoxelSize,
} from "@living-diorama/content-schema";

// A sample voxel creature built in code (ADR 0022, M19 decisions: fixtures, not content), for the
// app's development console and the headless tools. It is not registered by the pack and is not
// part of any world: the built-in pack ships no test creature.

/** Its colours: the hues of a small fox, toned toward the hollow's greens and browns. */
const COAT = "#b5814f";
const CREAM = "#e0cda6";
const PAWS = "#76563a";
const EYE = "#2b2620";
const GLINT = "#f2ead6";

/** A box part of `size` cubes, coloured by `paint(x, y, z)`: a 1-based index into `colors`. */
function box(
  type: string,
  size: VoxelSize,
  step: VoxelPart["step"],
  colors: string[],
  attach: VoxelPart["attach"],
  sockets: VoxelPart["sockets"] = [],
  paint: (x: number, y: number, z: number) => number = () => 1,
): VoxelPart {
  const grid = new Uint8Array(size.x * size.y * size.z);
  for (let z = 0; z < size.z; z++) {
    for (let y = 0; y < size.y; y++) {
      for (let x = 0; x < size.x; x++) grid[voxelIndex(size, x, y, z)] = paint(x, y, z);
    }
  }
  return { type, size, step, colors, voxels: encodeVoxels(grid), attach, sockets };
}

/**
 * A small four-legged creature of 2.5 cm cubes, about 36 cm long and 22 cm tall (the `small`
 * size class), facing +X: a torso (the root) with two front legs on shoulders and two back legs on
 * hips, the right-hand ones mirrored; a head on the neck with two 1.25 cm eyes on eye mounts, the
 * right one mirrored; and a tail on the tail base, of the built-in `hollow:tail` type, which has
 * the tail role. Its parts are of the built-in pack's part and socket types, so it passes
 * `checkAssemblyFit` against them. A fresh copy on each call.
 */
export function sampleVoxelAssembly(): VoxelAssembly {
  const torso = box(
    "hollow:torso",
    { x: 8, y: 5, z: 6 },
    0.025,
    [COAT, CREAM],
    { x: 4, y: 0, z: 3 },
    [
      { id: "front-left", type: "hollow:shoulder", position: { x: 6, y: 1, z: 1.5 } },
      {
        id: "front-right",
        type: "hollow:shoulder",
        position: { x: 6, y: 1, z: 4.5 },
        mirrors: "front-left",
      },
      { id: "back-left", type: "hollow:hip", position: { x: 2, y: 1, z: 1.5 } },
      {
        id: "back-right",
        type: "hollow:hip",
        position: { x: 2, y: 1, z: 4.5 },
        mirrors: "back-left",
      },
      { id: "neck", type: "hollow:neck", position: { x: 7, y: 4, z: 3 } },
      { id: "tail-base", type: "hollow:tail-base", position: { x: 1, y: 3, z: 3 } },
    ],
    // A cream belly.
    (_x, y) => (y === 0 ? 2 : 1),
  );
  const leg = box(
    "hollow:leg",
    { x: 2, y: 3, z: 1 },
    0.025,
    [COAT, PAWS],
    { x: 1, y: 3, z: 0.5 },
    [],
    // Dark paws.
    (_x, y) => (y === 0 ? 2 : 1),
  );
  const head = box(
    "hollow:head",
    { x: 5, y: 4, z: 4 },
    0.025,
    [COAT, CREAM],
    { x: 1, y: 1, z: 2 },
    [
      { id: "left-eye", type: "hollow:eye-mount", position: { x: 4.5, y: 2.5, z: 1 } },
      {
        id: "right-eye",
        type: "hollow:eye-mount",
        position: { x: 4.5, y: 2.5, z: 3 },
        mirrors: "left-eye",
      },
    ],
    // A cream muzzle low on its front.
    (x, y, z) => (x === 4 && y === 0 && z > 0 && z < 3 ? 2 : 1),
  );
  const eye = box(
    "hollow:eye",
    { x: 2, y: 2, z: 2 },
    0.0125,
    [EYE, GLINT],
    { x: 0, y: 1, z: 1 },
    [],
    // A glint at its upper front outer corner; the mirrored eye has it on its own outer side.
    (x, y, z) => (x === 1 && y === 1 && z === 0 ? 2 : 1),
  );
  const tail = box(
    "hollow:tail",
    { x: 4, y: 2, z: 2 },
    0.025,
    [COAT, CREAM],
    { x: 4, y: 1, z: 1 },
    [],
    // A cream tip.
    (x) => (x === 0 ? 2 : 1),
  );

  const on = (instance: string, socket: string) => ({ instance, socket });
  const instance = (
    id: string,
    part: string,
    parent?: ReturnType<typeof on>,
    mirrored = false,
  ) => ({
    id,
    part,
    ...(parent ? { parent } : {}),
    rotation: [...IDENTITY_QUATERNION] as VoxelAssembly["instances"][number]["rotation"],
    mirrored,
  });
  return {
    parts: { torso, leg, head, eye, tail },
    instances: [
      instance("torso", "torso"),
      instance("front-left-leg", "leg", on("torso", "front-left")),
      instance("front-right-leg", "leg", on("torso", "front-right"), true),
      instance("back-left-leg", "leg", on("torso", "back-left")),
      instance("back-right-leg", "leg", on("torso", "back-right"), true),
      instance("head", "head", on("torso", "neck")),
      instance("left-eye", "eye", on("head", "left-eye")),
      instance("right-eye", "eye", on("head", "right-eye"), true),
      instance("tail", "tail", on("torso", "tail-base")),
    ],
  };
}
