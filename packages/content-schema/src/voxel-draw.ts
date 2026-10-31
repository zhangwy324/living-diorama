import { z } from "zod";
import { nearest } from "./distance";
import { HexColorSchema } from "./primitives";
import {
  MAX_PART_COLORS,
  MAX_PART_CUBES,
  VoxelPartSchema,
  VoxelStepSchema,
  encodeVoxels,
  stepUnits,
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
 * is on the canvas's left, as a face is seen), canvas y down is −Y, and depth is along X.
 */
// TODO(M23): reuse `PART_DRAWING_VIEWS` from definitions.ts once M23 PR 2 lands.
export const DRAWING_VIEWS = ["side", "front"] as const;
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
export interface DrawnVoxels {
  size: VoxelSize;
  step: VoxelStep;
  /** sRGB colours, only those the drawing uses, in the order of its palette. */
  colors: string[];
  /** One colour index per cube, 0 for empty, in `voxelIndex` order (x fastest). */
  grid: Uint8Array;
}

/** `values[i]`, known to be there. */
const num = (values: ArrayLike<number>, i: number): number => values[i] ?? 0;

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
  // Distances on a grid one empty pixel larger on every side, so the outside counts as empty.
  const pw = width + 2;
  const ph = height + 2;
  const at = (x: number, y: number) => x + 1 + pw * (y + 1);
  const empty = new Uint8Array(pw * ph).fill(1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (filled[x + width * y]) empty[at(x, y)] = 0;
  }
  // From a pixel's centre to the nearest empty pixel's centre: 1 at the shape's edge.
  const distance = nearest(empty, pw, ph).distance2.map(Math.sqrt);
  const depthOf = (halfDepth: number) =>
    Math.min(MAX_PART_CUBES, Math.max(1, Math.round(2 * halfDepth * drawing.chubby)));

  if (drawing.rule === "puffy") {
    // A round profile over the whole shape: a disc becomes a ball. `inside` is measured from the
    // shape's edge (half a pixel out from an edge pixel's centre) to a pixel's centre, the radius
    // from the edge to the middle of the widest place, about half a pixel past its centre pixel.
    let radius = 0;
    for (let i = 0; i < distance.length; i++) radius = Math.max(radius, num(distance, i));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!filled[x + width * y]) continue;
        const inside = num(distance, at(x, y)) - 0.5;
        depths[x + width * y] = depthOf(Math.sqrt(radius ** 2 - (radius - inside) ** 2));
      }
    }
    return depths;
  }

  // Tube: the midline is where the distance to the edge is greatest across the shape, a pixel at
  // least as far from the edge as its eight neighbours. Each pixel takes the half-width of the
  // shape at its nearest midline pixel, so a limb is as deep as it is wide all along.
  const midline = new Uint8Array(pw * ph);
  const around = [-1, 1, -pw, pw, -pw - 1, -pw + 1, pw - 1, pw + 1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = at(x, y);
      const d = num(distance, i);
      if (filled[x + width * y] && around.every((offset) => d >= num(distance, i + offset))) {
        midline[i] = 1;
      }
    }
  }
  const { index } = nearest(midline, pw, ph);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!filled[x + width * y]) continue;
      depths[x + width * y] = depthOf(num(distance, num(index, at(x, y))) - 0.5);
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

  const size: VoxelSize =
    drawing.view === "side" ? { x: width, y: height, z: deep } : { x: deep, y: height, z: width };
  const grid = new Uint8Array(size.x * size.y * size.z);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = pixel(x, y);
      if (value === 0) continue;
      const color = remap.get(value) ?? 0;
      let depth = num(depths, x + width * y);
      depth += (deep - depth) % 2;
      const from = (deep - depth) / 2;
      const cy = height - 1 - y;
      for (let d = from; d < from + depth; d++) {
        const [cx, cz] = drawing.view === "side" ? [x, d] : [d, width - 1 - x];
        grid[cx + size.x * (cy + size.y * cz)] = color;
      }
    }
  }
  return { size, step: drawing.step, colors, grid };
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

  /** Filled cubes from `lo` to `hi`, both included, clipped to the part. */
  count(lo: readonly number[], hi: readonly number[]): number {
    const a = lo.map((value) => Math.max(0, value));
    const b = [
      Math.min(this.size.x, num(hi, 0) + 1),
      Math.min(this.size.y, num(hi, 1) + 1),
      Math.min(this.size.z, num(hi, 2) + 1),
    ];
    if (b.some((value, i) => value <= num(a, i))) return 0;
    const t = (x: number, y: number, z: number) => num(this.table, x + this.sx * (y + this.sy * z));
    const [x0, y0, z0] = [num(a, 0), num(a, 1), num(a, 2)];
    const [x1, y1, z1] = [num(b, 0), num(b, 1), num(b, 2)];
    return (
      t(x1, y1, z1) -
      t(x0, y1, z1) -
      t(x1, y0, z1) -
      t(x1, y1, z0) +
      t(x0, y0, z1) +
      t(x0, y1, z0) +
      t(x1, y0, z0) -
      t(x0, y0, z0)
    );
  }

  /**
   * Whether every cube within `depth` cubes of `point` is a filled cube of the part: the joint
   * depth rule (ADR 0022 §12), as the assembly validator checks it.
   */
  buried(point: VoxelPoint, depth: number): boolean {
    const lo: number[] = [];
    const hi: number[] = [];
    for (const axis of ["x", "y", "z"] as const) {
      const low = Math.floor(point[axis] - depth);
      const high = Math.ceil(point[axis] + depth) - 1;
      if (low < 0 || high >= this.size[axis]) return false;
      lo.push(low);
      hi.push(high);
    }
    const volume = (num(hi, 0) - num(lo, 0) + 1) * (num(hi, 1) - num(lo, 1) + 1);
    return this.count(lo, hi) === volume * (num(hi, 2) - num(lo, 2) + 1);
  }

  /** Whether `point` lies on or in a filled cube. */
  touches(point: VoxelPoint): boolean {
    const lo: number[] = [];
    const hi: number[] = [];
    for (const axis of ["x", "y", "z"] as const) {
      const value = point[axis];
      lo.push(Number.isInteger(value) ? value - 1 : Math.floor(value));
      hi.push(Math.floor(value));
    }
    return this.count(lo, hi) > 0;
  }
}

