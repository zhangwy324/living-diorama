import { z } from "zod";
import { nearest } from "./distance";
import { HexColorSchema } from "./primitives";
import {
  MAX_PART_COLORS,
  MAX_PART_CUBES,
  VOXEL_STEPS,
  VoxelPartSchema,
  VoxelStepSchema,
  decodeVoxels,
  encodeVoxels,
  type VoxelPart,
  type VoxelPoint,
  type VoxelSize,
  type VoxelSocket,
  type VoxelStep,
} from "./voxel";

// Drawing a voxel part (ADR 0025): the player paints a 32×32 grid of colours, and a rule gives
// each painted pixel a depth. `voxelizeDrawing` turns the drawing into cubes; `fitDrawnPart` gives
// them the attach point and sockets of a base part of the same type. Pure.

/** A drawing's grid is this many pixels along each side, one pixel a cube. */
export const DRAWING_GRID = 32;

/**
 * Which side of the part the drawing shows. `side`: canvas x is +X (forward), canvas y down is −Y,
 * and depth is along Z. `front`: the part seen from in front, canvas x is −Z (the creature's right
 * is on the canvas's left, as a face is seen), canvas y down is −Y, and depth is along X. `top`:
 * the part seen from above, canvas x is +X, canvas y down is +Z (the creature's right), and depth
 * is along Y. `VIEW_AXES` maps each.
 */
// TODO(M23): reuse `PART_DRAWING_VIEWS` from definitions.ts once M23 PR 2 lands.
export const DRAWING_VIEWS = ["side", "front", "top"] as const;
export type DrawingView = (typeof DRAWING_VIEWS)[number];

/**
 * How deep each painted pixel becomes. `puffy`: rounded like a pillow, deepest in the middle of
 * the shape. `tube`: as deep as the shape is wide where the pixel is, like a limb. `flat`: one or
 * two cubes deep everywhere.
 */
// TODO(M23): reuse `PART_DRAWING_RULES` from definitions.ts once M23 PR 2 lands.
export const DRAWING_RULES = ["puffy", "tube", "flat"] as const;
export type DrawingRule = (typeof DRAWING_RULES)[number];

/** The chubby factor's range: it scales the depth of `puffy` and `tube` drawings. */
export const MIN_CHUBBY = 0.25;
export const MAX_CHUBBY = 2;

/** What the player drew, kept beside the part made from it so it reopens as a drawing. */
export const PartDrawingSchema = z
  .strictObject({
    /**
     * `DRAWING_GRID`² colour indices, row by row from the top-left: 0 is empty, `i` is
     * `palette[i - 1]`.
     */
    pixels: z.array(z.int().min(0).max(MAX_PART_COLORS)).length(DRAWING_GRID * DRAWING_GRID, {
      error: `A drawing has ${DRAWING_GRID * DRAWING_GRID} pixels`,
    }),
    /** sRGB colours. */
    palette: z
      .array(HexColorSchema)
      .max(MAX_PART_COLORS, { error: `A drawing has at most ${MAX_PART_COLORS} colours` }),
    view: z.enum(DRAWING_VIEWS),
    rule: z.enum(DRAWING_RULES),
    /** Scales the depth of a `puffy` or `tube` drawing. */
    chubby: z.number().min(MIN_CHUBBY).max(MAX_CHUBBY).default(1),
    /** A `flat` drawing's depth in cubes. */
    flatThickness: z.literal([1, 2]).default(1),
    /** The part's cube size, one of `VOXEL_STEPS`. */
    step: VoxelStepSchema,
  })
  .superRefine((drawing, ctx) => {
    const index = drawing.pixels.findIndex((value) => value > drawing.palette.length);
    if (index >= 0) {
      ctx.addIssue({
        code: "custom",
        message: `Colour index ${drawing.pixels[index]} is past the drawing's ${drawing.palette.length} colours`,
        path: ["pixels", index],
      });
    }
  });
export type PartDrawing = z.output<typeof PartDrawingSchema>;
export type PartDrawingInput = z.input<typeof PartDrawingSchema>;

