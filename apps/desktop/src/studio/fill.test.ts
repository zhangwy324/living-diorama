import { describe, expect, it } from "vitest";
import { FILL_GROWTH_PX, floodFill, type FillImage } from "./fill";

const SIZE = 256;
const BLUE = "#3c7fc2";
const BLUE_RGB = [0x3c, 0x7f, 0xc2];
const INK = [30, 42, 20];

function blank(width = SIZE, height = SIZE): FillImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

const at = (image: FillImage, x: number, y: number) => {
  const o = (y * image.width + x) * 4;
  return Array.from(image.data.subarray(o, o + 4));
};

function set(image: FillImage, x: number, y: number, rgba: number[]) {
  image.data.set(rgba, (y * image.width + x) * 4);
}

/**
 * A ring of `INK` centred on the canvas, anti-aliased as a canvas draws it: each pixel's alpha is
 * the share of it the ring covers (sampled 8 × 8).
 */
function ring(inner = 40, outer = 52): FillImage {
  const image = blank();
  const c = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let covered = 0;
      for (let sy = 0; sy < 8; sy++) {
        for (let sx = 0; sx < 8; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / 8 - c, y + (sy + 0.5) / 8 - c);
          if (d >= inner && d <= outer) covered++;
        }
      }
      if (covered > 0) set(image, x, y, [...INK, Math.round((covered / 64) * 255)]);
    }
  }
  return image;
}

const distance = (x: number, y: number) => Math.hypot(x + 0.5 - SIZE / 2, y + 0.5 - SIZE / 2);

/** `image` with `pixels` in place of its data. */
const withData = (image: FillImage, data: Uint8ClampedArray) => ({ ...image, data });

describe("floodFill on the background", () => {
  it("fills inside an anti-aliased ring with no pale fringe", () => {
    const before = ring();
    const after = withData(before, floodFill(before, 128, 128, BLUE)!);
    let softEdge = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const d = distance(x, y);
        const [r, g, b, a] = at(before, x, y) as [number, number, number, number];
        const filled = at(after, x, y);
        if (d < 46) {
          // Inside the ring's middle: nothing see-through is left.
          expect(filled[3]).toBe(255);
          if (a > 0 && a < 255) {
            // The soft edge is the ring over the fill.
            softEdge++;
            const k = a / 255;
            expect(filled.slice(0, 3)).toEqual(
              [r, g, b].map((c, j) => Math.round(c * k + BLUE_RGB[j]! * (1 - k))),
            );
          } else if (a === 0) {
            expect(filled).toEqual([...BLUE_RGB, 255]);
          }
        } else {
          // The ring's outer half and the outside are untouched.
          expect(filled).toEqual([r, g, b, a]);
        }
      }
    }
    expect(softEdge).toBeGreaterThan(100);
  });

  it("matches every transparent pixel, whatever its RGB", () => {
    const image = blank(4, 1);
    set(image, 2, 0, [200, 10, 10, 0]);
    const after = withData(image, floodFill(image, 0, 0, BLUE)!);
    for (let x = 0; x < 4; x++) expect(at(after, x, 0)).toEqual([...BLUE_RGB, 255]);
  });

  it("is held by a faint spot in a line, and makes the spot solid", () => {
    // A box outlined 1 px wide whose left side has one pixel at alpha 3.
    const image = blank(20, 20);
    for (let i = 5; i <= 15; i++) {
      for (const [x, y] of [
        [i, 5],
        [i, 15],
        [5, i],
        [15, i],
      ] as const) {
        set(image, x, y, [...INK, 255]);
      }
    }
    set(image, 5, 10, [...INK, 3]);
    const after = withData(image, floodFill(image, 10, 10, BLUE)!);
    expect(at(after, 2, 10)).toEqual([0, 0, 0, 0]);
    expect(at(after, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(at(after, 10, 10)).toEqual([...BLUE_RGB, 255]);
    const spot = at(after, 5, 10);
    expect(spot[3]).toBe(255);
    expect(spot.slice(0, 3)).toEqual(
      INK.map((c, j) => Math.round(c * (3 / 255) + BLUE_RGB[j]! * (1 - 3 / 255))),
    );
  });

  it("is held by a faint gap two pixels deep, and paints both", () => {
    // Transparent on the left, a wall two pixels thick at alpha 3, transparent on the right.
    const image = blank(8, 3);
    for (let y = 0; y < 3; y++) {
      set(image, 3, y, [...INK, 3]);
      set(image, 4, y, [...INK, 3]);
    }
    const after = withData(image, floodFill(image, 0, 1, BLUE)!);
    for (let y = 0; y < 3; y++) {
      expect(at(after, 3, y)[3]).toBe(255);
      expect(at(after, 4, y)[3]).toBe(255);
      expect(at(after, 5, y)).toEqual([0, 0, 0, 0]);
    }
  });

  /** Transparent columns 0–10, then columns of the given alphas, then opaque. */
  function edge(alphas: number[]): FillImage {
    const image = blank(20, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 11; x < 20; x++) set(image, x, y, [...INK, alphas[x - 11] ?? 255]);
    }
    return image;
  }

  it(`grows at most ${FILL_GROWTH_PX} px into a soft edge`, () => {
    const image = edge([10, 20, 30, 40]);
    const after = withData(image, floodFill(image, 0, 0, BLUE)!);
    for (let y = 0; y < 4; y++) {
      expect(at(after, 11, y)[3]).toBe(255);
      expect(at(after, 12, y)[3]).toBe(255);
      expect(at(after, 13, y)).toEqual([...INK, 30]);
    }
  });

  it("grows only onto pixels no less opaque than the one it came from", () => {
    const image = edge([100, 50]);
    const after = withData(image, floodFill(image, 0, 0, BLUE)!);
    expect(at(after, 11, 0)[3]).toBe(255);
    expect(at(after, 12, 0)).toEqual([...INK, 50]);
  });

  it("never grows through a fully opaque pixel", () => {
    const image = edge([255, 10]);
    const after = withData(image, floodFill(image, 0, 0, BLUE)!);
    expect(at(after, 11, 0)).toEqual([...INK, 255]);
    expect(at(after, 12, 0)).toEqual([...INK, 10]);
  });

  it("fills an open area up to the canvas edge", () => {
    // An L of ink that encloses nothing.
    const image = blank();
    for (let i = 50; i < 200; i++) {
      set(image, 50, i, [...INK, 255]);
      set(image, i, 200, [...INK, 255]);
    }
    const after = withData(image, floodFill(image, 100, 100, BLUE)!);
    for (const [x, y] of [
      [0, 0],
      [255, 255],
      [10, 120],
      [255, 0],
    ] as const) {
      expect(at(after, x, y)).toEqual([...BLUE_RGB, 255]);
    }
    expect(at(after, 50, 100)).toEqual([...INK, 255]);
  });

  it("doesn't leak through a wall joined only at corners", () => {
    // A diagonal line of single pixels from corner to corner.
    const image = blank(16, 16);
    for (let i = 0; i < 16; i++) set(image, i, i, [...INK, 255]);
    const after = withData(image, floodFill(image, 12, 2, BLUE)!);
    expect(at(after, 15, 0)).toEqual([...BLUE_RGB, 255]);
    expect(at(after, 0, 15)).toEqual([0, 0, 0, 0]);
    expect(at(after, 2, 12)).toEqual([0, 0, 0, 0]);
  });
});