/**
 * The half-cube point of a part of `size` nearest to `target` (in straight-line distance) that
 * `accept` takes, or undefined if it takes none. A tie goes to the first in x, then y, then z.
 */
function nearestPoint(
  size: VoxelSize,
  target: VoxelPoint,
  accept: (point: VoxelPoint) => boolean,
): VoxelPoint | undefined {
  let best: VoxelPoint | undefined;
  let bestDistance = Infinity;
  for (let hz = 0; hz <= 2 * size.z; hz++) {
    for (let hy = 0; hy <= 2 * size.y; hy++) {
      for (let hx = 0; hx <= 2 * size.x; hx++) {
        const point = { x: hx / 2, y: hy / 2, z: hz / 2 };
        const distance =
          (point.x - target.x) ** 2 + (point.y - target.y) ** 2 + (point.z - target.z) ** 2;
        if (distance < bestDistance && accept(point)) {
          best = point;
          bestDistance = distance;
        }
      }
    }
  }
  return best;
}

/** What `fitDrawnPart` gives. */
export interface DrawnPartFit {
  part: VoxelPart;
  /**
   * The IDs of the sockets with no place buried deep enough for a child at the part's own step
   * (on a thin stroke, or a flat drawing one cube deep): each sits as deep as the drawing allows.
   * The part is still valid, but such a child doesn't fit there; Draw mode shows them.
   */
  shallow: string[];
}

/**
 * A voxel part made of drawn cubes with the attach point and sockets of `base`, a part of the same
 * type (ADR 0025): each point is scaled from the base part's box to the drawn one, then moved to
 * the nearest half-cube point where it belongs.
 *
 * - The attach point goes onto a filled cube: a cube's corner, edge, face or middle.
 * - A socket goes where the joint depth rule (ADR 0022 §12, `isBuried` in the assembly validator)
 *   holds for a child at the part's own step: every cube within one cube of it filled. Where no
 *   point does, it goes where the cubes around it are filled half a cube deep, then a quarter, down
 *   to the finest step, and at last just onto a filled cube, and is listed in `shallow`.
 * - The sockets of a mirror pair whose base sockets mirror each other are placed together, the
 *   mirrored one at the mirror image of the other about the part's middle plane, at the deepest
 *   level both reach. Only if no mirrored place touches the cubes at all (a lopsided front view)
 *   is each placed on its own.
 *
 * The part has `base`'s type and no `source`. The same cubes and base give the same part.
 */
export function fitDrawnPart(drawn: DrawnVoxels, base: VoxelPart): DrawnPartFit {
  const { size } = drawn;
  const count = new FilledCount(size, drawn.grid);
  const scale = (point: VoxelPoint): VoxelPoint => ({
    x: (point.x * size.x) / base.size.x,
    y: (point.y * size.y) / base.size.y,
    z: (point.z * size.z) / base.size.z,
  });
  const mirror = (point: VoxelPoint): VoxelPoint => ({ ...point, z: size.z - point.z });

  const attach =
    nearestPoint(size, scale(base.attach), (point) => count.touches(point)) ?? scale(base.attach);

  // How deep a socket may sit, deepest first, in cubes: a whole cube (the rule), then half as deep
  // down to the finest step, then anywhere on a filled cube.
  const levels: ((point: VoxelPoint) => boolean)[] = [];
  for (let depth = 1; depth * stepUnits(drawn.step) >= stepUnits(0.0125); depth /= 2) {
    levels.push((point) => count.buried(point, depth));
  }
  levels.push((point) => count.touches(point));
  /** The nearest point to `target` at the deepest level `accept` passes, and that level. */
  const deepest = (
    target: VoxelPoint,
    accept: (fits: (p: VoxelPoint) => boolean, p: VoxelPoint) => boolean,
  ) => {
    for (const [level, fits] of levels.entries()) {
      const position = nearestPoint(size, target, (point) => accept(fits, point));
      if (position) return { position, level };
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
  const shallow = new Set<string>();
  const put = (id: string, position: VoxelPoint, level: number) => {
    placed.set(id, position);
    if (level > 0) shallow.add(id);
  };
  const place = (socket: VoxelSocket) => {
    const found = deepest(scale(socket.position), (fits, point) => fits(point));
    // Some cube is filled, so a point on one is always found.
    if (found) put(socket.id, found.position, found.level);
  };
  for (const socket of base.sockets) {
    if (followers.has(socket.id)) continue;
    const partner = mirroredBy.get(socket.id);
    if (!partner) {
      place(socket);
      continue;
    }
    const found = deepest(
      scale(socket.position),
      (fits, point) => fits(point) && fits(mirror(point)),
    );
    if (found) {
      put(socket.id, found.position, found.level);
      put(partner.id, mirror(found.position), found.level);
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
    shallow: base.sockets.filter((socket) => shallow.has(socket.id)).map((socket) => socket.id),
  };
}
