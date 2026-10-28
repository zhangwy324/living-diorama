// The Studio's fill tool (ADR 0017 §10): a flood fill on the drawing's RGBA pixels, with no
// tolerance and no gap closing. Pure, so it is tested without a canvas; beside `drawing.ts`, which
// replays fills for drawings made by code.

/** RGBA pixels, row by row, un-premultiplied as canvas `ImageData` holds them. */
export interface FillImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * How far a background fill reaches into the soft edges of the strokes around it, in pixels.
 * Two is enough for the canvas's anti-aliased edges, which are about a pixel wide.
 */
export const FILL_GROWTH_PX = 2;

/**
 * Fills from the pixel at (`x`, `y`) with `color` (`#rrggbb`) and returns the new pixels, or
 * undefined when nothing changes: a click outside the image, or on an area already of that colour.
 * `image` is never changed.
 *
 * - **The area** is the pixels side-joined to the one clicked that match it exactly: on the
 *   background (alpha 0) every fully transparent pixel, whatever its RGB; on a colour the exact
 *   RGBA. Anything visible stops a background fill, and an area open to the canvas edge fills up
 *   to it.
 * - **On the background** the area then grows into the strokes' soft edges by up to
 *   `FILL_GROWTH_PX`, stepping from pixel to side-joined pixel only onto pixels that are partly
 *   transparent and no less opaque than the one stepped from. Fully opaque pixels are the wall: the
 *   growth never enters them (painting under them would change nothing anyway) and never steps back
 *   onto transparent ones. The whole lot is painted under the drawing (`destination-over`), so the
 *   soft edges blend into the fill with no pale fringe, and every pixel painted ends up opaque.
 * - **On a colour** the area becomes the new colour, opaque. Nothing lies under a colour, so the
 *   blended pixels around it keep the old colour: a seam about a pixel wide.
 */
export function floodFill(
  image: FillImage,
  x: number,
  y: number,
  color: string,
): Uint8ClampedArray<ArrayBuffer> | undefined {
  const { width, height, data } = image;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return undefined;
  if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
  const rgb = parseColor(color);
  const seed = y * width + x;
  // A 32-bit view needs a 4-byte-aligned start; ImageData always has one, a subarray may not.
  const aligned = data.byteOffset % 4 === 0 ? data : data.slice();
  const pixels = new Uint32Array(aligned.buffer, aligned.byteOffset, width * height);
  const out = new Uint8ClampedArray(data);

  if (data[seed * 4 + 3] !== 0) {
    // A pixel at a time, as one 32-bit number in the platform's byte order.
    const old = pixels[seed];
    const replacement = new Uint32Array(Uint8ClampedArray.of(...rgb, 255).buffer)[0] ?? 0;
    if (old === replacement) return undefined;
    const area = flood(width, height, seed, (i) => pixels[i] === old);
    const outPixels = new Uint32Array(out.buffer);
    for (let i = 0; i < area.length; i++) if (area[i]) outPixels[i] = replacement;
    return out;
  }

  const area = flood(width, height, seed, (i) => data[i * 4 + 3] === 0);
  const painted = growIntoEdges(width, height, data, area);
  for (let i = 0; i < painted.length; i++) {
    if (!painted[i]) continue;
    // The drawing over the fill colour, with colours un-premultiplied: c·a + fill·(1 − a).
    const o = i * 4;
    const a = (data[o + 3] ?? 0) / 255;
    const under = (c: 0 | 1 | 2) => (data[o + c] ?? 0) * a + rgb[c] * (1 - a);
    out[o] = under(0);
    out[o + 1] = under(1);
    out[o + 2] = under(2);
    out[o + 3] = 255;
  }
  return out;
}

/**
 * The pixels side-joined to `seed` that `matches`, as a mask: a scanline flood fill, which
 * marks a run of a row at a time and looks for new runs only in the rows just above and below it.
 */
export function flood(
  width: number,
  height: number,
  seed: number,
  matches: (i: number) => boolean,
): Uint8Array {
  const area = new Uint8Array(width * height);
  const open = (i: number) => area[i] === 0 && matches(i);
  const stack = [seed];
  for (let start = stack.pop(); start !== undefined; start = stack.pop()) {
    if (!open(start)) continue;
    const row = start - (start % width);
    let left = start;
    while (left > row && open(left - 1)) left--;
    let right = start;
    while (right < row + width - 1 && open(right + 1)) right++;
    area.fill(1, left, right + 1);
    for (const next of [row - width, row + width]) {
      if (next < 0 || next >= area.length) continue;
      // The first pixel of each open run beside this one; the rest of the run follows from it.
      let inRun = false;
      for (let i = left - row + next; i <= right - row + next; i++) {
        const isOpen = open(i);
        if (isOpen && !inRun) stack.push(i);
        inRun = isOpen;
      }
    }
  }
  return area;
}

/**
 * `area` and the soft-edge pixels a background fill grows into (see `floodFill`), as a mask. Each
 * step out goes from a pixel reached at the step before, breadth first, so a pixel counts as soon
 * as any path of `FILL_GROWTH_PX` steps or fewer reaches it.
 */
function growIntoEdges(
  width: number,
  height: number,
  data: Uint8ClampedArray,
  area: Uint8Array,
): Uint8Array {
  const painted = Uint8Array.from(area);
  const alpha = (i: number) => data[i * 4 + 3] ?? 0;
  let frontier: number[] = [];
  for (let i = 0; i < area.length; i++) if (area[i]) frontier.push(i);
  for (let step = 0; step < FILL_GROWTH_PX && frontier.length > 0; step++) {
    const next: number[] = [];
    for (const from of frontier) {
      const x = from % width;
      const floor = alpha(from);
      const reach = (to: number) => {
        if (painted[to]) return;
        const a = alpha(to);
        if (a === 0 || a === 255 || a < floor) return;
        painted[to] = 1;
        next.push(to);
      };
      if (x > 0) reach(from - 1);
      if (x < width - 1) reach(from + 1);
      if (from >= width) reach(from - width);
      if (from < (height - 1) * width) reach(from + width);
    }
    frontier = next;
  }
  return painted;
}

function parseColor(color: string): [number, number, number] {
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`Not a colour like "#7fae5a": ${color}`);
  const channel = (at: number) => parseInt(color.slice(at, at + 2), 16);
  return [channel(1), channel(3), channel(5)];
}
