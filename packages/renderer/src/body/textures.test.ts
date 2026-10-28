import { describe, expect, it } from "vitest";
import edgeDetails from "./fixtures/edge-details.png?inline";
import noOutline from "./fixtures/no-outline.png?inline";
import outline from "./fixtures/outline.png?inline";
import separateShapes from "./fixtures/separate-shapes.png?inline";
import thickOutline from "./fixtures/thick-outline.png?inline";
import thinLimbs from "./fixtures/thin-limbs.png?inline";
import { isOpaque, type Pixels } from "./pixels";
import { outlineColour, sideColours } from "./textures";

// Body sides on drawings made in the Creation Studio (issue #40). Each fixture is a drawing's
// `drawing.json` and the `appearance.png` the Studio rasterised from it (see fixtures/README.md).

type Colour = readonly [number, number, number];

const hex = (h: string): Colour => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)) as never;
const close = (a: Colour, b: Colour, tolerance = 50) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tolerance;
const at = (rgba: Uint8Array | Uint8ClampedArray, i: number): Colour => [
  rgba[i * 4] ?? 0,
  rgba[i * 4 + 1] ?? 0,
  rgba[i * 4 + 2] ?? 0,
];

/** Decodes an 8-bit RGBA, non-interlaced PNG data URL, as the Studio writes them. */
async function decodePng(url: string): Promise<Pixels> {
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      [width, height] = [view.getUint32(offset + 8), view.getUint32(offset + 12)];
      if (chunk[8] !== 8 || chunk[9] !== 6 || chunk[12] !== 0) throw new Error("Not 8-bit RGBA");
    }
    if (type === "IDAT") idat.push(chunk);
    offset += length + 12;
  }
  const stream = new Blob(idat as BlobPart[])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = width * 4;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= 4 ? (data[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (data[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (data[(y - 1) * stride + x - 4] ?? 0) : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter ?? 0] ?? 0;
      data[y * stride + x] = (value + predictor) & 255;
    }
  }
  return { width, height, data };
}

/** The drawing's edge: opaque pixels next to a transparent one or the image's edge. */
function edge(pixels: Pixels): number[] {
  const { width, height } = pixels;
  const out: number[] = [];
  for (let i = 0; i < width * height; i++) {
    if (!isOpaque(pixels, i)) continue;
    const x = i % width;
    const y = (i - x) / width;
    const clear = (dx: number, dy: number) =>
      x + dx < 0 ||
      y + dy < 0 ||
      x + dx >= width ||
      y + dy >= height ||
      !isOpaque(pixels, i + dy * width + dx);
    if (clear(1, 0) || clear(-1, 0) || clear(0, 1) || clear(0, -1)) out.push(i);
  }
  return out;
}

/** The share of `pixels` for which `test` holds. */
const share = (pixels: number[], test: (i: number) => boolean) =>
  pixels.filter(test).length / pixels.length;

/** The opaque pixel furthest along `direction` (x, y), e.g. the tip of a limb. */
function extreme(pixels: Pixels, direction: readonly [number, number]): number {
  let best = -1;
  let score = -Infinity;
  for (let i = 0; i < pixels.width * pixels.height; i++) {
    if (!isOpaque(pixels, i)) continue;
    const x = i % pixels.width;
    const s = x * direction[0] + ((i - x) / pixels.width) * direction[1];
    if (s > score) [best, score] = [i, s];
  }
  return best;
}

describe("side colours of Studio drawings", () => {
  const sides = async (url: string) => {
    const pixels = await decodePng(url);
    return { pixels, sides: sideColours(pixels), edge: edge(pixels) };
  };

  it("drop a thin dark outline", async () => {
    const { pixels, sides: rgba, edge: around } = await sides(outline);
    expect(outlineColour(pixels)).toEqual(hex("#1e2a14"));
    expect(share(around, (i) => close(at(rgba, i), hex("#8a56b5")))).toBe(1);
  });

  it("keep the edge colour of a drawing without an outline", async () => {
    const { pixels, sides: rgba, edge: around } = await sides(noOutline);
    expect(outlineColour(pixels)).toBeUndefined();
    expect(share(around, (i) => close(at(rgba, i), hex("#7a4a2a"), 10))).toBe(1);
  });

  it("drop a thick outline of another colour", async () => {
    const { pixels, sides: rgba, edge: around } = await sides(thickOutline);
    expect(outlineColour(pixels)).toEqual(hex("#f0a6c0"));
    expect(share(around, (i) => close(at(rgba, i), hex("#f2cf3c")))).toBe(1);
  });

  it("show details at the edge where they are, without streaks from inside", async () => {
    // A dark body without an outline, two yellow patches on its edge and blue antennae on top.
    const { pixels, sides: rgba, edge: around } = await sides(edgeDetails);
    expect(outlineColour(pixels)).toBeUndefined();
    expect(share(around, (i) => close(at(rgba, i), at(pixels.data, i), 60))).toBeGreaterThan(0.8);
    // Where the antennae go into the body, its top stays dark.
    const blue = hex("#3c7fc2");
    const body = around.filter((i) => close(at(pixels.data, i), hex("#1e2a14"), 10));
    expect(share(body, (i) => close(at(rgba, i), blue, 80))).toBeLessThan(0.02);
  });

  it("give thin limbs their own colour", async () => {
    const { pixels, sides: rgba, edge: around } = await sides(thinLimbs);
    expect(outlineColour(pixels)).toEqual(hex("#1e2a14"));
    const pink = hex("#f0a6c0");
    const brown = hex("#7a4a2a");
    expect(share(around, (i) => close(at(rgba, i), hex("#1e2a14")))).toBe(0);
    // Blurred where pink and brown meet.
    expect(
      share(around, (i) => close(at(rgba, i), pink) || close(at(rgba, i), brown)),
    ).toBeGreaterThan(0.9);
    // The arms stick out left and right.
    expect(at(rgba, extreme(pixels, [-1, 0]))).toSatisfy((c: Colour) => close(c, brown));
    expect(at(rgba, extreme(pixels, [1, 0]))).toSatisfy((c: Colour) => close(c, brown));
  });

  it("give separate shapes their own colours", async () => {
    const { pixels, sides: rgba, edge: around } = await sides(separateShapes);
    expect(outlineColour(pixels)).toBeUndefined();
    expect(share(around, (i) => close(at(rgba, i), at(pixels.data, i)))).toBeGreaterThan(0.95);
    // A pink tail floats left of the yellow body.
    expect(at(rgba, extreme(pixels, [-1, 0]))).toSatisfy((c: Colour) => close(c, hex("#f0a6c0")));
    expect(at(rgba, extreme(pixels, [1, 0]))).toSatisfy((c: Colour) => close(c, hex("#f2cf3c")));
  });
});
