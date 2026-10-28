import { describe, expect, it } from "vitest";
import { decodePng, MOSSLING, STUDIO_FIXTURES } from "./fixtures/load";
import { crossingLoops, simplifyLoop, traceOutline, type Outline, type Point } from "./outline";
import { checkBody } from "./check";
import type { Pixels } from "./pixels";

/** Pixels from rows of characters: `.` is transparent, anything else opaque. */
function art(...rows: string[]): Pixels {
  const width = rows[0]!.length;
  const data = new Uint8Array(width * rows.length * 4);
  rows.forEach((row, y) =>
    [...row].forEach((char, x) => {
      if (char !== ".") data.set([0, 200, 0, 255], (y * width + x) * 4);
    }),
  );
  return { width, height: rows.length, data };
}

/** A `size` px image of a ring of radius `r` and width `w` px, its alpha from `coverage`. */
function ring(
  size: number,
  r: number,
  w: number,
  centre: Point,
  stretch: number,
  coverage: (distance: number) => number,
): Pixels {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - centre[0], (y + 0.5 - centre[1]) * stretch);
      const alpha = Math.round(255 * Math.max(0, Math.min(1, coverage(w / 2 - Math.abs(d - r)))));
      data.set([200, 0, 0, alpha], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}
/** Anti-aliased like a canvas stroke: alpha ramps over a pixel at each edge. */
const smooth = (inside: number) => inside + 0.5;
/** Hard-edged: a pixel is in if its centre is. */
const hard = (inside: number) => (inside >= 0 ? 1 : 0);

const holeCount = (outline: Outline) => outline.shapes.reduce((n, s) => n + s.holes.length, 0);
const loops = (outline: Outline) => outline.shapes.flatMap((s) => [s.outer, ...s.holes]);

/** Even-odd point-in-polygon test. */
function contains(loop: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  loop.forEach(([xi, yi], i) => {
    const [xj, yj] = loop.at(i - 1)!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  });
  return inside;
}

