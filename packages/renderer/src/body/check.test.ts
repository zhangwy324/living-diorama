import { describe, expect, it } from "vitest";
import { checkBody, thinRadius } from "./check";
import type { Pixels } from "./pixels";

const SIZE = 256;

type Rect = [x0: number, y0: number, x1: number, y1: number];

/** A transparent `SIZE` × `SIZE` image with opaque rectangles [x0, y0, x1, y1) drawn into it. */
function image(...rects: Rect[]): Pixels {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (const [x0, y0, x1, y1] of rects) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) data.set([40, 120, 40, 255], (y * SIZE + x) * 4);
    }
  }
  return { width: SIZE, height: SIZE, data };
}

const count = (mask: Uint8Array) => mask.reduce((sum, v) => sum + v, 0);
const at = (mask: Uint8Array, x: number, y: number) => mask[y * SIZE + x];

/** A body 200 px tall, so parts under 7 px across are thin. */
const BODY: Rect = [30, 20, 150, 220];

describe("checkBody", () => {
  it("finds nothing in an empty drawing", () => {
    expect(checkBody(image())).toMatchObject({ empty: true, shapes: 0, thinParts: 0 });
  });

  it("finds no thin parts or loose shapes in one solid shape", () => {
    const check = checkBody(image(BODY));
    expect(check).toMatchObject({ empty: false, shapes: 1, thinParts: 0 });
    expect(count(check.thin)).toBe(0);
    expect(count(check.loose)).toBe(0);
  });

  it("marks a thin whisker on a body, and only the whisker", () => {
    const check = checkBody(image(BODY, [150, 60, 230, 64]));
    expect(check).toMatchObject({ shapes: 1, thinParts: 1 });
    expect(at(check.thin, 200, 62)).toBe(1);
    expect(at(check.thin, 90, 120)).toBe(0);
    expect(count(check.thin)).toBeGreaterThan(70 * 4);
    expect(count(check.thin)).toBeLessThanOrEqual(80 * 4);
  });

  it("measures thinness against the drawing's height", () => {
    expect(thinRadius(200)).toBe(3);
    const wide = 2 * thinRadius(200) + 1;
    expect(checkBody(image(BODY, [150, 60, 230, 60 + wide])).thinParts).toBe(0);
    expect(checkBody(image(BODY, [150, 60, 230, 59 + wide])).thinParts).toBe(1);
    // A lone line is its own body: as deep as it is tall, so it isn't thin.
    expect(checkBody(image([40, 100, 200, 104])).thinParts).toBe(0);
  });

  it("ignores tiny thin bits, like a short spike", () => {
    expect(checkBody(image(BODY, [150, 60, 154, 63])).thinParts).toBe(0);
  });

  it("counts each thin part", () => {
    expect(checkBody(image(BODY, [150, 60, 230, 63], [150, 160, 230, 163])).thinParts).toBe(2);
  });

  it("sees a closed outline as solid, since holes are filled", () => {
    const ring = image(
      [30, 20, 230, 24],
      [30, 216, 230, 220],
      [30, 20, 34, 220],
      [226, 20, 230, 220],
    );
    expect(checkBody(ring)).toMatchObject({ shapes: 1, thinParts: 0 });
  });

  it("counts separate shapes and marks all but the largest as loose", () => {
    const check = checkBody(image(BODY, [180, 150, 230, 200]));
    expect(check.shapes).toBe(2);
    expect(at(check.loose, 200, 170)).toBe(1);
    expect(at(check.loose, 90, 120)).toBe(0);
    expect(count(check.loose)).toBe(50 * 50);
  });

  it("leaves out specks and shapes inside another's hole, like the body does", () => {
    const ring: Rect[] = [
      [20, 20, 230, 40],
      [20, 210, 230, 230],
      [20, 20, 40, 230],
      [210, 20, 230, 230],
    ];
    const check = checkBody(image(...ring, [100, 100, 150, 150], [250, 250, 251, 251]));
    expect(check.shapes).toBe(1);
    expect(count(check.loose)).toBe(0);
  });

  it("treats shapes touching only at a corner as separate", () => {
    expect(checkBody(image([20, 20, 120, 120], [120, 120, 220, 220])).shapes).toBe(2);
  });
});
