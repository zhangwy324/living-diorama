import { nearest } from "./distance";
import { isOpaque, type Pixels } from "./pixels";

// The two textures of a body (ADR 0011 §5). Both are fully opaque RGBA, rows top first.

/** The boundary, read for the outline colour: opaque pixels at most this deep, in pixels. */
const BOUNDARY_DEPTH = 2;
/** Colours this close (RGB distance) count as one, so an outline's own shading stays one colour. */
const COLOUR_TOLERANCE = 40;
/** The share of the boundary an outline's colour must cover. */
const OUTLINE_COVER = 0.5;
/** An outline is at most this share of the drawing's deepest point; anything thicker is body. */
const OUTLINE_MAX_THICKNESS = 1 / 3;
/** Pixels this close to the outline are blended with it, so they are dropped with it. */
const OUTLINE_MARGIN = 2;
/** Blur radius for the sides, as a share of the image's longer side. */
const SIDE_BLUR = 0.015;

type Colour = readonly [number, number, number];

/** The drawing, its transparent pixels taking the colour of the nearest opaque pixel. */
export function capColours(pixels: Pixels): Uint8Array {
  return nearestColours(pixels, opaqueMask(pixels));
}

/**
 * The drawing's colours without its outline, spread over the image and blurred. The outline is
 * measured from the drawing: the colour covering most of its boundary, if it is a thin band around
 * a differently coloured core (`outlineColour`).
 */
export function sideColours(pixels: Pixels): Uint8Array {
  const { width, height } = pixels;
  const opaque = opaqueMask(pixels);
  const outline = outlineColour(pixels);
  let seeds = opaque;
  if (outline) {
    const drawn = new Uint8Array(width * height);
    for (let i = 0; i < drawn.length; i++) drawn[i] = opaque[i] && near(pixels, i, outline) ? 1 : 0;
    const { distance2 } = nearest(drawn, width, height);
    const kept = opaque.map((o, i) => (o && (distance2[i] ?? 0) > OUTLINE_MARGIN ** 2 ? 1 : 0));
    // A drawing that is all outline keeps its colours as they are.
    if (kept.includes(1)) seeds = kept;
  }
  return boxBlur(
    nearestColours(pixels, seeds),
    width,
    height,
    Math.max(1, Math.round(Math.max(width, height) * SIDE_BLUR)),
  );
}

/**
 * The colour covering most of the drawing's boundary, if it is an outline: a different colour from
 * the drawing's core (its pixels at least half as deep as the deepest), and a band no thicker than
 * `OUTLINE_MAX_THICKNESS` of that depth. Its thickness is measured over the pixels of its colour
 * joined to the boundary, so eyes and other details of the same colour don't count.
 */
export function outlineColour(pixels: Pixels): Colour | undefined {
  const depth = depthInside(pixels);
  const deepest = depth.reduce((a, b) => Math.max(a, b), 0);
  const boundary = (i: number) => (depth[i] ?? 0) > 0 && (depth[i] ?? 0) <= BOUNDARY_DEPTH;
  const outline = commonest(pixels, boundary);
  const core = commonest(pixels, (i) => (depth[i] ?? 0) >= deepest / 2);
  if (!outline || !core || close(outline, core)) return undefined;

  const joined = new Uint8Array(depth.length);
  const queue: number[] = [];
  let boundaryCount = 0;
  for (let i = 0; i < depth.length; i++) {
    if (!boundary(i)) continue;
    boundaryCount++;
    if (near(pixels, i, outline)) queue.push(i);
  }
  if (queue.length < boundaryCount * OUTLINE_COVER) return undefined;
  for (const i of queue) joined[i] = 1;
  const { width, height } = pixels;
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head] ?? 0;
    const x = i % width;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const n = i + dy * width + dx;
        if (x + dx < 0 || x + dx >= width || n < 0 || n >= width * height || joined[n]) continue;
        if (!(depth[n] ?? 0) || !near(pixels, n, outline)) continue;
        joined[n] = 1;
        queue.push(n);
      }
    }
  }
  // Most of the band, so a few pixels where the outline meets a detail don't make it thick.
  const depths = queue.map((i) => depth[i] ?? 0).sort((a, b) => a - b);
  const thickness = depths[Math.floor(depths.length * 0.9)] ?? 0;
  return thickness <= deepest * OUTLINE_MAX_THICKNESS ? outline : undefined;
}

