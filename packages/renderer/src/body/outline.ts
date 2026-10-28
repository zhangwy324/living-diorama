import { isOpaque, neighbours, type Pixels } from "./pixels";

// Outlines of a drawing's solid shapes and of the holes in them (ADR 0011 §2, ADR 0017).

/** A point in pixel-corner coordinates: x right, y down, (0, 0) the image's top-left corner. */
export type Point = readonly [x: number, y: number];

/** One slab of the body: its outer boundary and the boundaries of the holes through it. */
export interface OutlineShape {
  outer: Point[];
  holes: Point[][];
  /** The same loops as traced along pixel edges, before simplifying. */
  traced: { outer: Point[]; holes: Point[][] };
}

export interface Outline {
  /** One entry per kept shape, its loops simplified. */
  shapes: OutlineShape[];
  /** Bounds of the kept shapes, in the same coordinates. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** A shape under this share of the opaque area is a speck. */
export const SPECK_SHARE = 0.005;
/**
 * Simplification tolerances in pixels, tried in turn for a loop that would cross another loop or
 * itself. The last, 0, keeps the traced loop as it is: loops along pixel edges never cross.
 */
const SIMPLIFY_TOLERANCES = [1, 0.5, 0] as const;

/** A shape of the drawing: 4-connected opaque pixels. */
export interface Component {
  label: number;
  /** The first pixel in scan order: its top-left corner is on the outer boundary. */
  start: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SolidShapes {
  /** Each pixel's component label, 0 for transparent. Specks keep their labels. */
  labels: Int32Array;
  /** The kept components, specks left out, largest first. */
  shapes: Component[];
}

/** Steps for the four directions: right, down, left, up. */
const DX = [1, 0, -1, 0] as const;
const DY = [0, 1, 0, -1] as const;

/**
 * The drawing's solid shapes: 4-connected opaque pixels, specks left out. The body and the Studio's
 * hints both read the drawing through this, so they agree on what is solid.
 */
export function solidShapes(pixels: Pixels): SolidShapes {
  const { labels, components } = label(pixels);
  const total = components.reduce((sum, c) => sum + c.area, 0);
  const shapes = components
    .filter((c) => c.area >= total * SPECK_SHARE)
    .sort((a, b) => b.area - a.area);
  return { labels, shapes };
}

/**
 * Traces each solid shape's outer boundary and the boundary of every hole in it. A hole is any
 * enclosed area that isn't solid, whatever its size. A shape inside a hole is a shape of its own.
 */
export function traceOutline(pixels: Pixels): Outline {
  const { width, height } = pixels;
  const { labels, shapes } = solidShapes(pixels);
  const owner = new Map(shapes.map((c, i) => [c.label, i]));
  const solid = new Uint8Array(width * height);
  for (let i = 0; i < solid.length; i++) solid[i] = owner.has(labels[i] ?? 0) ? 1 : 0;

  const raw: { outer: Point[]; holes: Point[][] }[] = shapes.map((component) => ({
    outer: traceBoundary(
      (x, y) => inside(x, y, width, height) && labels[y * width + x] === component.label,
      component.start % width,
      Math.floor(component.start / width),
      false,
    ),
    holes: [],
  }));
  const holes = holeAreas(solid, width, height);
  for (const hole of holes.areas) {
    // The pixel above a hole's first pixel is solid, and of the shape around the hole: a shape
    // inside the hole lies below that pixel.
    const shape = owner.get(labels[hole.start - width] ?? 0);
    if (shape === undefined) continue;
    raw[shape]?.holes.push(
      traceBoundary(
        (x, y) => inside(x, y, width, height) && holes.labels[y * width + x] === hole.label,
        hole.start % width,
        Math.floor(hole.start / width),
        true,
      ),
    );
  }

  const simplified = simplifyShapes(raw);
  // From the traced loops: the shapes' exact pixel bounds.
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [x, y] of simplified.flatMap((s) => s.traced.outer)) {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
  }
  return { shapes: simplified, bounds };
}

const inside = (x: number, y: number, width: number, height: number) =>
  x >= 0 && y >= 0 && x < width && y < height;

/** Groups opaque pixels into 4-connected components, numbered from 1 in scan order. */
function label(pixels: Pixels): { labels: Int32Array; components: Component[] } {
  const { width, height } = pixels;
  const labels = new Int32Array(width * height);
  const components: Component[] = [];
  const queue = new Int32Array(width * height);
  for (let start = 0; start < labels.length; start++) {
    if (labels[start] || !isOpaque(pixels, start)) continue;
    const component: Component = {
      label: components.length + 1,
      start,
      area: 0,
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    };
    components.push(component);
    labels[start] = component.label;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++] ?? 0;
      const x = i % width;
      const y = (i - x) / width;
      component.area++;
      component.minX = Math.min(component.minX, x);
      component.minY = Math.min(component.minY, y);
      component.maxX = Math.max(component.maxX, x);
      component.maxY = Math.max(component.maxY, y);
      for (const n of neighbours(i, width, height)) {
        if (labels[n] || !isOpaque(pixels, n)) continue;
        labels[n] = component.label;
        queue[tail++] = n;
      }
    }
  }
  return { labels, components };
}

