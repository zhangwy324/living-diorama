import { parseDrawing } from "@living-diorama/content-schema";
import { expect, it } from "vitest";
import { toDrawing } from "../drawing";
import { LiveStroke } from "./live-stroke";

const brush = { tool: "pen", color: "#5a8f3c", width: 12 } as const;

it("keeps a pen's pressure", () => {
  const live = new LiveStroke(brush, true);
  live.add(10, 10, 0.2);
  live.add(12.345, 10, 1.4);
  expect(live.stroke).toEqual({ kind: "stroke", ...brush, points: [10, 10, 0.2, 12.35, 10, 1] });
});

it("draws any other pointer at full pressure, however fast it moves", () => {
  // Pressure from speed made a mouse's strokes change width with every jerk of the hand (#59).
  const live = new LiveStroke(brush, false);
  live.add(0, 0, 0.5);
  live.add(1, 0, 0.5);
  live.add(200, 3, 0);
  expect(live.stroke.points).toEqual([0, 0, 1, 1, 0, 1, 200, 3, 1]);
});

it("skips repeated samples", () => {
  const live = new LiveStroke(brush, false);
  live.add(5, 5, 0.5);
  live.add(5.001, 5, 0.5);
  expect(live.stroke.points).toEqual([5, 5, 1]);
});

it("makes strokes the drawing schema accepts", () => {
  const strokes = [true, false].map((pen) => {
    const live = new LiveStroke({ ...brush, tool: pen ? "pen" : "eraser" }, pen);
    for (let i = 0; i < 50; i++) live.add(Math.sin(i) * 300, i * 7, Math.random());
    return live.stroke;
  });
  expect(parseDrawing(toDrawing(strokes)).ok).toBe(true);
});