function opaqueMask(pixels: Pixels): Uint8Array {
  const mask = new Uint8Array(pixels.width * pixels.height);
  for (let i = 0; i < mask.length; i++) mask[i] = isOpaque(pixels, i) ? 1 : 0;
  return mask;
}

/** Each opaque pixel's distance to the nearest transparent pixel or past the image's edge; 0 outside. */
function depthInside(pixels: Pixels): Float64Array {
  const { width, height } = pixels;
  const opaque = opaqueMask(pixels);
  const { distance2 } = nearest(
    opaque.map((o) => 1 - o),
    width,
    height,
  );
  return Float64Array.from(opaque, (o, i) => {
    if (!o) return 0;
    const x = i % width;
    const y = (i - x) / width;
    const edge = Math.min(x + 1, y + 1, width - x, height - y);
    return Math.min(Math.sqrt(distance2[i] ?? 0), edge);
  });
}

/** The commonest exact colour among the pixels `pick` chooses. */
function commonest(pixels: Pixels, pick: (i: number) => boolean): Colour | undefined {
  const counts = new Map<number, number>();
  let best: number | undefined;
  for (let i = 0; i < pixels.width * pixels.height; i++) {
    if (!pick(i)) continue;
    const [r, g, b] = colourAt(pixels, i);
    const key = (r << 16) | (g << 8) | b;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (best === undefined || count > (counts.get(best) ?? 0)) best = key;
  }
  return best === undefined ? undefined : [(best >> 16) & 255, (best >> 8) & 255, best & 255];
}

function colourAt(pixels: Pixels, i: number): Colour {
  const { data } = pixels;
  return [data[i * 4] ?? 0, data[i * 4 + 1] ?? 0, data[i * 4 + 2] ?? 0];
}

/** Whether two colours are within `COLOUR_TOLERANCE` of each other. */
function close(a: Colour, b: Colour): boolean {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 <= COLOUR_TOLERANCE ** 2;
}

/** Whether pixel `i`'s colour is close to `colour`. */
const near = (pixels: Pixels, i: number, colour: Colour) => close(colourAt(pixels, i), colour);

/** Every pixel takes the colour of the nearest seed pixel. */
function nearestColours(pixels: Pixels, seeds: Uint8Array): Uint8Array {
  const { width, height, data } = pixels;
  const { index } = nearest(seeds, width, height);
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < index.length; i++) {
    const seed = index[i] ?? -1;
    if (seed >= 0) out.set(data.subarray(seed * 4, seed * 4 + 3), i * 4);
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Separable box blur of the colour channels, clamped at the edges. */
function boxBlur(rgba: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  const pass = (
    source: Uint8Array,
    along: number,
    across: number,
    stride: number,
    step: number,
  ) => {
    const target = new Uint8Array(source);
    const size = radius * 2 + 1;
    for (let line = 0; line < across; line++) {
      const base = line * stride;
      for (let c = 0; c < 3; c++) {
        const at = (k: number) =>
          source[base + Math.max(0, Math.min(along - 1, k)) * step + c] ?? 0;
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += at(k);
        for (let k = 0; k < along; k++) {
          target[base + k * step + c] = Math.round(sum / size);
          sum += at(k + radius + 1) - at(k - radius);
        }
      }
    }
    return target;
  };
  const rows = pass(rgba, width, height, width * 4, 4);
  return pass(rows, height, width, 4, width * 4);
}
