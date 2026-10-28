import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { BODY_DEPTH, buildBody, fallbackBody } from "./body";
import type { Pixels } from "./pixels";

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
    expect(box.max.z - box.min.z).toBeCloseTo(80 * BODY_DEPTH * scale);
    // Faces and walls share one material.
    expect(body.geometry.groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    expect(body.material).toBeInstanceOf(THREE.Material);
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
