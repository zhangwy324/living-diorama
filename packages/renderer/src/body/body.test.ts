import { BODY_THICKNESS } from "@living-diorama/content-schema";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { bodyGeometry, buildBody, fallbackBody, triangulates } from "./body";
import { traceOutline, type Point } from "./outline";
import type { Pixels } from "./pixels";

/** A noisy blob whose simplified largest shape three triangulates over one of its holes. */
const NOISY = [
  "................................................",
  "................................................",
  "................................................",
  "................................................",
  "..................g.ggggggggggg.................",
  "................ggg..ggggg.gg...g...............",
  "..............gggggggggg.gggg....gg.............",
  "............gg..gggg..gggggg.....gg.............",
  "............gg.......ggg.gggg....gggg...........",
  "..........ggggg......gggggggggg....gg...........",
  ".........gg.ggg......ggggg.ggggg...gg...........",
  ".........gggggg.gg....ggggggggg.................",
  "............ggggggg....g.g.g....g......g.g......",
  "...........gggggggg...................g..g......",
  "......g...gggg.gggg.....gg.....gg...g.g.g.g.....",
  ".........gggggggggg...........gggg..g.g.ggg.....",
  ".....g...ggg.gggg.............ggggggg.ggg.......",
  ".....g...ggg.gggg..............gggggggggg.g.....",
  "........ggg.gggggg..gggg.......gggg.g.ggg.gg....",
  "............gggggggg.g....ggg..ggg..ggg..ggg....",
  "........ggg....ggggg.....g.ggggggg..g.g...ggg...",
  ".....gg...g...ggggg....ggggggggg.gggggg.....g...",
  ".....gggg.gg..ggg.....ggggggggggggggggg...g.g...",
  "......g...g.ggggg...ggggg.ggggggg.gggg......g...",
  ".........ggggggggggggggg...ggggggggggg..........",
  "........ggggg.gggggggggg...gg...g.ggg...........",
  "....ggg.ggg....gggggggggg..ggg..ggggg...........",
  "....gggggg..g.ggggg.ggggg...gggggggggg.gg..g....",
  "....ggg.gg....ggggg.ggggg...gggggggg.gggggggg...",
  "....gggggg....ggggg.gggggg..g...gggg.gggggggg...",
  "....g...ggg...g.g...ggggg........ggg..g.g.ggg...",
  ".....g.g.gggggg......ggg..............g...gg....",
  ".......g.gggggg......g.......ggggg.gggggg.......",
  "......gg.ggggg....ggg.ggg...gggggg..ggg.........",
  "......ggggggg...gggggggggggggg...g..ggg.........",
  ".......ggggg....ggggggggggggg....gg.g....g......",
  ".......ggggg......ggggggg..gg.....g.....gg......",
  "..........ggg....ggggggg........ggg....gg.......",
  "...........gg....ggggg...............ggg........",
  "...........gg...ggggg........gggg....gg.........",
  "...........gg...ggg.g..ggg...gggg....g..........",
  "............g...ggg...gggg...ggggg..............",
  "..............ggggg...gggg....ggggg.............",
  "................gggggggggg.....gg...............",
  "..................ggggggggg...g.................",
  "................................................",
  "................................................",
  "................................................",
];

/** The area inside a loop. */
const loopArea = (loop: readonly Point[]) =>
  Math.abs(
    loop.reduce((sum, [x, y], i) => {
      const [px, py] = loop.at(i - 1)!;
      return sum + px * y - x * py;
    }, 0),
  ) / 2;

