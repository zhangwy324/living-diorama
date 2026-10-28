import { parseDrawing, type Stroke } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { SAMPLE_DRAWING } from "./dev-library";
import {
  drawRuns,
  drawStroke,
  PRESSURE_STEPS,
  strokeRuns,
  toDrawing,
  type StrokeContext,
} from "./drawing";

type Op =
  | { kind: "stroke"; color: string; mode: string; width: number; lines: number[][][] }
  | { kind: "fill"; color: string; mode: string; dots: number[][] };

/** Records what is drawn: each line drawn with its width, each fill with its dots. */
function recordingContext() {
  const ops: Op[] = [];
  let lines: number[][][] = [];
  let dots: number[][] = [];
  const context = {
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    beginPath: () => {
      lines = [];
      dots = [];
    },
    moveTo: (x: number, y: number) => void lines.push([[x, y]]),
    lineTo: (x: number, y: number) => void lines.at(-1)!.push([x, y]),
    arc: (x: number, y: number, radius: number) => {
      lines.pop();
      dots.push([x, y, radius]);
    },
    stroke: () =>
      void ops.push({
        kind: "stroke",
        color: String(context.strokeStyle),
        mode: context.globalCompositeOperation,
        width: context.lineWidth,
        lines,
      }),
    fill: () =>
      void ops.push({
        kind: "fill",
        color: String(context.fillStyle),
        mode: context.globalCompositeOperation,
        dots,
      }),
  };
  return { context: context as unknown as StrokeContext & typeof context, ops };
}

const stroke = (width: number, points: number[][]): Stroke => ({
  kind: "stroke",
  tool: "pen",
  color: "#112233",
  width,
  points: points.flat(),
});

const line = (width: number, pressure: number): Stroke =>
  stroke(
    width,
    Array.from({ length: 21 }, (_, i) => [20 + i * 10, 100, pressure]),
  );

/** Points as a mouse sends them: whole pixels of a scaled canvas, unevenly spaced, wobbling. */
const mouseLike = (width: number): Stroke =>
  stroke(
    width,
    Array.from({ length: 120 }, (_, i) => {
      const px = Math.round(40 + i * (i % 7 === 0 ? 3 : 0.6) + Math.sin(i) * 1.5);
      const py = Math.round(200 + Math.sin(i / 9) * 40 + ((i * 37) % 5) - 2);
      return [px * 0.43, py * 0.43, 1];
    }),
  );

describe("drawStroke", () => {
  it("draws a lone point as a dot as wide as the stroke", () => {
    const { context, ops } = recordingContext();
    drawStroke(context, SAMPLE_DRAWING.history[0]!);
    expect(ops.filter((op) => op.kind === "fill")).toEqual([
      { kind: "fill", color: "#5a8f3c", mode: "source-over", dots: [[128, 145, 75]] },
    ]);
  });

  it("draws an even stroke as one round line through its own points, width × pressure wide", () => {
    // The edge is the canvas's own line around the points: nothing estimates a direction from
    // closely spaced, wobbling mouse points, which is what made spikes on wide strokes (#59).
    const mouse = mouseLike(40);
    const { context, ops } = recordingContext();
    drawStroke(context, mouse);
    const points = [];
    for (let i = 0; i < mouse.points.length; i += 3) points.push(mouse.points.slice(i, i + 2));
    expect(ops).toEqual([
      { kind: "stroke", color: "#112233", mode: "source-over", width: 40, lines: [points] },
    ]);
    expect([context.lineCap, context.lineJoin]).toEqual(["round", "round"]);

    const half = recordingContext();
    drawStroke(half.context, line(40, 0.5));
    expect(half.ops.map((op) => op.kind === "stroke" && op.width)).toEqual([20]);
  });

  it("draws nothing at no pressure", () => {
    const { context, ops } = recordingContext();
    drawStroke(context, line(20, 0));
    expect(ops).toEqual([]);
  });

  it("cuts out with the eraser and leaves the context drawing normally", () => {
    const { context, ops } = recordingContext();
    drawStroke(context, { ...line(20, 1), tool: "eraser", color: "#000000" });
    expect(ops.map((op) => op.mode)).toEqual(["destination-out"]);
    expect(context.globalCompositeOperation).toBe("source-over");
  });

  it("draws a stroke the same while it is drawn as once it is finished", () => {
    // The editor draws the live stroke with the same call it bakes the finished one with, so
    // what was drawn so far never changes when more points come or the stroke ends.
    const full = stroke(
      30,
      Array.from({ length: 60 }, (_, i) => [
        10 + i * 3,
        50 + (i % 4),
        0.3 + 0.6 * Math.abs(Math.sin(i / 8)),
      ]),
    );
    const runs = strokeRuns(full);
    for (const count of [2, 17, 40]) {
      const prefix = strokeRuns({ ...full, points: full.points.slice(0, count * 3) });
      const last = prefix.length - 1;
      expect(prefix.slice(0, last)).toEqual(runs.slice(0, last));
      expect(runs[last]!.points.slice(0, prefix[last]!.points.length)).toEqual(
        prefix[last]!.points,
      );
    }
  });
});