/** The cubes made from a drawing, before they get an attach point and sockets. */
/** The cubes made from a drawing, before they get an attach point and sockets. */
export interface DrawnVoxels {
  size: VoxelSize;
  step: VoxelStep;
  /** sRGB colours, only those the drawing uses, in the order of its palette. */
  colors: string[];
  /** One colour index per cube, 0 for empty, in `voxelIndex` order (x fastest). */
  grid: Uint8Array;
  /** The drawing's pixel the crop starts at, its top-left painted bounds, in canvas pixels. */
  origin: { left: number; top: number };
}

type Axis = "x" | "y" | "z";

/**
 * Where a view puts the canvas's axes on the part: canvas x and canvas y (down) each along an
 * axis, `+1` the same way or `-1` the other way, and depth along the third, centred.
 */
interface ViewAxes {
  canvasX: readonly [Axis, 1 | -1];
  canvasY: readonly [Axis, 1 | -1];
  depth: Axis;
}

const VIEW_AXES: Readonly<Record<DrawingView, ViewAxes>> = {
  side: { canvasX: ["x", 1], canvasY: ["y", -1], depth: "z" },
  front: { canvasX: ["z", -1], canvasY: ["y", -1], depth: "x" },
  top: { canvasX: ["x", 1], canvasY: ["z", 1], depth: "y" },
};

/** `values[i]`, known to be there. */
const num = (values: ArrayLike<number>, i: number): number => values[i] ?? 0;

/**
 * Distances on a grid one empty pixel larger on every side than `filled` (`width` × `height`), so
 * the outside counts as empty: from each pixel's centre to the nearest empty pixel's centre, 1 at
 * the shape's edge. `at` is a pixel's index in the larger grid.
 */
function edgeDistances(filled: Uint8Array, width: number, height: number) {
  const pw = width + 2;
  const ph = height + 2;
  const at = (x: number, y: number) => x + 1 + pw * (y + 1);
  const empty = new Uint8Array(pw * ph).fill(1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (filled[x + width * y]) empty[at(x, y)] = 0;
  }
  return { distance: nearest(empty, pw, ph).distance2.map(Math.sqrt), pw, ph, at };
}

/**
 * Each painted pixel's depth in cubes, by the drawing's rule, before it is centred. `width` and
 * `height` are those of `filled`, the painted pixels of the cropped drawing.
 */
function pixelDepths(drawing: PartDrawing, filled: Uint8Array, width: number, height: number) {
  const depths = new Int32Array(width * height);
  if (drawing.rule === "flat") {
    filled.forEach((on, i) => (depths[i] = on ? drawing.flatThickness : 0));
    return depths;
  }
  const depthOf = (fullDepth: number) =>
    Math.min(MAX_PART_CUBES, Math.max(1, Math.round(fullDepth * drawing.chubby)));

  if (drawing.rule === "puffy") {
    // A round profile over the whole shape: a disc becomes a ball. `inside` is measured from the
    // shape's edge (half a pixel out from an edge pixel's centre) to a pixel's centre, the radius
    // from the edge to the middle of the widest place, about half a pixel past its centre pixel.
    const { distance, at } = edgeDistances(filled, width, height);
    let radius = 0;
    for (let i = 0; i < distance.length; i++) radius = Math.max(radius, num(distance, i));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!filled[x + width * y]) continue;
        const inside = num(distance, at(x, y)) - 0.5;
        depths[x + width * y] = depthOf(2 * Math.sqrt(radius ** 2 - (radius - inside) ** 2));
      }
    }
    return depths;
  }

  // Tube, on a grid of half pixels so a shape of any width, odd or even, has its width exactly: a
  // half pixel in the middle of a bar `w` pixels wide is `w` half pixels from the nearest empty
  // one. The midline is where that distance is greatest across the shape, a half pixel at least as
  // far from the edge as its eight neighbours. Each half pixel takes the width at its nearest
  // midline half pixel, and a pixel the most of its four, so a limb is as deep as it is wide.
  const fine = new Uint8Array(4 * width * height);
  for (let y = 0; y < 2 * height; y++) {
    for (let x = 0; x < 2 * width; x++) {
      fine[x + 2 * width * y] = num(filled, (x >> 1) + width * (y >> 1));
    }
  }
  const { distance, pw, ph, at } = edgeDistances(fine, 2 * width, 2 * height);
  const midline = new Uint8Array(pw * ph);
  const around = [-1, 1, -pw, pw, -pw - 1, -pw + 1, pw - 1, pw + 1];
  for (let y = 0; y < 2 * height; y++) {
    for (let x = 0; x < 2 * width; x++) {
      const i = at(x, y);
      const d = num(distance, i);
      if (fine[x + 2 * width * y] && around.every((offset) => d >= num(distance, i + offset))) {
        midline[i] = 1;
      }
    }
  }
  const { index } = nearest(midline, pw, ph);
  const widthAt = (x: number, y: number) => num(distance, num(index, at(x, y)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled[x + width * y]) continue;
      const [fx, fy] = [2 * x, 2 * y];
      depths[x + width * y] = depthOf(
        Math.max(
          widthAt(fx, fy),
          widthAt(fx + 1, fy),
          widthAt(fx, fy + 1),
          widthAt(fx + 1, fy + 1),
        ),
      );
    }
  }
  return depths;
}

