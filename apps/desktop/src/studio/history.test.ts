import type { Stroke } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { changedBox, DrawingHistory, type Change } from "./history";

const SIZE = 8;

const stroke = (x: number): Stroke => ({
  kind: "stroke",
  tool: "pen",
  color: "#000000",
  width: 4,
  points: [x, 0, 1],
});
const a = stroke(1);
const b = stroke(2);
const c = stroke(3);

/** A small image standing in for the editor's canvas: it paints squares and takes patches. */
class Image {
  pixels = new Uint8ClampedArray(SIZE * SIZE * 4);

  /** Paints a square of one grey with full alpha, and returns the pixels. */
  paint(x: number, y: number, size: number, grey: number): Uint8ClampedArray {
    for (let row = y; row < y + size; row++) {
      for (let column = x; column < x + size; column++) {
        this.pixels.set([grey, grey, grey, 255], (row * SIZE + column) * 4);
      }
    }
    return this.pixels.slice();
  }

  /** Puts back what an undo or redo changed, as the editor does with `putImageData`. */
  put(change: Change | undefined) {
    const patch = change?.patch;
    if (!patch) return;
    for (let row = 0; row < patch.height; row++) {
      const line = patch.data.subarray(row * patch.width * 4, (row + 1) * patch.width * 4);
      this.pixels.set(line, ((patch.y + row) * SIZE + patch.x) * 4);
    }
  }
}

function drawn() {
  const image = new Image();
  const history = new DrawingHistory(SIZE, SIZE);
  return { image, history };
}

it("undoes and redoes, putting the pixels and the record back", () => {
  const { image, history } = drawn();
  expect([history.canUndo, history.canRedo]).toEqual([false, false]);
  const empty = image.pixels.slice();
  history.add(a, image.paint(0, 0, 3, 10));
  const afterA = image.pixels.slice();
  history.add(b, image.paint(2, 2, 3, 20));
  const afterB = image.pixels.slice();

  image.put(history.undo());
  expect(history.record).toEqual([a]);
  expect(image.pixels).toEqual(afterA);
  image.put(history.undo());
  expect(history.undo()).toBeUndefined();
  expect(history.record).toEqual([]);
  expect(image.pixels).toEqual(empty);

  image.put(history.redo());
  expect(image.pixels).toEqual(afterA);
  image.put(history.redo());
  expect(history.redo()).toBeUndefined();
  expect(history.record).toEqual([a, b]);
  expect(image.pixels).toEqual(afterB);
});

it("keeps only the rectangle a step changed", () => {
  const { image, history } = drawn();
  history.add(a, image.paint(2, 3, 2, 10));
  const change = history.undo();
  expect(change?.patch).toMatchObject({ x: 2, y: 3, width: 2, height: 2 });
  expect(history.size).toBe(2 * 2 * 4 * 2);
});

it("keeps a step that changed no pixels, for the record", () => {
  // An eraser stroke on nothing, say.
  const { image, history } = drawn();
  history.add(a, image.pixels.slice());
  expect(history.record).toEqual([a]);
  expect(history.undo()).toEqual({ patch: undefined });
  expect(history.record).toEqual([]);
});

it("forgets what was undone once something new is drawn, in the record too", () => {
  const { image, history } = drawn();
  history.add(a, image.paint(0, 0, 2, 10));
  history.add(b, image.paint(4, 4, 2, 20));
  image.put(history.undo());
  history.add(c, image.paint(0, 4, 2, 30));
  expect(history.canRedo).toBe(false);
  expect(history.record).toEqual([a, c]);
  // Undoing c leaves a's pixels only: b's are gone for good.
  image.put(history.undo());
  const onlyA = new Image();
  onlyA.paint(0, 0, 2, 10);
  expect(image.pixels).toEqual(onlyA.pixels);
});

it("undoes a clear as one step, which starts the record over", () => {
  const { image, history } = drawn();
  expect(history.clear()).toBe(false);
  expect(history.canUndo).toBe(false);
  history.add(a, image.paint(0, 0, 2, 10));
  history.add(b, image.paint(1, 1, 5, 20));
  const before = image.pixels.slice();
  expect(history.clear()).toBe(true);
  image.pixels.fill(0);
  expect(history.record).toEqual([]);
  image.put(history.undo());
  expect(history.record).toEqual([a, b]);
  expect(image.pixels).toEqual(before);
  image.put(history.redo());
  expect(history.record).toEqual([]);
  expect(image.pixels).toEqual(new Uint8ClampedArray(SIZE * SIZE * 4));
});

it("starts over with an empty image and nothing to undo or redo", () => {
  const { image, history } = drawn();
  history.add(a, image.paint(0, 0, 2, 10));
  history.add(b, image.paint(4, 4, 2, 20));
  history.undo();
  history.reset();
  expect(history.record).toEqual([]);
  expect([history.canUndo, history.canRedo, history.size]).toEqual([false, false, 0]);
  // The next step is measured against an empty image.
  const fresh = new Image();
  history.add(c, fresh.paint(6, 6, 1, 30));
  expect(history.undo()?.patch).toMatchObject({ x: 6, y: 6, width: 1, height: 1 });
});

it("drops the oldest steps beyond its budget, keeping the newest however big", () => {
  const image = new Image();
  // Room for two 2 × 2 steps (32 bytes each, before and after).
  const history = new DrawingHistory(SIZE, SIZE, 64);
  history.add(a, image.paint(0, 0, 2, 10));
  history.add(b, image.paint(4, 0, 2, 20));
  history.add(c, image.paint(0, 4, 2, 30));
  expect(history.size).toBe(64);
  image.put(history.undo());
  image.put(history.undo());
  expect(history.canUndo).toBe(false);
  expect(history.record).toEqual([a]);

  const big = new DrawingHistory(SIZE, SIZE, 64);
  big.add(a, new Image().paint(0, 0, 8, 10));
  expect(big.canUndo).toBe(true);
  expect(big.size).toBe(SIZE * SIZE * 4 * 2);
});

it("refuses pixels of another size", () => {
  expect(() => drawn().history.add(a, new Uint8ClampedArray(4))).toThrow();
});

describe("changedBox", () => {
  it("finds the smallest rectangle of changed pixels", () => {
    const before = new Image();
    const after = new Image();
    after.paint(1, 2, 1, 10);
    after.paint(5, 6, 1, 10);
    expect(changedBox(before.pixels, after.pixels, SIZE)).toEqual({
      x: 1,
      y: 2,
      width: 5,
      height: 5,
    });
  });

  it("sees a change in alpha alone, and none where nothing changed", () => {
    const before = new Image().pixels;
    const after = before.slice();
    after[(3 * SIZE + 7) * 4 + 3] = 1;
    expect(changedBox(before, after, SIZE)).toEqual({ x: 7, y: 3, width: 1, height: 1 });
    expect(changedBox(before, before.slice(), SIZE)).toBeUndefined();
  });
});
