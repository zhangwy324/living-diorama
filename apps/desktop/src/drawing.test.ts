import { parseDrawing, type Stroke } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { SAMPLE_DRAWING } from "./dev-library";
import { drawDrawing, strokeOutline, toDrawing, type StrokeContext } from "./drawing";

/** Records what is drawn: each fill with its colour, mode and the path's points. */
function recordingContext() {
  const fills: { color: string; mode: string; points: number[][] }[] = [];
  let points: number[][] = [];
  const context = {
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    beginPath: () => void (points = []),
    moveTo: (x: number, y: number) => void points.push([x, y]),
    quadraticCurveTo: (_cx: number, _cy: number, x: number, y: number) => void points.push([x, y]),
    closePath: () => {},
    fill: () =>
      void fills.push({
        color: String(context.fillStyle),
        mode: context.globalCompositeOperation,
        points,
      }),
  };
  return { context: context as unknown as StrokeContext & typeof context, fills };
}

const bounds = (points: number[][]) => {
  const xs = points.map(([x]) => x!);
  const ys = points.map(([, y]) => y!);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

const line = (width: number, pressure: number): Stroke => ({
  tool: "pen",
  color: "#112233",
  width,
  points: Array.from({ length: 21 }, (_, i) => [20 + i * 10, 100, pressure]).flat(),
});

describe("strokeOutline", () => {
  it("draws a lone point as a dot as wide as the stroke", () => {
    const { width, height } = bounds(strokeOutline(SAMPLE_DRAWING.strokes[0]!));
    expect(width).toBeCloseTo(150, -1);
    expect(height).toBeCloseTo(150, -1);
  });

  it("makes a stroke width × pressure wide", () => {
    expect(bounds(strokeOutline(line(40, 1))).height).toBeCloseTo(40, 0);
    expect(bounds(strokeOutline(line(40, 0.5))).height).toBeCloseTo(20, 0);
  });

  it("is deterministic", () => {
    expect(strokeOutline(line(12, 0.7))).toEqual(strokeOutline(line(12, 0.7)));
  });
});

describe("drawDrawing", () => {
  it("fills each stroke in order, the eraser cutting out", () => {
    const { context, fills } = recordingContext();
    drawDrawing(context, SAMPLE_DRAWING);
    expect(fills.map(({ color, mode }) => [color, mode])).toEqual([
      ["#5a8f3c", "source-over"],
      ["#5a8f3c", "source-over"],
      ["#1e2a14", "source-over"],
      ["#1e2a14", "source-over"],
      ["#000000", "destination-out"],
    ]);
    expect(context.globalCompositeOperation).toBe("source-over");
    // The path closes around the outline.
    expect(fills[4]!.points.length).toBe(strokeOutline(SAMPLE_DRAWING.strokes[4]!).length + 1);
  });

  it("draws the same drawing the same way twice", () => {
    const first = recordingContext();
    const second = recordingContext();
    drawDrawing(first.context, SAMPLE_DRAWING);
    drawDrawing(second.context, structuredClone(SAMPLE_DRAWING));
    expect(second.fills).toEqual(first.fills);
  });
});

it("makes drawings the schema accepts", () => {
  expect(parseDrawing(toDrawing([])).ok).toBe(true);
  expect(parseDrawing(toDrawing([line(8, 0.3), { ...line(20, 1), tool: "eraser" }])).ok).toBe(true);
});