/**
 * Turns a drawing into cubes, cropped to the painted pixels, each pixel a column of cubes of its
 * colour along the depth axis (`DRAWING_VIEWS`), centred on the part's middle plane. Every column
 * is an odd number of cubes deep when the deepest is, even when it is even, so the cubes are a
 * mirror image about that plane and a mirror pair of sockets fits them. Depth is capped at
 * `MAX_PART_CUBES`. Undefined for a drawing with nothing painted.
 */
export function voxelizeDrawing(drawing: PartDrawing): DrawnVoxels | undefined {
  let left = DRAWING_GRID;
  let right = -1;
  let top = DRAWING_GRID;
  let bottom = -1;
  drawing.pixels.forEach((value, i) => {
    if (value === 0) return;
    const x = i % DRAWING_GRID;
    const y = Math.floor(i / DRAWING_GRID);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  });
  if (right < 0) return undefined;
  const width = right - left + 1;
  const height = bottom - top + 1;
  const pixel = (x: number, y: number) => num(drawing.pixels, left + x + DRAWING_GRID * (top + y));

  // Only the colours used, in the palette's order.
  const used = new Set<number>();
  for (const value of drawing.pixels) if (value !== 0) used.add(value);
  const order = [...used].sort((a, b) => a - b);
  const remap = new Map(order.map((value, i) => [value, i + 1]));
  const colors = order.map((value) => drawing.palette[value - 1] ?? "#000000");

  const filled = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) filled[x + width * y] = pixel(x, y) === 0 ? 0 : 1;
  }
  const depths = pixelDepths(drawing, filled, width, height);
  let deep = 1;
  for (const depth of depths) deep = Math.max(deep, depth);

  const axes = VIEW_AXES[drawing.view];
  const size = { x: 0, y: 0, z: 0 };
  size[axes.canvasX[0]] = width;
  size[axes.canvasY[0]] = height;
  size[axes.depth] = deep;
  /** A cube's coordinate along `axis` from `value` counted the canvas's way, `sign` as the table. */
  const along = (value: number, extent: number, sign: 1 | -1) =>
    sign === 1 ? value : extent - 1 - value;
  const grid = new Uint8Array(size.x * size.y * size.z);
  const cube = { x: 0, y: 0, z: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = pixel(x, y);
      if (value === 0) continue;
      const color = remap.get(value) ?? 0;
      let depth = num(depths, x + width * y);
      depth += (deep - depth) % 2;
      const from = (deep - depth) / 2;
      cube[axes.canvasX[0]] = along(x, width, axes.canvasX[1]);
      cube[axes.canvasY[0]] = along(y, height, axes.canvasY[1]);
      for (let d = from; d < from + depth; d++) {
        cube[axes.depth] = d;
        grid[cube.x + size.x * (cube.y + size.y * cube.z)] = color;
      }
    }
  }
  return { size, step: drawing.step, colors, grid, origin: { left, top } };
}

/** Counts filled cubes in any box of a part in constant time (a summed-volume table). */
class FilledCount {
  private readonly table: Int32Array;
  private readonly sx: number;
  private readonly sy: number;