/**
 * The enclosed areas that aren't solid, numbered from 1. Shapes are 4-connected, so what lies
 * between them is 8-connected: an area joined to the outside only through a diagonal gap between
 * two pixels isn't enclosed.
 */
function holeAreas(
  solid: Uint8Array,
  width: number,
  height: number,
): { labels: Int32Array; areas: { label: number; start: number }[] } {
  const labels = new Int32Array(solid.length);
  const areas: { label: number; start: number }[] = [];
  const queue = new Int32Array(solid.length);
  for (let start = 0; start < solid.length; start++) {
    if (solid[start] || labels[start]) continue;
    // The outside is labelled too, as -1, so it is flooded only once.
    let enclosed = true;
    const area = areas.length + 1;
    labels[start] = area;
    let tail = 0;
    queue[tail++] = start;
    for (let head = 0; head < tail; head++) {
      const i = queue[head] ?? 0;
      const x = i % width;
      const y = (i - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) enclosed = false;
      for (const n of neighbours(i, width, height, true)) {
        if (solid[n] || labels[n]) continue;
        labels[n] = area;
        queue[tail++] = n;
      }
    }
    if (enclosed) {
      areas.push({ label: area, start });
    } else {
      for (let k = 0; k < tail; k++) labels[queue[k] ?? 0] = -1;
    }
  }
  return { labels, areas };
}

/**
 * Follows the outer boundary of the pixels `filled` holds, from the top-left corner of the first
 * of them in scan order (x0, y0), along pixel edges, keeping them on the right (clockwise on
 * screen). Returns the corners where the boundary turns. With `diagonals`, pixels touching only at
 * a corner count as joined; otherwise the boundary turns away from them.
 */
function traceBoundary(
  filled: (x: number, y: number) => boolean,
  x0: number,
  y0: number,
  diagonals: boolean,
): Point[] {
  const loop: Point[] = [];
  let x = x0;
  let y = y0;
  let d = 3; // as if arriving upwards, so the start corner is the first turn
  do {
    // The pixels ahead of corner (x, y) on the left and on the right of direction d.
    const [left, right] =
      d === 0
        ? [filled(x, y - 1), filled(x, y)]
        : d === 1
          ? [filled(x, y), filled(x - 1, y)]
          : d === 2
            ? [filled(x - 1, y), filled(x - 1, y - 1)]
            : [filled(x - 1, y - 1), filled(x, y - 1)];
    // A pixel only diagonally ahead is followed with `diagonals`, and turned away from without.
    const next = left && (diagonals || right) ? (d + 3) % 4 : !right ? (d + 1) % 4 : d;
    if (next !== d) loop.push([x, y]);
    d = next;
    x += DX[d] ?? 0;
    y += DY[d] ?? 0;
  } while (x !== x0 || y !== y0);
  return loop;
}

/**
 * Simplifies every loop, as much as it can without making it cross itself or another loop.
 * Simplifying loops one at a time can make them cross where a wall is only a few pixels thick (a
 * thin ring's hole and outer boundary), which breaks the body into slivers. A loop that crosses is
 * simplified again with a smaller tolerance, down to none: traced loops never cross.
 */
function simplifyShapes(raw: { outer: Point[]; holes: Point[][] }[]): OutlineShape[] {
  const traced = raw.flatMap(({ outer, holes }, shape) =>
    [outer, ...holes].map((loop, k) => ({ shape, hole: k > 0, loop })),
  );
  const level = traced.map(() => 0);
  const simplify = (k: number) => {
    const loop = traced[k]?.loop ?? [];
    const simplified = simplifyLoop(loop, SIMPLIFY_TOLERANCES[level[k] ?? 0]);
    // A small shape or hole is kept whatever its size, as traced if simplifying would leave no
    // area: a line a pixel wide, or a pinhole.
    return simplified.length >= 3 ? simplified : [...loop];
  };
  const loops = traced.map((_, k) => simplify(k));
  const last = SIMPLIFY_TOLERANCES.length - 1;
  for (;;) {
    const crossing = crossingLoops(loops).filter((k) => (level[k] ?? last) < last);
    if (!crossing.length) break;
    for (const k of crossing) {
      level[k] = (level[k] ?? 0) + 1;
      loops[k] = simplify(k);
    }
  }
  const shapes: OutlineShape[] = raw.map((traced) => ({ outer: [], holes: [], traced }));
  traced.forEach(({ shape, hole }, k) => {
    const loop = loops[k] ?? [];
    const target = shapes[shape];
    if (!target || loop.length < 3) return;
    if (hole) target.holes.push(loop);
    else target.outer = loop;
  });
  return shapes.filter((s) => s.outer.length >= 3);
}

