import { z } from "zod";
import { ContentIdSchema, HexColorSchema, LocalIdSchema } from "./primitives";

// Voxel parts (ADR 0022): a box of at most 32³ cubes of one size, its cubes stored as indices
// into the part's own list of sRGB colours, run-length encoded. Points on a part (its sockets and
// its attach point) are in the part's own cubes from its corner at (0, 0, 0), half cubes allowed.
// Axes as ADR 0022 §16: +X forward, Y up, +Z to the creature's right.

/** The cube sizes a part may use, in metres (ADR 0022 §1): each twice the one before. */
export const VOXEL_STEPS = [0.0125, 0.025, 0.05, 0.1] as const;
export type VoxelStep = (typeof VOXEL_STEPS)[number];

/**
 * The unit of every exact check on parts and assemblies, in metres: half the finest step, so any
 * point on any part (half cubes allowed) is a whole number of units.
 */
export const VOXEL_UNIT = VOXEL_STEPS[0] / 2;

/** A part's cubes along each axis, at most (ADR 0022 §15). */
export const MAX_PART_CUBES = 32;
/** Colours in one part's list, at most: index 0 is an empty cube, 1–255 the colours. */
export const MAX_PART_COLORS = 255;
/** Part instances in one assembly, at most. */
export const MAX_ASSEMBLY_INSTANCES = 32;
/**
 * Visible cube faces in one assembly, at most, counted per part as a mesher draws them: 2¹⁷, about
 * half a million vertices. A solid 32³ part has 6,144; a noisy one could have 98,304.
 */
export const MAX_ASSEMBLY_FACES = 131_072;

/**
 * How far a renderer shrinks a part toward its own centre per level of depth in the assembly's
 * tree, in metres: 1% of the finest step (`instanceInset`). The root isn't shrunk, a part on it
 * by this much, a part on that one by twice as much, so the flush faces of a part and its parent
 * never share a plane. Two parts at the same depth still may, which `assemblyWarnings` reports.
 * Measuring (`measureAssembly`) ignores it.
 */
export const CHILD_PART_INSET = 0.01 * VOXEL_STEPS[0];

/**
 * How far a renderer shrinks a part `depth` levels below the root toward its own centre, in
 * metres (`CHILD_PART_INSET`); `InstancePlacement.depth` gives the depth.
 */
export const instanceInset = (depth: number): number => CHILD_PART_INSET * depth;

/** `values[i]`, known to be there. */
const num = (values: ArrayLike<number>, i: number): number => values[i] ?? 0;

/** A step's cube size in `VOXEL_UNIT`s: 2, 4, 8 or 16. */
export const stepUnits = (step: VoxelStep): number => 2 << VOXEL_STEPS.indexOf(step);

const StepSchema = z.literal(VOXEL_STEPS, {
  error: `A part's step must be one of ${VOXEL_STEPS.join(", ")} m`,
});

const cubeCount = z
  .int()
  .min(1, { error: "A part is at least 1 cube along each axis" })
  .max(MAX_PART_CUBES, { error: `A part is at most ${MAX_PART_CUBES} cubes along each axis` });

/** A part's size in cubes. */
export const VoxelSizeSchema = z.strictObject({ x: cubeCount, y: cubeCount, z: cubeCount });
export type VoxelSize = z.output<typeof VoxelSizeSchema>;

const halfCube = z.number().refine((value) => Number.isInteger(value * 2), {
  error: "Expected a whole or half number of cubes",
});

/** A point on a part, in its cubes from its corner, half cubes allowed. */
export const VoxelPointSchema = z.strictObject({ x: halfCube, y: halfCube, z: halfCube });
export type VoxelPoint = z.output<typeof VoxelPointSchema>;

/**
 * A place on a part where another part can hang (ADR 0022 §9). Sockets come in mirror pairs: the
 * socket with `mirrors` is the mirrored one of its pair, and a part on it is mirrored (§16).
 */
export const VoxelSocketSchema = z.strictObject({
  /** Unique within the part, e.g. `left-hip`. */
  id: LocalIdSchema,
  /** The socket type, e.g. `hollow:leg-mount`. A part fits it if its part type lists this type. */
  type: ContentIdSchema,
  position: VoxelPointSchema,
  /** The ID of the socket of the same part and type this one mirrors. */
  mirrors: LocalIdSchema.optional(),
});
export type VoxelSocket = z.output<typeof VoxelSocketSchema>;

/** The cubes a part holds, x fastest, then y, then z: `x + X·(y + Y·z)`. */
export const voxelIndex = (size: VoxelSize, x: number, y: number, z: number): number =>
  x + size.x * (y + size.y * z);

/**
 * A voxel part (ADR 0022 §9, §15). An assembly holds a frozen copy of each part it uses (§17).
 */