  constructor(
    readonly size: VoxelSize,
    grid: Uint8Array,
  ) {
    this.sx = size.x + 1;
    this.sy = size.y + 1;
    const table = new Int32Array(this.sx * this.sy * (size.z + 1));
    const t = (x: number, y: number, z: number) => num(table, x + this.sx * (y + this.sy * z));
    for (let z = 1; z <= size.z; z++) {
      for (let y = 1; y <= size.y; y++) {
        for (let x = 1; x <= size.x; x++) {
          const cube = num(grid, x - 1 + size.x * (y - 1 + size.y * (z - 1))) === 0 ? 0 : 1;
          table[x + this.sx * (y + this.sy * z)] =
            cube +
            t(x - 1, y, z) +
            t(x, y - 1, z) +
            t(x, y, z - 1) -
            t(x - 1, y - 1, z) -
            t(x - 1, y, z - 1) -
            t(x, y - 1, z - 1) +
            t(x - 1, y - 1, z - 1);
        }
      }
    }
    this.table = table;
  }

  /** The summed-volume table at corner (x, y, z). */
  private at(x: number, y: number, z: number): number {
    return num(this.table, x + this.sx * (y + this.sy * z));
  }

  /** Filled cubes from (x0, y0, z0) to (x1, y1, z1), both included, clipped to the part. */
  private count(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
    const [ax, ay, az] = [Math.max(0, x0), Math.max(0, y0), Math.max(0, z0)];
    const bx = Math.min(this.size.x, x1 + 1);
    const by = Math.min(this.size.y, y1 + 1);
    const bz = Math.min(this.size.z, z1 + 1);
    if (bx <= ax || by <= ay || bz <= az) return 0;
    return (
      this.at(bx, by, bz) -
      this.at(ax, by, bz) -
      this.at(bx, ay, bz) -
      this.at(bx, by, az) +
      this.at(ax, ay, bz) +
      this.at(ax, by, az) +
      this.at(bx, ay, az) -
      this.at(ax, ay, az)
    );
  }

  /**
   * Whether every cube within `depth` cubes of `point` is a filled cube of the part: the joint
   * depth rule (ADR 0022 §12), as the assembly validator's `isBuried` checks it.
   */
  buried(point: VoxelPoint, depth: number): boolean {
    const x0 = Math.floor(point.x - depth);
    const y0 = Math.floor(point.y - depth);
    const z0 = Math.floor(point.z - depth);
    const x1 = Math.ceil(point.x + depth) - 1;
    const y1 = Math.ceil(point.y + depth) - 1;
    const z1 = Math.ceil(point.z + depth) - 1;
    if (x0 < 0 || y0 < 0 || z0 < 0 || x1 >= this.size.x || y1 >= this.size.y || z1 >= this.size.z) {
      return false;
    }
    const volume = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    return this.count(x0, y0, z0, x1, y1, z1) === volume;
  }

  /** Whether `point` lies on or in a filled cube. */
  touches(point: VoxelPoint): boolean {
    return (
      this.count(
        lowCube(point.x),
        lowCube(point.y),
        lowCube(point.z),
        Math.floor(point.x),
        Math.floor(point.y),
        Math.floor(point.z),
      ) > 0
    );
  }
}

/** The lowest cube a point at `value` along an axis lies on or in. */
const lowCube = (value: number) => (Number.isInteger(value) ? value - 1 : Math.floor(value));

/** The nearest half-cube point to `point` within a part of `size`. */
const snapPoint = (point: VoxelPoint, size: VoxelSize): VoxelPoint => ({
  x: Math.min(size.x, Math.max(0, Math.round(2 * point.x) / 2)),
  y: Math.min(size.y, Math.max(0, Math.round(2 * point.y) / 2)),
  z: Math.min(size.z, Math.max(0, Math.round(2 * point.z) / 2)),
});

/** Offsets searched nearest-first, in half cubes, out to this far. */
const NEAR_RADIUS = 16;
let nearOffsets: Int8Array | undefined;

/**
 * Every offset in half cubes within `NEAR_RADIUS` of none, as flat `[dx, dy, dz, …]`, nearest
 * first; a tie goes to the smaller dz, then dy, then dx. Made once.
 */
function offsetsNearestFirst(): Int8Array {
  if (nearOffsets) return nearOffsets;
  const list: [number, number, number, number][] = [];
  const r = NEAR_RADIUS;
  for (let dz = -r; dz <= r; dz++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 <= r * r) list.push([d2, dz, dy, dx]);
      }
    }
  }
  list.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  nearOffsets = Int8Array.from(list.flatMap(([, dz, dy, dx]) => [dx, dy, dz]));
  return nearOffsets;
}

