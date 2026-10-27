import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BODY_DEPTH, buildBody, fallbackBody } from "./body";
import { simplifyLoop, traceOutline } from "./outline";
import type { Pixels } from "./pixels";
import { capColours, sideColours } from "./textures";

const COLOURS: Record<string, [number, number, number]> = {
  g: [0, 200, 0],
  k: [20, 20, 20],
  r: [220, 0, 0],
};

/** Pixels from rows of characters: `.` is transparent, letters are colours from `COLOURS`. */
function art(...rows: string[]): Pixels {
  const width = rows[0]!.length;
  const data = new Uint8Array(width * rows.length * 4);
  rows.forEach((row, y) =>
    [...row].forEach((char, x) => {
      if (char !== ".") data.set([...COLOURS[char]!, 255], (y * width + x) * 4);
    }),
  );
  return { width, height: rows.length, data };
}

/** A `size` × `size` image with a filled square from `from` to `to` (exclusive), outlined in `k`. */
function square(size: number, from: number, to: number, outline = 0): Pixels {
  const rows = Array.from({ length: size }, (_, y) =>
    Array.from({ length: size }, (_, x) => {
      if (x < from || y < from || x >= to || y >= to) return ".";
      const edge = Math.min(x - from, y - from, to - 1 - x, to - 1 - y);
      return edge < outline ? "k" : "g";
    }).join(""),
  );
  return art(...rows);
}

const colourAt = (rgba: Uint8Array, width: number, x: number, y: number) => [
  ...rgba.slice((y * width + x) * 4, (y * width + x) * 4 + 3),
];

describe("traceOutline", () => {
  it("traces a rectangle as its four corners, clockwise on screen", () => {
    const outline = traceOutline(art("......", ".gggg.", ".gggg.", "......"));
    expect(outline.shapes).toEqual([
      [
        [1, 1],
        [5, 1],
        [5, 3],
        [1, 3],
      ],
    ]);
    expect(outline.bounds).toEqual({ minX: 1, minY: 1, maxX: 5, maxY: 3 });
  });

  it("keeps separate shapes, including ones touching only at a corner", () => {
    const outline = traceOutline(art("gg....", "gg....", "..gg..", "..gg.."));
    expect(outline.shapes).toHaveLength(2);
    expect(outline.bounds).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 4 });
  });

  it("drops specks and leaves them out of the bounds", () => {
    const pixels = square(30, 0, 20);
    pixels.data.set([255, 0, 0, 255], (28 * 30 + 28) * 4); // 1 px against 400
    const outline = traceOutline(pixels);
    expect(outline.shapes).toHaveLength(1);
    expect(outline.bounds).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
  });

  it("fills holes, covering any shape inside one", () => {
    const outline = traceOutline(art("ggggggg", "g.....g", "g..r..g", "g.....g", "ggggggg"));
    expect(outline.shapes).toEqual([
      [
        [0, 0],
        [7, 0],
        [7, 5],
        [0, 5],
      ],
    ]);
  });

  it("follows concave outlines", () => {
    // An L: the boundary turns at six corners.
    const outline = traceOutline(art("gg......", "gg......", "gggggggg", "gggggggg"));
    expect(outline.shapes[0]).toHaveLength(6);
  });

  it("finds nothing in a transparent image", () => {
    expect(traceOutline(art("....", "....")).shapes).toEqual([]);
  });
});

describe("simplifyLoop", () => {
  it("straightens a staircase within a pixel", () => {
    const stairs: [number, number][] = [[0, 0]];
    for (let k = 1; k <= 10; k++) stairs.push([k, k - 1], [k, k]);
    stairs.push([0, 10]);
    const simplified = simplifyLoop(stairs);
    expect(simplified.length).toBeLessThanOrEqual(4);
    expect(simplified).toContainEqual([0, 0]);
    expect(simplified).toContainEqual([0, 10]);
  });
});

