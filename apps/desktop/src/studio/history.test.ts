import type { Stroke } from "@living-diorama/content-schema";
import { expect, it } from "vitest";
import { appendedStroke, StrokeHistory } from "./history";

const stroke = (x: number): Stroke => ({
  tool: "pen",
  color: "#000000",
  width: 4,
  points: [x, 0, 1],
});
const a = stroke(1);
const b = stroke(2);
const c = stroke(3);

it("undoes and redoes strokes", () => {
  const history = new StrokeHistory();
  expect([history.canUndo, history.canRedo]).toEqual([false, false]);
  history.add(a);
  history.add(b);
  expect(history.undo()).toBe(true);
  expect(history.strokes).toEqual([a]);
  expect(history.undo()).toBe(true);
  expect(history.undo()).toBe(false);
  expect(history.strokes).toEqual([]);
  expect(history.redo()).toBe(true);
  expect(history.redo()).toBe(true);
  expect(history.redo()).toBe(false);
  expect(history.strokes).toEqual([a, b]);
});

it("forgets what was undone once a new stroke is drawn", () => {
  const history = new StrokeHistory();
  history.add(a);
  history.add(b);
  history.undo();
  history.add(c);
  expect(history.canRedo).toBe(false);
  expect(history.strokes).toEqual([a, c]);
});

it("undoes a clear as one step", () => {
  const history = new StrokeHistory();
  history.clear();
  expect(history.canUndo).toBe(false);
  history.add(a);
  history.add(b);
  history.clear();
  expect(history.strokes).toEqual([]);
  history.undo();
  expect(history.strokes).toEqual([a, b]);
  history.redo();
  expect(history.strokes).toEqual([]);
});

it("tells when a change only appends a stroke", () => {
  expect(appendedStroke([a], [a, b])).toBe(b);
  expect(appendedStroke([a], [c, b])).toBeUndefined();
  expect(appendedStroke([a, b], [a])).toBeUndefined();
  expect(appendedStroke([a, b], [])).toBeUndefined();
});

it("starts over with nothing to undo or redo", () => {
  const history = new StrokeHistory();
  history.add(a);
  history.add(b);
  history.undo();
  history.reset();
  expect(history.strokes).toEqual([]);
  expect(history.canUndo).toBe(false);
  expect(history.canRedo).toBe(false);
});