/** Whether `accept` takes any half-cube point of a part of `size`. */
function anyPoint(size: VoxelSize, accept: (point: VoxelPoint) => boolean): boolean {
  for (let hz = 0; hz <= 2 * size.z; hz++) {
    for (let hy = 0; hy <= 2 * size.y; hy++) {
      for (let hx = 0; hx <= 2 * size.x; hx++) {
        if (accept({ x: hx / 2, y: hy / 2, z: hz / 2 })) return true;
      }
    }
  }
  return false;
}

/**
 * The half-cube point of a part of `size` nearest to `target` that `accept` takes, or undefined
 * if it takes none. `target` is first snapped to the nearest half-cube point, and distance is
 * straight-line from there; a tie goes to the smaller offset in z, then y, then x. Points are
 * tried nearest-first and the first taken wins, so a socket near where it belongs costs little.
 */
function nearestPoint(
  size: VoxelSize,
  target: VoxelPoint,
  accept: (point: VoxelPoint) => boolean,
): VoxelPoint | undefined {
  const [tx, ty, tz] = [2 * target.x, 2 * target.y, 2 * target.z].map(Math.round) as [
    number,
    number,
    number,
  ];
  const offsets = offsetsNearestFirst();
  for (let i = 0; i < offsets.length; i += 3) {
    const hx = tx + num(offsets, i);
    const hy = ty + num(offsets, i + 1);
    const hz = tz + num(offsets, i + 2);
    if (hx < 0 || hy < 0 || hz < 0 || hx > 2 * size.x || hy > 2 * size.y || hz > 2 * size.z) {
      continue;
    }
    const point = { x: hx / 2, y: hy / 2, z: hz / 2 };
    if (accept(point)) return point;
  }
  // Farther than the list reaches: the rest of the part's points, sorted nearest-first by
  // counting their distances. They are counted in z, then y, then x, each upward, and the sort
  // keeps that order within a distance, so a tie goes to the smaller offset in z, then y, then x,
  // as above.
  const [nx, ny, nz] = [2 * size.x + 1, 2 * size.y + 1, 2 * size.z + 1];
  const near = NEAR_RADIUS * NEAR_RADIUS;
  const distances = new Int32Array(nx * ny * nz);
  let farthest = 0;
  for (let hz = 0, i = 0; hz < nz; hz++) {
    for (let hy = 0; hy < ny; hy++) {
      for (let hx = 0; hx < nx; hx++, i++) {
        const distance = (hx - tx) ** 2 + (hy - ty) ** 2 + (hz - tz) ** 2;
        distances[i] = distance;
        farthest = Math.max(farthest, distance);
      }
    }
  }
  if (farthest <= near) return undefined;
  const starts = new Int32Array(farthest + 2);
  for (const distance of distances)
    if (distance > near) starts[distance + 1] = num(starts, distance + 1) + 1;
  for (let d = 1; d < starts.length; d++) starts[d] = num(starts, d) + num(starts, d - 1);
  const order = new Int32Array(num(starts, farthest + 1));
  distances.forEach((distance, i) => {
    if (distance > near) {
      const at = num(starts, distance);
      order[at] = i;
      starts[distance] = at + 1;
    }
  });
  for (const i of order) {
    const hx = i % nx;
    const hy = Math.floor(i / nx) % ny;
    const point = { x: hx / 2, y: hy / 2, z: Math.floor(i / (nx * ny)) / 2 };
    if (accept(point)) return point;
  }
  return undefined;
}

/**
 * How deep a socket sits, by the joint depth rule (ADR 0022 §12), deepest first:
 * - `own`: buried a whole cube deep, so a child at the part's own step (or any) fits there.
 * - `finer`: buried half a cube deep, so only a child at a finer step fits. On half-cube points
 *   every depth up to half a cube asks for the same cubes, so this is one level. A part at the
 *   finest step has no finer child and so no `finer` level.
 * - `touching`: only on a filled cube, too shallow for any child.
 * - `loose`: off the cubes, which only a point the player placed (`DrawnPartOverrides`) can be.
 */
export const DRAWN_SOCKET_DEPTHS = ["own", "finer", "touching", "loose"] as const;
export type DrawnSocketDepth = (typeof DRAWN_SOCKET_DEPTHS)[number];

