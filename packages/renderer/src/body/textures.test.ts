import { describe, expect, it } from "vitest";
import { decodePng, MOSSLING, STUDIO_FIXTURES } from "./fixtures/load";
import { isOpaque, type Pixels } from "./pixels";
import { bodyColours } from "./textures";

// The body's texture: faces show the drawing, and walls take the colour of the rim they run back
// from (ADR 0017).

type Colour = readonly [number, number, number];

const hex = (h: string): Colour => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)) as never;
const distance = (a: Colour, b: Colour) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const at = (rgba: Uint8Array | Uint8ClampedArray, i: number): Colour => [
  rgba[i * 4] ?? 0,
  rgba[i * 4 + 1] ?? 0,
  rgba[i * 4 + 2] ?? 0,
];

/** A `width` × `height` image; `paint` gives each pixel's RGBA. */
function image(width: number, height: number, paint: (x: number, y: number) => number[]): Pixels {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
  }
  return { width, height, data };
}

/**
 * Where the walls read the texture: the pixels on either side of the outline, opaque or not, that
 * touch a pixel on the other side (a wall vertex samples the four pixels around its corner).
 */
function rim(pixels: Pixels): number[] {
  const { width, height } = pixels;
  const out: number[] = [];
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const y = (i - x) / width;
    const opaque = isOpaque(pixels, i);
    const across = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx = 0, dy = 0]) => {
      const nx = x + dx;
      const ny = y + dy;
      const outside = nx < 0 || ny < 0 || nx >= width || ny >= height;
      return outside ? opaque : isOpaque(pixels, ny * width + nx) !== opaque;
    });
    if (across) out.push(i);
  }
  return out;
}

describe("bodyColours", () => {
  it("keeps drawn pixels and gives the rest the nearest drawn colour", () => {
    // Red left, green right, a transparent margin of 2 px.
    const pixels = image(10, 6, (x, y) =>
      x < 2 || y < 2 || x >= 8 || y >= 4
        ? [0, 0, 0, 0]
        : x < 5
          ? [220, 0, 0, 255]
          : [0, 200, 0, 255],
    );
    const colours = bodyColours(pixels);
    expect(at(colours, 2 * 10 + 3)).toEqual([220, 0, 0]);
    expect(at(colours, 0)).toEqual([220, 0, 0]);
    expect(at(colours, 5 * 10 + 9)).toEqual([0, 200, 0]);
    expect(colours.every((_, i) => i % 4 !== 3 || colours[i] === 255)).toBe(true);
  });

  it("keeps an outline's colour on the walls", () => {
    // A dark band around a green core: the walls are dark (#71 would leave it out).
    const pixels = image(20, 20, (x, y) => {
      const edge = Math.min(x - 2, y - 2, 17 - x, 17 - y);
      return edge < 0 ? [0, 0, 0, 0] : edge < 2 ? [20, 20, 20, 255] : [0, 200, 0, 255];
    });
    const colours = bodyColours(pixels);
    for (const i of rim(pixels)) expect(at(colours, i)).toEqual([20, 20, 20]);
  });

  it("takes colours only from pixels at least half opaque", () => {
    // A faint red fringe (alpha 100) around a green square: the fringe isn't drawn.
    const pixels = image(10, 10, (x, y) => {
      const edge = Math.min(x - 2, y - 2, 7 - x, 7 - y);
      return edge < 0 ? [0, 0, 0, 0] : edge < 1 ? [255, 0, 0, 100] : [0, 200, 0, 255];
    });
    const colours = bodyColours(pixels);
    expect(at(colours, 2 * 10 + 2)).toEqual([0, 200, 0]);
    expect(at(colours, 0)).toEqual([0, 200, 0]);
  });

  it("colours the walls of a hole from the hole's rim", () => {
    // A green square with a red-rimmed hole in the middle.
    const pixels = image(20, 20, (x, y) => {
      const outer = Math.min(x - 2, y - 2, 17 - x, 17 - y);
      const hole = Math.max(Math.abs(x - 9.5), Math.abs(y - 9.5));
      if (outer < 0 || hole < 2) return [0, 0, 0, 0];
      return hole < 3 ? [220, 0, 0, 255] : [0, 200, 0, 255];
    });
    const colours = bodyColours(pixels);
    expect(at(colours, 9 * 20 + 9)).toEqual([220, 0, 0]);
    expect(at(colours, 0)).toEqual([0, 200, 0]);
  });
});

describe("walls of Studio drawings and the mossling", () => {
  const cases = [
    ...STUDIO_FIXTURES,
    // The mossling's own colours, from its SVG.
    {
      name: "mossling",
      url: MOSSLING,
      palette: ["#2f3b1d", "#2e7556", "#3f9470", "#6b4a2e", "#e59a8a", "#fffaf0", "#7cc7a0"],
    },
  ];

  it.each(cases)("$name: walls take the rim's own colours", async ({ url }) => {
    const pixels = await decodePng(url);
    const colours = bodyColours(pixels);
    for (const i of rim(pixels)) {
      if (isOpaque(pixels, i)) expect(at(colours, i)).toEqual(at(pixels.data, i));
    }
  });

  it.each(cases)("$name: walls don't speckle", async ({ url, palette }) => {
    // Every rim colour is one of the drawing's own, but for 1–2 px seams where two colours meet.
    const pixels = await decodePng(url);
    const colours = bodyColours(pixels);
    const around = rim(pixels);
    const inPalette = around.filter((i) =>
      palette.some((p) => distance(at(colours, i), hex(p)) <= 30),
    );
    expect(inPalette.length / around.length).toBeGreaterThan(0.95);
  });
});
