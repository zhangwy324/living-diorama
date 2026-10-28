import { parseDrawing } from "@living-diorama/content-schema";
import { expect, it } from "vitest";
import { toDrawing } from "../drawing";
import { LiveStroke, SPEED_PRESSURE, speedPressure } from "./live-stroke";

const brush = { tool: "pen", color: "#5a8f3c", width: 12 } as const;

it("keeps a pen's pressure", () => {
  const live = new LiveStroke(brush, true);
  live.add(10, 10, 0, 0.2);
  live.add(12.345, 10, 4, 1.4);
  expect(live.stroke).toEqual({ ...brush, points: [10, 10, 0.2, 12.35, 10, 1] });
});

it("thins a fast pointer and keeps a slow one at full pressure", () => {
  const draw = (unitsPerMs: number) => {
    const live = new LiveStroke(brush, false);
    for (let i = 0; i < 40; i++) live.add(i * unitsPerMs * 8, 0, i * 8, 0.5);
    return live.stroke.points.at(-1);
  };
  expect(draw(0.01)).toBeGreaterThan(0.99);
  expect(draw(5)).toBeCloseTo(SPEED_PRESSURE.floor, 2);
});

it("eases towards the speed's pressure rather than jumping", () => {
  const next = speedPressure(1, 100, 10);
  expect(next).toBeLessThan(1);
  expect(next).toBeGreaterThan(SPEED_PRESSURE.floor);
  expect(speedPressure(0.6, 5, 0)).toBe(0.6);
});

it("skips repeated samples", () => {
  const live = new LiveStroke(brush, false);
  live.add(5, 5, 0, 0.5);
  live.add(5.001, 5, 2, 0.5);
  expect(live.stroke.points).toEqual([5, 5, 1]);
});

it("makes strokes the drawing schema accepts", () => {
  const strokes = [true, false].map((pen) => {
    const live = new LiveStroke({ ...brush, tool: pen ? "pen" : "eraser" }, pen);
    for (let i = 0; i < 50; i++) live.add(Math.sin(i) * 300, i * 7, i * 3, Math.random());
    return live.stroke;
  });
  expect(parseDrawing(toDrawing(strokes)).ok).toBe(true);
});