/** Points the player placed on a drawn part, in its cubes; each is kept, snapped to half cubes. */
export interface DrawnPartOverrides {
  attach?: VoxelPoint;
  /** By socket ID. */
  sockets?: Readonly<Record<string, VoxelPoint>>;
}

/** Where a fitted socket sits against where it aimed. */
export interface DrawnSocketFit {
  /** How deep it sits. */
  depth: DrawnSocketDepth;
  /** How deep its base socket sits on the base part, which it aimed for. */
  target: DrawnSocketDepth;
  /** Whether it sits shallower than it aimed: Draw mode flags it. */
  shallow: boolean;
}

/** What `fitDrawnPart` gives. */
export interface DrawnPartFit {
  part: VoxelPart;
  /** Each socket's depth and target, by ID. */
  sockets: Record<string, DrawnSocketFit>;
  /** Whether the attach point lies on a filled cube (it always does unless the player put it). */
  attachOnCubes: boolean;
}

type Level = readonly [DrawnSocketDepth, (point: VoxelPoint) => boolean];

/** The depth levels of a part of `step` and cubes `count`, deepest first. */
function depthLevels(count: FilledCount, step: VoxelStep): Level[] {
  const finer: Level[] =
    step > VOXEL_STEPS[0] ? [["finer", (point) => count.buried(point, 0.5)]] : [];
  return [
    ["own", (point) => count.buried(point, 1)],
    ...finer,
    ["touching", (point) => count.touches(point)],
  ];
}

const depthOf = (levels: readonly Level[], point: VoxelPoint): DrawnSocketDepth =>
  levels.find(([, fits]) => fits(point))?.[0] ?? "loose";

const rank = (depth: DrawnSocketDepth) => DRAWN_SOCKET_DEPTHS.indexOf(depth);

/**
 * A voxel part made of drawn cubes with the attach point and sockets of `base`, a part of the same
 * type (ADR 0025): each point is scaled from the base part's box to the drawn one, then moved to
 * the nearest half-cube point where it belongs.
 *
 * - The attach point goes onto a filled cube: a cube's corner, edge, face or middle.
 * - A socket aims for the depth its base socket has on the base part (`DRAWN_SOCKET_DEPTHS`,
 *   measured the same way there; a base socket off its cubes aims for `touching`): one buried a
 *   whole cube deep aims for a whole drawn cube, an eye socket half a cube inside a face for half a
 *   drawn cube. It goes to the nearest point at that level (`own` where the drawn part has no
 *   `finer` level), or where there is none, at the next shallower level there is, and is then
 *   `shallow`. The part is valid either way.
 * - The sockets of a mirror pair whose base sockets mirror each other are placed together, the
 *   mirrored one at the mirror image of the other about the part's middle plane, at the first
 *   level both reach. Only if no mirrored place touches the cubes at all (a lopsided front view)
 *   is each placed on its own.
 * - A point in `overrides` is kept where the player put it, snapped to the nearest half-cube point
 *   in the part. A socket of such a mirror pair with only its partner given takes the mirror image
 *   of its partner's point.
 *
 * The part has `base`'s type and no `source`. The same cubes, base and overrides give the same part.
 */
