import type { DrawingBounds } from "@living-diorama/content-schema";
import { solidShapes } from "./outline";
import { neighbours, type Pixels } from "./pixels";

// What in a drawing would extrude badly (ADR 0015 §7, hints): parts too thin to read as solid,
// and shapes that aren't joined, each of which becomes a slab of its own. Measured on the solid
// shapes the body is built from, holes included (ADR 0017): the wall of a ring can be thin.

/**
 * A part is thin where it is narrower than this share of the drawing's height. A body is 0.4 of its
 * height deep by default (ADR 0011, ADR 0017 §11), so such a part is a fin over 13 times deeper
 * than it is wide (over 3 times at the thinnest setting). For a
 * drawing 230 px tall (the guide's height) that is 7 px; the measure scales with the drawing,
 * as the body does.
 */
export const THIN_SHARE = 0.03;

/**
 * The radius of the disc that must fit inside a part for it not to be thin: a disc of radius r
 * covers 2r + 1 pixels across.
 */
export const thinRadius = (drawnHeight: number) =>
  Math.max(1, Math.round((THIN_SHARE * drawnHeight) / 2));

/**
 * Thin areas smaller than this many pixels, for a thin radius r, are ignored: corners and jagged
 * edges lose a few pixels to the same measure. For r = 3, a 3 px wide line 12 px long is enough.
 */
const minThinArea = (radius: number) => 4 * radius * radius;

export interface BodyCheck {
  width: number;
  height: number;
  /** Nothing opaque: there is no body to build. */
  empty: boolean;
  /** Separate shapes, specks left out: the body's slabs. */
  shapes: number;
  /** Thin parts, each a connected area of a few pixels at least. */
  thinParts: number;
  /** 1 for each pixel of a thin part, rows top first. */
  thin: Uint8Array;
  /**
   * The solid shapes' bounds in drawing pixels, as the body is built from them, or undefined when
   * empty. Anchors default from these (`defaultAnchor`, ADR 0020 §10).
   */
  bounds: DrawingBounds | undefined;
  /** 1 for each pixel of every shape but the largest, rows top first. */
  loose: Uint8Array;
}

/** Checks a drawing for thin parts and separate shapes. */
export function checkBody(pixels: Pixels): BodyCheck {
  const { width, height } = pixels;
  const { labels, shapes } = solidShapes(pixels);
  const kept = shapes.map((s) => s.label);
  const keptSet = new Set(kept);

  const shape = new Uint8Array(width * height);
  const loose = new Uint8Array(width * height);
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let i = 0; i < shape.length; i++) {
    const label = labels[i] ?? 0;
    if (!keptSet.has(label)) continue;
    shape[i] = 1;
    if (label !== kept[0]) loose[i] = 1;
    const y = Math.floor(i / width);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    left = Math.min(left, i % width);
    right = Math.max(right, i % width);
  }

  const radius = thinRadius(bottom - top + 1);
  const thin = thinPixels(shape, width, height, radius);
  const parts = components(thin, width, height, true);
  const minArea = minThinArea(radius);
  let thinParts = 0;
  for (let i = 0; i < thin.length; i++) {
    const label = parts.labels[i] ?? 0;
    if (label && (parts.areas[label - 1] ?? 0) < minArea) thin[i] = 0;
  }
  for (const area of parts.areas) if (area >= minArea) thinParts++;

  const empty = kept.length === 0;
  // Right and bottom exclusive, like the traced outline's.
  const bounds = empty ? undefined : { left, top, right: right + 1, bottom: bottom + 1 };
  return { width, height, empty, shapes: kept.length, thinParts, thin, loose, bounds };
}

/** Labels the set pixels' connected areas from 1; `areas[label - 1]` is each one's size. */
function components(
  mask: Uint8Array,
  width: number,
  height: number,
  diagonals: boolean,
): { labels: Int32Array; areas: number[] } {
  const labels = new Int32Array(mask.length);
  const areas: number[] = [];
  const queue = new Int32Array(mask.length);
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const label = areas.length + 1;
    let area = 0;
    let tail = 0;
    labels[start] = label;
    queue[tail++] = start;
    for (let head = 0; head < tail; head++) {
      const i = queue[head] ?? 0;
      area++;
      for (const n of neighbours(i, width, height, diagonals)) {
        if (!mask[n] || labels[n]) continue;
        labels[n] = label;
        queue[tail++] = n;
      }
    }
    areas.push(area);
  }
  return { labels, areas };
}

/**
 * The set pixels no disc of `radius` inside the mask covers: the mask minus its morphological
 * opening, with Euclidean distances. Outside the image counts as empty.
 */
function thinPixels(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const r2 = radius * radius;
  // Where a disc's centre fits: further than `radius` from every empty pixel.
  const toEmpty = distanceSquared(width, height, (i) => !mask[i]);
  const centres = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) centres[i] = (toEmpty[i] ?? 0) > r2 ? 1 : 0;
  // What those discs cover.
  const toCentre = distanceSquared(width, height, (i) => centres[i] === 1, false);
  const thin = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) {
    thin[i] = mask[i] && (toCentre[i] ?? Infinity) > r2 ? 1 : 0;
  }
  return thin;
}

/**
 * Each pixel's squared Euclidean distance to the nearest pixel where `source` holds
 * (Felzenszwalb and Huttenlocher's separable transform). With `edgeIsSource`, the pixels just
 * outside the image count as sources too.
 */
function distanceSquared(
  width: number,
  height: number,
  source: (i: number) => boolean,
  edgeIsSource = true,
): Float64Array {
  // Padded by one pixel on every side, so the image's edge can be a source.
  const w = width + 2;
  const h = height + 2;
  const grid = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const inside = x > 0 && y > 0 && x <= width && y <= height;
      const isSource = inside ? source((y - 1) * width + (x - 1)) : edgeIsSource;
      grid[y * w + x] = isSource ? 0 : Infinity;
    }
  }
  const line = new Float64Array(Math.max(w, h));
  const out = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = grid[y * w + x] ?? Infinity;
    transform1d(line, h, out, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = out[y] ?? Infinity;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) line[x] = grid[y * w + x] ?? Infinity;
    transform1d(line, w, out, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = out[x] ?? Infinity;
  }
  const result = new Float64Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) result[y * width + x] = grid[(y + 1) * w + x + 1] ?? Infinity;
  }
  return result;
}

/** The lower envelope of parabolas rooted at each finite sample of `f` (the 1D transform). */
function transform1d(
  f: Float64Array,
  n: number,
  out: Float64Array,
  v: Int32Array,
  z: Float64Array,
): void {
  const at = (i: number) => f[i] ?? Infinity;
  const intersect = (q: number, p: number) => (at(q) + q * q - (at(p) + p * p)) / (2 * (q - p));
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (at(q) === Infinity) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    let s = intersect(q, v[k] ?? 0);
    // z[0] is -∞, so this stops at the first parabola at the latest.
    while (s <= (z[k] ?? -Infinity)) s = intersect(q, v[--k] ?? 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (k < 0) {
    out.fill(Infinity, 0, n);
    return;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while ((z[j + 1] ?? Infinity) < q) j++;
    const p = v[j] ?? 0;
    out[q] = (q - p) * (q - p) + at(p);
  }
}