export const VoxelPartSchema = z
  .strictObject({
    /** The part type, e.g. `hollow:leg`, which says which socket types it fits. */
    type: ContentIdSchema,
    /** The part this one was copied from, as provenance only. */
    source: ContentIdSchema.optional(),
    size: VoxelSizeSchema,
    /** Edge of one cube in metres, one of `VOXEL_STEPS`. */
    step: StepSchema,
    /** sRGB colours; a cube of index `i` (1–255) has `colors[i - 1]`. */
    colors: z
      .array(HexColorSchema)
      .max(MAX_PART_COLORS, { error: `A part has at most ${MAX_PART_COLORS} colours` }),
    /**
     * The cubes, run-length encoded as flat `[run, index, run, index, …]`: `run` cubes in a row
     * (in `voxelIndex` order) of colour `index`, 0 for empty. The runs add up to X·Y·Z.
     */
    voxels: z.array(z.int().nonnegative()),
    /** Where the part hangs from its parent's socket; also its pivot (§9). */
    attach: VoxelPointSchema,
    sockets: z.array(VoxelSocketSchema).default([]),
  })
  .superRefine((part, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const total = part.size.x * part.size.y * part.size.z;
    const { voxels } = part;
    if (voxels.length % 2 !== 0) {
      issue("Voxels come in pairs: run, colour index", ["voxels"]);
    } else {
      let sum = 0;
      let filled = 0;
      for (let i = 0; i < voxels.length; i += 2) {
        const run = num(voxels, i);
        const index = num(voxels, i + 1);
        if (run < 1) issue("A run is at least 1 cube", ["voxels", i]);
        if (index > part.colors.length) {
          issue(`Colour index ${index} is past the part's ${part.colors.length} colours`, [
            "voxels",
            i + 1,
          ]);
        }
        sum += run;
        if (index !== 0) filled += run;
      }
      if (sum !== total) {
        issue(`The runs add up to ${sum} cubes, not the part's ${total}`, ["voxels"]);
      } else if (filled === 0) {
        issue("A part needs at least one cube", ["voxels"]);
      }
    }

    const inside = (point: VoxelPoint, path: (string | number)[]) => {
      for (const axis of ["x", "y", "z"] as const) {
        if (point[axis] < 0 || point[axis] > part.size[axis]) {
          issue(`The point's ${axis} is outside the part, 0 to ${part.size[axis]}`, [
            ...path,
            axis,
          ]);
        }
      }
    };
    inside(part.attach, ["attach"]);

    const byId = new Map<string, VoxelSocket>();
    part.sockets.forEach((socket, i) => {
      inside(socket.position, ["sockets", i, "position"]);
      if (byId.has(socket.id)) issue(`Duplicate socket ID "${socket.id}"`, ["sockets", i, "id"]);
      else byId.set(socket.id, socket);
    });
    const mirrored = new Set<string>();
    part.sockets.forEach((socket, i) => {
      if (socket.mirrors === undefined) return;
      const path = ["sockets", i, "mirrors"];
      const pair = byId.get(socket.mirrors);
      if (!pair || pair === socket) {
        issue(`Socket "${socket.mirrors}" isn't another socket of this part`, path);
      } else if (pair.mirrors !== undefined) {
        issue(`Socket "${pair.id}" is itself a mirrored socket`, path);
      } else if (pair.type !== socket.type) {
        issue(`A socket mirrors only a socket of its own type (${pair.id} is ${pair.type})`, path);
      } else if (mirrored.has(pair.id)) {
        issue(`Socket "${pair.id}" is already mirrored by another socket`, path);
      } else {
        mirrored.add(pair.id);
      }
    });
  });
export type VoxelPart = z.output<typeof VoxelPartSchema>;
export type VoxelPartInput = z.input<typeof VoxelPartSchema>;

/**
 * Decodes a part's run-length encoded cubes into one colour index per cube, x fastest. With
 * `padded`, the grid is one empty cube larger on every side, (X+2)·(Y+2)·(Z+2), cube (x, y, z) at
 * (x+1, y+1, z+1), so a mesher can look at every neighbour without bounds checks. Expects runs
 * that fit the size, as `VoxelPartSchema` checks.
 */
export function decodeVoxels(
  voxels: readonly number[],
  size: VoxelSize,
  { padded = false }: { padded?: boolean } = {},
): Uint8Array {
  if (!padded) {
    const grid = new Uint8Array(size.x * size.y * size.z);
    let at = 0;
    for (let i = 0; i < voxels.length; i += 2) {
      const run = num(voxels, i);
      grid.fill(num(voxels, i + 1), at, at + run);
      at += run;
    }
    return grid;
  }
  const px = size.x + 2;
  const py = size.y + 2;
  const grid = new Uint8Array(px * py * (size.z + 2));
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < voxels.length; i += 2) {
    const index = num(voxels, i + 1);
    for (let run = num(voxels, i); run > 0; run--) {
      if (index !== 0) grid[x + 1 + px * (y + 1 + py * (z + 1))] = index;
      if (++x === size.x) {
        x = 0;
        if (++y === size.y) {
          y = 0;
          z++;
        }
      }
    }
  }
  return grid;
}

/**
 * How many faces of a part's cubes a mesher draws: those whose neighbour in the part is empty.
 * `grid` is `decodeVoxels`' plain grid.
 */
export function visibleFaces(grid: Uint8Array, size: VoxelSize): number {
  const filled = (x: number, y: number, z: number) =>
    x >= 0 &&
    y >= 0 &&
    z >= 0 &&
    x < size.x &&
    y < size.y &&
    z < size.z &&
    grid[voxelIndex(size, x, y, z)] !== 0;
  let faces = 0;
  for (let z = 0, at = 0; z < size.z; z++) {
    for (let y = 0; y < size.y; y++) {
      for (let x = 0; x < size.x; x++, at++) {
        if (grid[at] === 0) continue;
        faces +=
          Number(!filled(x - 1, y, z)) +
          Number(!filled(x + 1, y, z)) +
          Number(!filled(x, y - 1, z)) +
          Number(!filled(x, y + 1, z)) +
          Number(!filled(x, y, z - 1)) +
          Number(!filled(x, y, z + 1));
      }
    }
  }
  return faces;
}

/** Run-length encodes one colour index per cube, x fastest, as `decodeVoxels` reads it. */
export function encodeVoxels(grid: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < grid.length;) {
    const index = num(grid, i);
    let end = i + 1;
    while (end < grid.length && grid[end] === index) end++;
    out.push(end - i, index);
    i = end;
  }
  return out;
}