/** The total area of the front and back faces (material 0), over two. */
function faceArea(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute("position");
  const index = geometry.index;
  const vertex = (k: number) =>
    new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(k) : k);
  let area = 0;
  for (const group of geometry.groups.filter((g) => g.materialIndex === 0)) {
    for (let k = group.start; k < group.start + group.count; k += 3) {
      area += new THREE.Triangle(vertex(k), vertex(k + 1), vertex(k + 2)).getArea();
    }
  }
  return area / 2;
}

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
    // Straight walls: the silhouette is the drawing, 40 × 80 px, and the body 40% as deep as tall.
    const scale = 0.8 / 80;
    expect(box.max.x - box.min.x).toBeCloseTo(40 * scale);
    expect(box.max.z - box.min.z).toBeCloseTo(80 * BODY_THICKNESS.default * scale);
    // Faces and walls share one material.
    expect(body.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    expect(body.material).toBeInstanceOf(THREE.Material);
    body.dispose();
  });

  it("places points of the drawing on the body, for its anchors", () => {
    // The same off-centre 40 × 80 px rectangle: feet at the origin, 0.01 m per pixel.
    const pixels = art(
      ...Array.from({ length: 100 }, (_, y) =>
        Array.from({ length: 100 }, (_, x) =>
          x >= 5 && x < 45 && y >= 10 && y < 90 ? "g" : ".",
        ).join(""),
      ),
    );
    const { drawing, dispose } = buildBody(pixels, 0.8)!;
    expect(drawing.bounds).toEqual({ left: 5, top: 10, right: 45, bottom: 90 });
    const at = (x: number, y: number) => drawing.toBody({ x, y }, new THREE.Vector3()).toArray();
    expect(at(25, 90)).toEqual([0, 0, 0]); // the bottom middle, below the default center of gravity
    const [x, y, z] = at(5, 50); // the default tail
    expect([x, y, z]).toEqual([expect.closeTo(-0.2), expect.closeTo(0.4), 0]);
    dispose();
    // The block stands in for a drawing filling its height, feet at the bottom middle.
    const block = fallbackBody(0.8).drawing;
    const feet = block.toBody(
      { x: (block.bounds.left + block.bounds.right) / 2, y: block.bounds.bottom },
      new THREE.Vector3(),
    );
    expect(feet.toArray()).toEqual([0, 0, 0]);
    expect(block.toBody({ x: block.bounds.left, y: 0 }, new THREE.Vector3()).toArray()).toEqual([
      expect.closeTo(-0.3),
      expect.closeTo(0.8),
      0,
    ]);
  });

  it("makes the body as deep as the thickness asks, the same shape otherwise", () => {
    const pixels = art("......", ".gggg.", ".gggg.", ".gg...", ".gg...", "......");
    const depth = (body: { geometry: THREE.BufferGeometry }) => {
      const box = size(body.geometry);
      return box.max.z - box.min.z;
    };
    const thin = buildBody(pixels, 1, BODY_THICKNESS.min)!;
    const thick = buildBody(pixels, 1, BODY_THICKNESS.max)!;
    expect(depth(thin)).toBeCloseTo(BODY_THICKNESS.min);
    expect(depth(thick)).toBeCloseTo(BODY_THICKNESS.max);
    expect(depth(buildBody(pixels, 1)!)).toBeCloseTo(BODY_THICKNESS.default);
    // The preview scales one body in z instead of rebuilding it: that must be the same body,
    // shaded the same. Scaling transforms the normals as the mesh's normal matrix does.
    const attribute = (body: { geometry: THREE.BufferGeometry }, name: string) =>
      Array.from(body.geometry.getAttribute(name).array);
    const scaled = buildBody(pixels, 1, 1)!;
    scaled.geometry.scale(1, 1, BODY_THICKNESS.min);
    for (const name of ["position", "normal"]) {
      expect(attribute(scaled, name)).toEqual(
        attribute(thin, name).map((v) => expect.closeTo(v, 6) as unknown as number),
      );
    }
    expect(Array.from(scaled.geometry.getAttribute("uv").array)).toEqual(
      Array.from(thin.geometry.getAttribute("uv").array),
    );
    for (const body of [thin, thick, scaled]) body.dispose();
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

  it("leaves a ring's hole open, with walls inside it", () => {
    // A 10 px square ring 2 px thick: its faces cover 64 px², not 100.
    const rows = Array.from({ length: 12 }, (_, y) =>
      Array.from({ length: 12 }, (_, x) => {
        const edge = Math.min(x - 1, y - 1, 10 - x, 10 - y);
        return edge >= 0 && edge < 2 ? "g" : ".";
      }).join(""),
    );
    const body = buildBody(art(...rows), 1)!;
    const position = body.geometry.getAttribute("position");
    const index = body.geometry.index;
    const vertex = (k: number) =>
      new THREE.Vector3().fromBufferAttribute(position, index ? index.getX(k) : k);
    const [faces, walls] = body.geometry.groups;
    let faceArea = 0;
    for (let k = faces!.start; k < faces!.start + faces!.count; k += 3) {
      const [a, b, c] = [vertex(k), vertex(k + 1), vertex(k + 2)];
      faceArea += new THREE.Triangle(a, b, c).getArea();
    }
    // Front and back, scaled from 10 px to a height of 1.
    expect(faceArea).toBeCloseTo((2 * 64) / 100);
    // Four walls outside and four inside, two triangles each.
    expect(walls!.count / 3).toBe(16);
    body.dispose();
  });

  it("builds a shape from its traced loops where three would cover a hole", () => {
    const pixels = art(...NOISY);
    const outline = traceOutline(pixels);
    expect(outline.shapes.some((s) => !triangulates(s.outer, s.holes))).toBe(true);
    // Each shape's faces cover its loops exactly: simplified, or as traced where those fail.
    const expected = outline.shapes.reduce((sum, { outer, holes, traced }) => {
      const loops = triangulates(outer, holes) ? { outer, holes } : traced;
      return sum + loopArea(loops.outer) - loops.holes.reduce((h, loop) => h + loopArea(loop), 0);
    }, 0);
    const drawn = outline.bounds.maxY - outline.bounds.minY;
    expect(faceArea(bodyGeometry(outline, pixels, drawn))).toBeCloseTo(expected, 3);
  });

  it("builds nothing from a transparent drawing", () => {
    expect(buildBody(art("...", "..."), 1)).toBeUndefined();
  });

  it("makes the fallback block as thick as asked", () => {
    const block = fallbackBody(1, BODY_THICKNESS.max);
    const box = size(block.geometry);
    expect(box.max.z - box.min.z).toBeCloseTo(BODY_THICKNESS.max);
    block.dispose();
  });

  it("has a neutral block of the same proportions as a fallback", () => {
    const block = fallbackBody(0.4);
    const box = size(block.geometry);
    expect(box.min.y).toBeCloseTo(0);
    expect(box.max.y).toBeCloseTo(0.4);
    expect(box.max.z - box.min.z).toBeCloseTo(0.4 * BODY_THICKNESS.default);
    block.dispose();
  });
});
