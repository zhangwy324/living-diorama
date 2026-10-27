import { isOpaque, type Pixels } from "./pixels";

// The two textures of a body (ADR 0011 §5). Both are fully opaque RGBA, rows top first.

/** The outline band removed for the sides, as a share of the image's longer side. */
const OUTLINE_BAND = 0.03;
/** Blur radius for the sides, as a share of the image's longer side. */
const SIDE_BLUR = 0.015;

/** The drawing, its transparent pixels taking the colour of the nearest opaque pixel. */
export function capColours(pixels: Pixels): Uint8Array {
  const seeds = new Uint8Array(pixels.width * pixels.height);
  for (let i = 0; i < seeds.length; i++) seeds[i] = isOpaque(pixels, i) ? 1 : 0;
  return spread(pixels, seeds);
}

/** The drawing's interior colours, outline band removed, spread over the image and blurred. */
export function sideColours(pixels: Pixels): Uint8Array {
  const { width, height } = pixels;
  const longest = Math.max(width, height);
  const band = Math.max(1, Math.round(longest * OUTLINE_BAND));
  const depth = depthInside(pixels);
  const seeds = new Uint8Array(width * height);
  let interior = 0;
  for (let i = 0; i < seeds.length; i++) {
    if ((depth[i] ?? 0) > band) interior += seeds[i] = 1;
  }
  // A drawing thinner than the band everywhere keeps its colours as they are.
  if (!interior) for (let i = 0; i < seeds.length; i++) seeds[i] = isOpaque(pixels, i) ? 1 : 0;
  return boxBlur(
    spread(pixels, seeds),
    width,
    height,
    Math.max(1, Math.round(longest * SIDE_BLUR)),
  );
}

/**
 * Each pixel's 8-connected distance to the nearest transparent pixel or the image's edge. Steps
 * along rows and columns would overstate it by up to √2 where the outline runs diagonally, keeping
 * outline pixels there as side colours.
 */
function depthInside(pixels: Pixels): Int32Array {
  const { width, height } = pixels;
  const depth = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(width * height);
  let tail = 0;
  for (let i = 0; i < depth.length; i++) {
    const x = i % width;
    const y = (i - x) / width;
    if (!isOpaque(pixels, i)) depth[i] = 0;
    else if (x === 0 || y === 0 || x === width - 1 || y === height - 1) depth[i] = 1;
    else continue;
    queue[tail++] = i;
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head] ?? 0;
    for (const n of neighbours(i, width, height, true)) {
      if (depth[n] !== -1) continue;
      depth[n] = (depth[i] ?? 0) + 1;
      queue[tail++] = n;
    }
  }
  return depth;
}

/** Copies the seed pixels' colours outward until every pixel has the nearest seed's colour. */
function spread(pixels: Pixels, seeds: Uint8Array): Uint8Array {
  const { width, height, data } = pixels;
  const out = new Uint8Array(width * height * 4);
  const done = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let tail = 0;
  for (let i = 0; i < seeds.length; i++) {
    if (!seeds[i]) continue;
    out.set([...data.subarray(i * 4, i * 4 + 3), 255], i * 4);
    done[i] = 1;
    queue[tail++] = i;
  }
  for (let head = 0; head < tail; head++) {
    const i = queue[head] ?? 0;
    for (const n of neighbours(i, width, height)) {
      if (done[n]) continue;
      out.copyWithin(n * 4, i * 4, i * 4 + 4);
      done[n] = 1;
      queue[tail++] = n;
    }
  }
  return out;
}

function* neighbours(
  i: number,
  width: number,
  height: number,
  diagonals = false,
): Generator<number> {
  const x = i % width;
  const left = x > 0;
  const right = x < width - 1;
  const up = i >= width;
  const down = i < width * (height - 1);
  if (left) yield i - 1;
  if (right) yield i + 1;
  if (up) yield i - width;
  if (down) yield i + width;
  if (!diagonals) return;
  if (up && left) yield i - width - 1;
  if (up && right) yield i - width + 1;
  if (down && left) yield i + width - 1;
  if (down && right) yield i + width + 1;
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
