import { isOpaque, type Pixels } from "./pixels";

// Outlines of a drawing's opaque shapes (ADR 0011 §2).

/** A point in pixel-corner coordinates: x right, y down, (0, 0) the image's top-left corner. */
export type Point = readonly [x: number, y: number];

export interface Outline {
  /** One closed loop per kept shape, its outer boundary simplified. */
  shapes: Point[][];
  /** Bounds of the kept shapes, in the same coordinates. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** A shape under this share of the opaque area is a speck. */
export const SPECK_SHARE = 0.005;
const SIMPLIFY_TOLERANCE = 1;

interface Component {
  label: number;
  /** The first pixel in scan order: its top-left corner is on the outer boundary. */
  start: number;
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Steps for the four directions: right, down, left, up. */
const DX = [1, 0, -1, 0] as const;
const DY = [0, 1, 0, -1] as const;

/** Traces the outer boundary of each opaque shape, dropping specks and shapes inside others. */
export function traceOutline(pixels: Pixels): Outline {
  const { labels, components } = label(pixels);
  const total = components.reduce((sum, c) => sum + c.area, 0);
  const candidates = components
    .filter((c) => c.area >= total * SPECK_SHARE)
    .sort((a, b) => b.area - a.area);

  const kept: { component: Component; loop: Point[] }[] = [];
  for (const component of candidates) {
    const x = component.start % pixels.width;
    const y = Math.floor(component.start / pixels.width);
    // Holes are filled, so a shape inside another's hole is covered by it.
    if (kept.some((k) => contains(k.loop, x + 0.5, y + 0.5))) continue;
    kept.push({ component, loop: traceBoundary(labels, pixels.width, pixels.height, component) });
  }

  const simplified = kept
    .map(({ component, loop }) => ({ component, loop: simplifyLoop(loop) }))
    .filter(({ loop }) => loop.length >= 3);
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const { component } of simplified) {
    bounds.minX = Math.min(bounds.minX, component.minX);
    bounds.minY = Math.min(bounds.minY, component.minY);
    bounds.maxX = Math.max(bounds.maxX, component.maxX + 1);
    bounds.maxY = Math.max(bounds.maxY, component.maxY + 1);
  }
  return { shapes: simplified.map(({ loop }) => loop), bounds };
}

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
      for (let d = 0; d < 4; d++) {
        const nx = x + (DX[d] ?? 0);
        const ny = y + (DY[d] ?? 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (labels[n] || !isOpaque(pixels, n)) continue;
        labels[n] = component.label;
        queue[tail++] = n;
      }
    }
  }
  return { labels, components };
}

/**
 * Follows a component's outer boundary along pixel edges, keeping the shape on the right
 * (clockwise on screen). Returns the corners where the boundary turns.
 */
function traceBoundary(
  labels: Int32Array,
  width: number,
  height: number,
  component: Component,
): Point[] {
  const filled = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === component.label;
  const x0 = component.start % width;
  const y0 = (component.start - x0) / width;
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
    // 4-connected: a pixel only diagonally ahead isn't part of the shape, so turn away from it.
    const next = !right ? (d + 1) % 4 : left ? (d + 3) % 4 : d;
    if (next !== d) loop.push([x, y]);
    d = next;
    x += DX[d] ?? 0;
    y += DY[d] ?? 0;
  } while (x !== x0 || y !== y0);
  return loop;
}

/** Ramer–Douglas–Peucker on a closed loop, split at the point furthest from the first. */
export function simplifyLoop(loop: readonly Point[], tolerance = SIMPLIFY_TOLERANCE): Point[] {
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

/** Even-odd point-in-polygon test. */
function contains(loop: readonly Point[], x: number, y: number): boolean {
  let inside = false;
  let previous = loop.at(-1);
  for (const point of loop) {
    const [xi, yi] = point;
    const [xj, yj] = previous ?? point;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    previous = point;
  }
  return inside;
}