describe("floodFill on a colour", () => {
  /** An anti-aliased red disc, and a separate red square in the corner. */
  function shapes(): FillImage {
    const image = blank();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const d = distance(x, y);
        if (d < 60) set(image, x, y, [200, 40, 30, 255]);
        else if (d < 61) set(image, x, y, [200, 40, 30, Math.round((61 - d) * 255)]);
      }
    }
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) set(image, x, y, [200, 40, 30, 255]);
    return image;
  }

  it("recolours the connected area of that exact colour and leaves the blended seam", () => {
    const before = shapes();
    const after = withData(before, floodFill(before, 128, 128, BLUE)!);
    let seam = 0;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const old = at(before, x, y);
        const now = at(after, x, y);
        if (distance(x, y) < 60) expect(now).toEqual([...BLUE_RGB, 255]);
        else if (x >= 10 || y >= 10) {
          // The soft edge keeps the old colour; nothing else changes.
          expect(now).toEqual(old);
          if (old[3]! > 0) seam++;
        }
      }
    }
    expect(seam).toBeGreaterThan(100);
    // The separate square is not joined to the disc.
    expect(at(after, 5, 5)).toEqual([200, 40, 30, 255]);
  });

  it("makes a soft-edge pixel's area opaque in the new colour", () => {
    const image = blank(3, 1);
    set(image, 1, 0, [200, 40, 30, 90]);
    const after = withData(image, floodFill(image, 1, 0, BLUE)!);
    expect(at(after, 1, 0)).toEqual([...BLUE_RGB, 255]);
    expect(at(after, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("floodFill does nothing", () => {
  it("on an area already of the fill colour", () => {
    const image = blank(4, 4);
    image.data.fill(255);
    set(image, 0, 0, [...BLUE_RGB, 255]);
    expect(floodFill(image, 0, 0, BLUE)).toBeUndefined();
  });

  it("outside the image", () => {
    const image = blank(4, 4);
    expect(floodFill(image, -1, 0, BLUE)).toBeUndefined();
    expect(floodFill(image, 4, 0, BLUE)).toBeUndefined();
    expect(floodFill(image, 0, 4, BLUE)).toBeUndefined();
  });

  it("to the image it was given", () => {
    const image = ring();
    const copy = Uint8ClampedArray.from(image.data);
    floodFill(image, 128, 128, BLUE);
    floodFill(image, 128, 128 - 46, BLUE);
    expect(image.data).toEqual(copy);
  });
});

it("fills a 256 px image in a few milliseconds", () => {
  const image = ring();
  const empty = blank();
  // Warm up, then time the inside of the ring and a whole empty canvas.
  floodFill(image, 128, 128, BLUE);
  const runs = 20;
  const start = performance.now();
  for (let k = 0; k < runs; k++) {
    floodFill(image, 128, 128, BLUE);
    floodFill(image, 0, 0, BLUE);
    floodFill(empty, 0, 0, BLUE);
  }
  const each = (performance.now() - start) / (runs * 3);
  console.log(`floodFill: ${each.toFixed(2)} ms per fill on 256 × 256`);
  // Generous, so a slow CI machine doesn't fail it; locally it takes a few ms.
  expect(each).toBeLessThan(50);
});