describe("body textures", () => {
  it("gives transparent pixels on the faces the nearest drawn colour", () => {
    const pixels = art("....", ".kg.", "....");
    const colours = capColours(pixels);
    expect(colourAt(colours, 4, 0, 0)).toEqual(COLOURS.k);
    expect(colourAt(colours, 4, 3, 2)).toEqual(COLOURS.g);
    expect(colours.every((_, i) => i % 4 !== 3 || colours[i] === 255)).toBe(true);
  });

  it("colours the sides from the interior, without the outline", () => {
    // 100 px: a band of 3 px is removed and the blur radius is 2 px.
    const pixels = square(100, 10, 90, 3);
    const colours = sideColours(pixels);
    for (const [x, y] of [
      [10, 50],
      [50, 10],
      [5, 5],
      [95, 95],
    ] as const) {
      expect(colourAt(colours, 100, x, y)).toEqual(COLOURS.g);
    }
  });

  it("removes an outline running diagonally too", () => {
    // A square turned 45°, outlined 3 px deep measured square to its edges: 4–5 px steps inwards.
    const rows = Array.from({ length: 100 }, (_, y) =>
      Array.from({ length: 100 }, (_, x) => {
        const inside = 40 - Math.abs(x - 50) - Math.abs(y - 50);
        return inside <= 0 ? "." : inside < 3 * Math.SQRT2 ? "k" : "g";
      }).join(""),
    );
    const colours = sideColours(art(...rows));
    for (const [x, y] of [
      [30, 30], // on the outline
      [5, 5],
      [95, 50],
    ] as const) {
      expect(colourAt(colours, 100, x, y)).toEqual(COLOURS.g);
    }
  });

  it("keeps the colours of a drawing thinner than the outline band", () => {
    const pixels = square(100, 10, 14, 1); // 4 px wide: no pixel is deeper than the band
    expect(colourAt(sideColours(pixels), 100, 50, 50)).toEqual([20, 20, 20]);
  });
});

describe("buildBody", () => {
  const size = (geometry: THREE.BufferGeometry) => {
    geometry.computeBoundingBox();
    return geometry.boundingBox!;
  };

  it("extrudes the drawing to the given height, feet on the ground, centred", () => {
    // A 40 × 80 px rectangle in a 100 px image, off-centre.
    const pixels = art(
      ...Array.from({ length: 100 }, (_, y) =>
        Array.from({ length: 100 }, (_, x) =>
          x >= 5 && x < 45 && y >= 10 && y < 90 ? "g" : ".",
        ).join(""),
      ),
    );
    const body = buildBody(pixels, 0.8)!;
    const box = size(body.geometry);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(0.8);
    expect(box.min.x).toBeCloseTo(-box.max.x);
    expect(box.min.z).toBeCloseTo(-box.max.z);
    // The rounded edge (4% of the drawn height) grows outward on every side.
    const scale = 0.8 / (80 * 1.08);
    expect(box.max.x - box.min.x).toBeCloseTo((40 + 2 * 80 * 0.04) * scale);
    expect(box.max.z - box.min.z).toBeCloseTo(80 * BODY_DEPTH * scale);
    expect(body.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    expect(body.material).toHaveLength(2);
    body.dispose();
  });

  it("maps the faces onto the drawing's pixels", () => {
    const body = buildBody(art("....", ".gg.", ".gg.", "...."), 1)!;
    const uv = body.geometry.getAttribute("uv");
    const [first, count] = [body.geometry.groups[0]!.start, body.geometry.groups[0]!.count];
    const index = body.geometry.index;
    for (let k = first; k < first + count; k++) {
      const i = index ? index.getX(k) : k;
      // The front and back cover the drawn square, pixels 1–3 of 4.
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0.25 - 1e-6);
      expect(uv.getX(i)).toBeLessThanOrEqual(0.75 + 1e-6);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0.25 - 1e-6);
      expect(uv.getY(i)).toBeLessThanOrEqual(0.75 + 1e-6);
    }
    body.dispose();
  });

  it("builds nothing from a transparent drawing", () => {
    expect(buildBody(art("...", "..."), 1)).toBeUndefined();
  });

  it("has a neutral block of the same proportions as a fallback", () => {
    const block = fallbackBody(0.4);
    const box = size(block.geometry);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(0.4);
    expect(box.max.z - box.min.z).toBeCloseTo(0.4 * BODY_DEPTH);
    block.dispose();
  });
});