describe("strokeRuns", () => {
  it("narrows a stroke step by step where its pressure falls, the runs joined", () => {
    const runs = strokeRuns(
      stroke(64, [
        [0, 0, 1],
        [100, 0, 0.5],
      ]),
    );
    expect(runs.map((run) => run.width)).toEqual(Array.from({ length: 33 }, (_, i) => 64 - i));
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.points[0]).toEqual(runs[i - 1]!.points.at(-1));
    }
    // Each step is reached evenly along the segment.
    expect(runs[16]!.points[0]![0]).toBeCloseTo(50);
    expect(runs.at(-1)!.points.at(-1)).toEqual([100, 0]);
  });

  it("ignores pressure noise smaller than a step", () => {
    const noise = 0.4 / PRESSURE_STEPS;
    const runs = strokeRuns(
      stroke(
        40,
        Array.from({ length: 50 }, (_, i) => [i * 2, 0, 0.6 + (i % 2 ? noise : -noise)]),
      ),
    );
    expect(runs).toHaveLength(1);
  });

  it("changes width at most once per canvas unit, whatever the pressure does", () => {
    const runs = strokeRuns(
      stroke(40, [
        [0, 0, 0],
        [3, 0, 1],
        [6, 0, 0],
      ]),
    );
    expect(runs.length).toBeLessThanOrEqual(1 + 3 + 3);
    expect(runs.map((run) => run.width).at(-1)).toBe(0);
    expect(Math.max(...runs.map((run) => run.width))).toBe(40);
  });
});

describe("drawRuns", () => {
  it("draws a live stroke a few runs at a time with the lines drawStroke draws at once", () => {
    // The editor draws each finished run once and the open run every frame (ADR 0015 §11).
    const full = stroke(
      30,
      Array.from({ length: 80 }, (_, i) => [
        10 + i * 3,
        50 + (i % 4),
        0.3 + 0.6 * Math.abs(Math.sin(i / 8)),
      ]),
    );
    const linesByWidth = (ops: Op[]) => {
      const byWidth = new Map<number, number[][][]>();
      for (const op of ops) {
        if (op.kind !== "stroke") continue;
        byWidth.set(op.width, [...(byWidth.get(op.width) ?? []), ...op.lines]);
      }
      return new Map([...byWidth].sort(([a], [b]) => a - b));
    };
    const whole = recordingContext();
    drawStroke(whole.context, full);

    const live = recordingContext();
    // The finished runs, drawn as the points come.
    let drawn = 0;
    for (let count = 1; count <= 80; count += 7) {
      const runs = strokeRuns({ ...full, points: full.points.slice(0, count * 3) });
      drawRuns(live.context, full, runs.slice(drawn, runs.length - 1));
      drawn = runs.length - 1;
    }
    // Then what is left, and the open run.
    const runs = strokeRuns(full);
    expect(runs.length - drawn).toBeGreaterThan(1);
    drawRuns(live.context, full, runs.slice(drawn, -1));
    drawRuns(live.context, full, runs.slice(-1));
    expect(linesByWidth(live.ops)).toEqual(linesByWidth(whole.ops));
  });
});

it("makes drawing records the schema accepts", () => {
  expect(parseDrawing(toDrawing([])).ok).toBe(true);
  expect(parseDrawing(toDrawing([line(8, 0.3), { ...line(20, 1), tool: "eraser" }])).ok).toBe(true);
});