/** Ramer–Douglas–Peucker on a closed loop, split at the point furthest from the first. */
export function simplifyLoop(
  loop: readonly Point[],
  tolerance: number = SIMPLIFY_TOLERANCES[0],
): Point[] {
  const first = loop[0];
  if (!first || loop.length <= 3) return [...loop];
  let far = 0;
  let farDistance = -1;
  loop.forEach(([x, y], i) => {
    const distance = (x - first[0]) ** 2 + (y - first[1]) ** 2;
    if (distance > farDistance) [far, farDistance] = [i, distance];
  });
  const a = simplifyChain(loop.slice(0, far + 1), tolerance);
  const b = simplifyChain([...loop.slice(far), first], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function simplifyChain(chain: readonly Point[], tolerance: number): Point[] {
  const first = chain[0];
  const last = chain.at(-1);
  if (!first || !last || chain.length <= 2) return [...chain];
  let index = -1;
  let max = tolerance;
  chain.forEach((point, i) => {
    const distance = distanceToSegment(point, first, last);
    if (distance > max) [index, max] = [i, distance];
  });
  if (index < 0) return [first, last];
  const left = simplifyChain(chain.slice(0, index + 1), tolerance);
  const right = simplifyChain(chain.slice(index), tolerance);
  return [...left.slice(0, -1), ...right];
}

function distanceToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

interface Segment {
  loop: number;
  a: Point;
  b: Point;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * The indices of the loops that cross themselves or another loop. Loops may touch at a shared
 * corner, as traced loops do where two pixels meet only diagonally, but not cross or overlap.
 */
export function crossingLoops(loops: readonly (readonly Point[])[]): number[] {
  const segments: Segment[] = [];
  loops.forEach((loop, k) =>
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length] ?? a;
      segments.push({
        loop: k,
        a,
        b,
        minX: Math.min(a[0], b[0]),
        maxX: Math.max(a[0], b[0]),
        minY: Math.min(a[1], b[1]),
        maxY: Math.max(a[1], b[1]),
      });
    }),
  );
  segments.sort((s, t) => s.minX - t.minX);
  const crossing = new Set<number>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s) continue;
    for (let j = i + 1; j < segments.length; j++) {
      const t = segments[j];
      if (!t || t.minX > s.maxX) break;
      if (t.minY > s.maxY || t.maxY < s.minY) continue;
      if (crosses(s, t)) {
        crossing.add(s.loop);
        crossing.add(t.loop);
      }
    }
  }
  return [...crossing].sort((a, b) => a - b);
}

const same = (p: Point, q: Point) => p[0] === q[0] && p[1] === q[1];
const orient = (a: Point, b: Point, c: Point) =>
  Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
/** Whether `p`, on the line through `a` and `b`, lies strictly between them. */
const between = (p: Point, a: Point, b: Point) =>
  !same(p, a) &&
  !same(p, b) &&
  p[0] >= Math.min(a[0], b[0]) &&
  p[0] <= Math.max(a[0], b[0]) &&
  p[1] >= Math.min(a[1], b[1]) &&
  p[1] <= Math.max(a[1], b[1]);

/**
 * Whether two segments cross, overlap (the same segment twice included), or one ends on the
 * other's middle. Segments that only share an end point don't.
 */
function crosses(s: Segment, t: Segment): boolean {
  if ((same(s.a, t.a) && same(s.b, t.b)) || (same(s.a, t.b) && same(s.b, t.a))) return true;
  const o1 = orient(s.a, s.b, t.a);
  const o2 = orient(s.a, s.b, t.b);
  const o3 = orient(t.a, t.b, s.a);
  const o4 = orient(t.a, t.b, s.b);
  if (o1 * o2 < 0 && o3 * o4 < 0) return true;
  return (
    (o1 === 0 && between(t.a, s.a, s.b)) ||
    (o2 === 0 && between(t.b, s.a, s.b)) ||
    (o3 === 0 && between(s.a, t.a, t.b)) ||
    (o4 === 0 && between(s.b, t.a, t.b))
  );
}
