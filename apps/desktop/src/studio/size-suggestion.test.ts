import { describe, expect, it } from "vitest";
import { DRAWING_SIZE } from "@living-diorama/content-schema";
import { canvasFill, shownSize, suggestSize } from "./size-suggestion";

/** Bounds `width` by `height` drawing pixels, standing on the guide line. */
const box = (width: number, height: number) => ({
  left: 10,
  top: 230 - height,
  right: 10 + width,
  bottom: 230,
});

describe("canvasFill", () => {
  it("is 1 for the whole canvas and 0.5 for a quarter of it", () => {
    expect(canvasFill(box(DRAWING_SIZE, DRAWING_SIZE))).toBe(1);
    expect(canvasFill(box(DRAWING_SIZE / 2, DRAWING_SIZE / 2))).toBe(0.5);
  });

  it("counts width and height alike", () => {
    expect(canvasFill(box(200, 50))).toBeCloseTo(canvasFill(box(50, 200)));
    expect(canvasFill(box(200, 50))).toBeCloseTo(canvasFill(box(100, 100)));
  });

  it("is 0 for bounds with no area", () => {
    expect(canvasFill({ left: 5, top: 5, right: 5, bottom: 9 })).toBe(0);
  });
});

describe("suggestSize", () => {
  it("suggests nothing for an empty drawing", () => {
    expect(suggestSize(undefined)).toBeUndefined();
  });

  it("suggests a bigger size the more of the canvas the drawing fills", () => {
    expect(suggestSize(box(30, 30))).toBe("tiny");
    expect(suggestSize(box(90, 80))).toBe("small");
    expect(suggestSize(box(160, 140))).toBe("medium");
    expect(suggestSize(box(240, 220))).toBe("large");
  });

  it("changes size at a fill of 0.25, 0.45 and 0.85", () => {
    const square = (fill: number) => box(fill * DRAWING_SIZE, fill * DRAWING_SIZE);
    expect(suggestSize(square(0.24))).toBe("tiny");
    expect(suggestSize(square(0.25))).toBe("small");
    expect(suggestSize(square(0.44))).toBe("small");
    expect(suggestSize(square(0.45))).toBe("medium");
    expect(suggestSize(square(0.84))).toBe("medium");
    expect(suggestSize(square(0.85))).toBe("large");
  });

  it("doesn't take a long, low drawing for a small one", () => {
    // A snake across the canvas, less than a quarter of its height: by height alone, tiny.
    expect(suggestSize(box(250, 30))).toBe("small");
    expect(suggestSize(box(250, 60))).toBe("medium");
  });
});

describe("shownSize", () => {
  it("shows the suggestion until the player picks a size", () => {
    expect(shownSize(undefined, undefined, "medium")).toBe("medium");
    expect(shownSize(undefined, "tiny", "medium")).toBe("tiny");
    expect(shownSize(undefined, "large", "medium")).toBe("large");
  });

  it("never overrides the player's pick", () => {
    expect(shownSize("small", "large", "medium")).toBe("small");
    expect(shownSize("small", undefined, "medium")).toBe("small");
    // Picking the suggested size by hand keeps it when the suggestion moves on.
    expect(shownSize("tiny", "medium", "medium")).toBe("tiny");
  });
});