export function fitDrawnPart(
  drawn: DrawnVoxels,
  base: VoxelPart,
  overrides: DrawnPartOverrides = {},
): DrawnPartFit {
  const { size } = drawn;
  const count = new FilledCount(size, drawn.grid);
  const scale = (point: VoxelPoint): VoxelPoint => ({
    x: (point.x * size.x) / base.size.x,
    y: (point.y * size.y) / base.size.y,
    z: (point.z * size.z) / base.size.z,
  });
  const mirror = (point: VoxelPoint): VoxelPoint => ({ ...point, z: size.z - point.z });
  const given = overrides.sockets ?? {};

  const attach = overrides.attach
    ? snapPoint(overrides.attach, size)
    : (nearestPoint(size, scale(base.attach), (point) => count.touches(point)) ??
      snapPoint(scale(base.attach), size));

  const levels = depthLevels(count, drawn.step);
  const baseLevels = depthLevels(
    new FilledCount(base.size, decodeVoxels(base.voxels, base.size)),
    base.step,
  );
  const targets = new Map(
    base.sockets.map((socket) => {
      const depth = depthOf(baseLevels, socket.position);
      return [socket.id, depth === "loose" ? "touching" : depth] as const;
    }),
  );
  const targetOf = (socket: VoxelSocket): DrawnSocketDepth => targets.get(socket.id) ?? "own";

  /** Whether any point of the part reaches each level, found once, when first asked. */
  const reached = new Map<DrawnSocketDepth, boolean>();
  const reaches = ([level, fits]: Level) => {
    let any = reached.get(level);
    if (any === undefined) {
      any = anyPoint(size, fits);
      reached.set(level, any);
    }
    return any;
  };
  /**
   * The nearest point to `target` at `aim`'s level, or the next shallower one there is, where it,
   * and its mirror image too when `paired`, reach the level. Levels no point reaches are skipped
   * without a search.
   */
  const nearestAt = (target: VoxelPoint, aim: DrawnSocketDepth, paired: boolean) => {
    // A level the part lacks (`finer` at the finest step) aims for the one above it.
    let start = 0;
    levels.forEach(([level], i) => {
      if (rank(level) <= rank(aim)) start = i;
    });
    for (const level of levels.slice(start)) {
      if (!reaches(level)) continue;
      const [, fits] = level;
      const position = nearestPoint(size, target, (point) =>
        paired ? fits(point) && fits(mirror(point)) : fits(point),
      );
      if (position) return position;
    }
    return undefined;
  };

  const byId = new Map(base.sockets.map((socket) => [socket.id, socket]));
  /** The mirrored socket of each pair whose base positions mirror exactly, by its pair's ID. */
  const mirroredBy = new Map<string, VoxelSocket>();
  for (const socket of base.sockets) {
    const pair = socket.mirrors === undefined ? undefined : byId.get(socket.mirrors);
    if (
      pair &&
      socket.position.x === pair.position.x &&
      socket.position.y === pair.position.y &&
      socket.position.z === base.size.z - pair.position.z
    ) {
      mirroredBy.set(pair.id, socket);
    }
  }
  const followers = new Set([...mirroredBy.values()].map((socket) => socket.id));

  const placed = new Map<string, VoxelPoint>();
  const place = (socket: VoxelSocket) => {
    const point = given[socket.id];
    const target = scale(socket.position);
    const position = point ? snapPoint(point, size) : nearestAt(target, targetOf(socket), false);
    // Some cube is filled, so a point on one is always found.
    placed.set(socket.id, position ?? snapPoint(target, size));
  };
  for (const socket of base.sockets) {
    if (followers.has(socket.id)) continue;
    const partner = mirroredBy.get(socket.id);
    if (!partner) {
      place(socket);
      continue;
    }
    const [mine, theirs] = [given[socket.id], given[partner.id]];
    if (mine || theirs) {
      // The player placed one or both: keep those, mirror the one not placed.
      const point = mine && snapPoint(mine, size);
      const partnerPoint = theirs && snapPoint(theirs, size);
      if (point) placed.set(socket.id, point);
      if (partnerPoint) placed.set(partner.id, partnerPoint);
      if (!point && partnerPoint) placed.set(socket.id, mirror(partnerPoint));
      if (point && !partnerPoint) placed.set(partner.id, mirror(point));
      continue;
    }
    const position = nearestAt(scale(socket.position), targetOf(socket), true);
    if (position) {
      placed.set(socket.id, position);
      placed.set(partner.id, mirror(position));
    } else {
      place(socket);
      place(partner);
    }
  }

  const parsed = VoxelPartSchema.safeParse({
    type: base.type,
    size: { ...size },
    step: drawn.step,
    colors: [...drawn.colors],
    voxels: encodeVoxels(drawn.grid),
    attach,
    sockets: base.sockets.map((socket) => ({
      ...socket,
      position: placed.get(socket.id) ?? socket.position,
    })),
  });
  if (!parsed.success) throw new Error(`A drawn part is invalid: ${parsed.error.message}`);
  return {
    part: parsed.data,
    sockets: Object.fromEntries(
      parsed.data.sockets.map((socket) => {
        const depth = depthOf(levels, socket.position);
        const target = targetOf(socket);
        return [socket.id, { depth, target, shallow: rank(depth) > rank(target) }];
      }),
    ),
    attachOnCubes: count.touches(parsed.data.attach),
  };
}