describe("traceOutline", () => {
  it("traces a rectangle as its four corners, clockwise on screen", () => {
    const outline = traceOutline(art("......", ".gggg.", ".gggg.", "......"));
    expect(outline.shapes).toMatchObject([
      {
        outer: [
          [1, 1],
          [5, 1],
          [5, 3],
          [1, 3],
        ],
        holes: [],
      },
    ]);
    expect(outline.bounds).toEqual({ minX: 1, minY: 1, maxX: 5, maxY: 3 });
  });

  it("keeps separate shapes, including ones touching only at a corner", () => {
    const outline = traceOutline(art("gg....", "gg....", "..gg..", "..gg.."));
    expect(outline.shapes).toHaveLength(2);
    expect(outline.bounds).toEqual({ minX: 0, minY: 0, maxX: 4, maxY: 4 });
  });

  it("drops specks and leaves them out of the bounds", () => {
    const rows = Array.from({ length: 30 }, (_, y) =>
      Array.from({ length: 30 }, (_, x) => (x < 20 && y < 20 ? "g" : ".")).join(""),
    );
    rows[28] = `${".".repeat(28)}g.`; // 1 px against 400
    const outline = traceOutline(art(...rows));
    expect(outline.shapes).toHaveLength(1);
    expect(outline.bounds).toEqual({ minX: 0, minY: 0, maxX: 20, maxY: 20 });
  });

  it("keeps a ring's hole", () => {
    const outline = traceOutline(art("gggggg", "g....g", "g....g", "gggggg"));
    expect(outline.shapes).toHaveLength(1);
    expect(outline.shapes[0]!.holes).toHaveLength(1);
    expect(new Set(outline.shapes[0]!.holes[0]!.map(String))).toEqual(
      new Set(["1,1", "5,1", "5,3", "1,3"]),
    );
  });

  it("keeps a shape a pixel wide, which simplifying would flatten, and sizes the body by it", () => {
    // A 40 px block, and apart from it a vertical line 1 px wide and 80 px tall.
    const rows = Array.from({ length: 100 }, (_, y) =>
      Array.from({ length: 60 }, (_, x) =>
        (x < 40 && y >= 50 && y < 90) || (x === 50 && y >= 10 && y < 90) ? "g" : ".",
      ).join(""),
    );
    const pixels = art(...rows);
    const outline = traceOutline(pixels);
    expect(outline.shapes).toHaveLength(2);
    expect(outline.bounds).toEqual({ minX: 0, minY: 10, maxX: 51, maxY: 90 });
    // The hints see the same shapes as the body.
    expect(checkBody(pixels).shapes).toBe(2);
  });

  it("keeps a hole of a single pixel", () => {
    const outline = traceOutline(art("ggg", "g.g", "ggg"));
    expect(holeCount(outline)).toBe(1);
  });

  it("keeps a shape inside a hole as a shape of its own", () => {
    const outline = traceOutline(
      art(
        "ggggggggg",
        "g.......g",
        "g..ggg..g",
        "g..ggg..g",
        "g..ggg..g",
        "g.......g",
        "ggggggggg",
      ),
    );
    expect(outline.shapes).toHaveLength(2);
    expect(outline.shapes.map((s) => s.holes.length)).toEqual([1, 0]);
  });

  it("counts a speck inside a hole as part of the hole", () => {
    // 1 opaque pixel against 341: a speck.
    const rows = Array.from({ length: 22 }, (_, y) =>
      Array.from({ length: 22 }, (_, x) => {
        const edge = Math.min(x, y, 21 - x, 21 - y);
        return edge < 5 || (x === 10 && y === 10) ? "g" : ".";
      }).join(""),
    );
    const outline = traceOutline(art(...rows));
    expect(outline.shapes).toHaveLength(1);
    expect(outline.shapes[0]!.holes).toHaveLength(1);
  });

  it("doesn't count a gap open through a diagonal as a hole", () => {
    // The ring's top-right corner pixel is missing: its two neighbours touch only at a corner.
    const outline = traceOutline(art("ggggg.", "g....g", "g....g", "gggggg"));
    expect(holeCount(outline)).toBe(0);
  });

  it("follows concave outlines", () => {
    // An L: the boundary turns at six corners.
    const outline = traceOutline(art("gg......", "gg......", "gggggggg", "gggggggg"));
    expect(outline.shapes[0]!.outer).toHaveLength(6);
  });

  it("finds nothing in a transparent image", () => {
    expect(traceOutline(art("....", "....")).shapes).toEqual([]);
  });

  it("keeps a 3 px ring whole, its loops apart", () => {
    for (const coverage of [smooth, hard]) {
      for (const r of [12, 31, 57, 88, 110]) {
        const outline = traceOutline(ring(256, r, 3, [128.3, 127.6], 1, coverage));
        expect(outline.shapes).toHaveLength(1);
        expect(outline.shapes[0]!.holes).toHaveLength(1);
        expect(crossingLoops(loops(outline))).toEqual([]);
        const { outer, holes } = outline.shapes[0]!;
        expect(holes[0]!.every((p) => contains(outer, p))).toBe(true);
      }
    }
  });

  it("simplifies thinner rings less rather than letting their loops cross", () => {
    // Rings 1.4–2 px wide that stay joined. Simplified at 1 px, the loops of several of them
    // cross; the same check over 2000 random rings found 21 such.
    const cases: [r: number, w: number, centre: Point, stretch: number][] = [
      [29.27, 1.73, [64.23, 64.91], 1.068],
      [27.14, 1.41, [64.01, 64.54], 1.005],
      [29.98, 1.8, [64.5, 64.98], 1.182],
      [21.79, 1.67, [64.29, 64.08], 1.01],
      [26.26, 1.68, [64.39, 64.62], 1.256],
    ];
    for (const [r, w, centre, stretch] of cases) {
      const outline = traceOutline(ring(128, r, w, centre, stretch, hard));
      expect(outline.shapes).toHaveLength(1);
      expect(outline.shapes[0]!.holes).toHaveLength(1);
      expect(crossingLoops(loops(outline))).toEqual([]);
    }
  });

  it.each(STUDIO_FIXTURES)("$name: keeps its gaps, its loops apart", async ({ name, url }) => {
    const outline = traceOutline(await decodePng(url));
    // Gaps left when colouring inside an outline, and anti-aliasing pinholes of a pixel or two.
    const holes: Record<string, number> = {
      outline: 6,
      "no-outline": 0,
      "thick-outline": 2,
      "edge-details": 8,
      "thin-limbs": 9,
      "separate-shapes": 1,
    };
    expect(holeCount(outline)).toBe(holes[name]);
    expect(outline.shapes).toHaveLength(name === "separate-shapes" ? 2 : 1);
    expect(crossingLoops(loops(outline))).toEqual([]);
  });

  it("gives the mossling the two gaps under its hairs", async () => {
    const outline = traceOutline(await decodePng(MOSSLING));
    expect(outline.shapes).toHaveLength(1);
    const area = (loop: readonly Point[]) =>
      Math.abs(
        loop.reduce((sum, [x, y], i) => sum + x * loop.at(i - 1)![1] - loop.at(i - 1)![0] * y, 0),
      ) / 2;
    // The hair gaps, near the top of the head on the left and on the right; the rest are pinholes.
    const gaps = outline.shapes[0]!.holes.filter((h) => area(h) > 10);
    expect(gaps).toHaveLength(2);
    expect(crossingLoops(loops(outline))).toEqual([]);
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

describe("crossingLoops", () => {
  const square = (x: number, y: number, size: number): Point[] => [
    [x, y],
    [x + size, y],
    [x + size, y + size],
    [x, y + size],
  ];

  it("finds loops that cross", () => {
    expect(crossingLoops([square(0, 0, 4), square(2, 2, 4), square(10, 10, 1)])).toEqual([0, 1]);
  });

  it("finds a loop that crosses itself", () => {
    const bowtie: Point[] = [
      [0, 0],
      [4, 4],
      [4, 0],
      [0, 4],
    ];
    expect(crossingLoops([bowtie])).toEqual([0]);
  });

  it("finds a corner lying on another loop's side", () => {
    expect(crossingLoops([square(0, 0, 4), square(4, 1, 2)])).toEqual([0, 1]);
  });

  it("finds two loops running along the same segment", () => {
    // The second square's left side is the first's right side, the other way round.
    expect(crossingLoops([square(0, 0, 2), square(2, 0, 2)])).toEqual([0, 1]);
  });

  it("lets loops share a corner, as traced loops do at a diagonal", () => {
    expect(crossingLoops([square(0, 0, 2), square(2, 2, 2)])).toEqual([]);
  });

  it("finds nothing in nested loops apart", () => {
    expect(crossingLoops([square(0, 0, 10), square(3, 3, 4)])).toEqual([]);
  });
});
