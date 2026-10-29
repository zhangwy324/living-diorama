import {
  DRAWING_SCHEMA_VERSION,
  DRAWING_SIZE,
  STROKE_POINT_STRIDE,
  type Drawing,
  type DrawingOperation,
  type Stroke,
} from "@living-diorama/content-schema";
import { floodFill } from "./fill";

// Strokes to pixels (ADR 0015 §9). The Studio's editor paints them into its 256 px image, which
// is the drawing the library keeps (ADR 0014 §5).

/** The drawing canvas's width and height in units: the body image's size (ADR 0011 §1). */
export const CANVAS_SIZE = DRAWING_SIZE;

/**
 * Pressure is drawn in steps of 1/64, so a pen's varying pressure becomes a few runs of one
 * width each rather than a line per point (ADR 0015 §9).
 */
export const PRESSURE_STEPS = 64;

/** What drawing a stroke needs of a 2D context, on screen or offscreen. */
export type StrokeContext = CanvasCompositing &
  CanvasFillStrokeStyles &
  Pick<CanvasPathDrawingStyles, "lineWidth" | "lineCap" | "lineJoin"> &
  Pick<CanvasPath, "moveTo" | "lineTo" | "arc"> &
  Pick<CanvasDrawPath, "beginPath" | "fill" | "stroke">;

/** The record of a drawing on the Studio's canvas made by `history`, in order. */
export const toDrawing = (history: readonly DrawingOperation[]): Drawing => ({
  schemaVersion: DRAWING_SCHEMA_VERSION,
  canvas: { width: CANVAS_SIZE, height: CANVAS_SIZE },
  history: [...history],
});

/** Consecutive points of a stroke drawn at one width, in canvas units. */
export interface StrokeRun {
  width: number;
  points: [Point, ...Point[]];
}

type Point = [number, number];

/**
 * `stroke` split into runs of one width: `width × pressure`, the pressure in steps of
 * 1/`PRESSURE_STEPS`. Between two points the pressure changes evenly; a run ends where it reaches
 * the next step up or down, and the next run starts there. A step is left only once the pressure
 * reaches the next one, so noise smaller than a step doesn't split the stroke into many runs.
 */
export function strokeRuns(stroke: Stroke): StrokeRun[] {
  const runs: StrokeRun[] = [];
  let step = 0;
  let run: StrokeRun | undefined;
  const startRun = (at: Point) => {
    run = { width: (stroke.width * step) / PRESSURE_STEPS, points: [at] };
    runs.push(run);
    return run;
  };
  let previous: { point: Point; level: number } | undefined;
  for (let i = 0; i + 2 < stroke.points.length; i += STROKE_POINT_STRIDE) {
    const [x = 0, y = 0, pressure = 0] = stroke.points.slice(i, i + STROKE_POINT_STRIDE);
    const point: Point = [x, y];
    // The pressure in steps, not rounded.
    const level = Math.min(1, Math.max(0, pressure)) * PRESSURE_STEPS;
    if (!previous || !run) {
      step = Math.round(level);
      startRun(point);
    } else {
      const from = previous;
      const direction = Math.sign(level - from.level);
      // The steps this segment climbs or falls. The width changes at most once per canvas unit
      // along it (once on a shorter one), several steps at a time if need be, so wildly varying
      // pressure can't make thousands of runs.
      const count = direction === 0 ? 0 : Math.floor((level - step) * direction);
      const length = Math.hypot(point[0] - from.point[0], point[1] - from.point[1]);
      const stride = Math.ceil(count / Math.max(1, Math.ceil(length)));
      for (let taken = 0; taken < count;) {
        const take = Math.min(stride, count - taken);
        taken += take;
        step += take * direction;
        const t = (step - from.level) / (level - from.level);
        const at: Point = [
          from.point[0] + (point[0] - from.point[0]) * t,
          from.point[1] + (point[1] - from.point[1]) * t,
        ];
        run.points.push(at);
        run = startRun(at);
      }
      run.points.push(point);
    }
    previous = { point, level };
  }
  return runs;
}

/**
 * Draws `stroke`: every point within half its width of the line through its points, with round
 * ends and corners (ADR 0015 §9). The canvas's own line drawing does it, so the edge is exactly
 * that, however unevenly the points are spaced. A pen stroke takes its colour; an eraser stroke
 * cuts out what is under it.
 */
export function drawStroke(context: StrokeContext, stroke: Stroke): void {
  drawRuns(context, stroke, strokeRuns(stroke));
}

/**
 * Draws some of `stroke`'s runs (`strokeRuns`) as `drawStroke` draws them all: the editor draws a
 * live stroke a few runs at a time (ADR 0015 §11).
 */
export function drawRuns(
  context: StrokeContext,
  stroke: Stroke,
  strokeRuns: readonly StrokeRun[],
): void {
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.fillStyle = context.strokeStyle = stroke.color;
  context.lineCap = context.lineJoin = "round";
  // One path per width, so a pen's pressure costs at most one line and one fill per step.
  const byWidth = new Map<number, StrokeRun[]>();
  for (const run of strokeRuns) {
    const runs = byWidth.get(run.width);
    if (runs) runs.push(run);
    else byWidth.set(run.width, [run]);
  }
  for (const [width, runs] of byWidth) {
    if (width <= 0) continue;
    // A run at a single point is a dot: a canvas may draw nothing for a line of no length.
    const isDot = ([[x0, y0], ...rest]: StrokeRun["points"]) =>
      rest.every(([x, y]) => x === x0 && y === y0);
    const lines = runs.filter((run) => !isDot(run.points));
    const dots = runs.filter((run) => isDot(run.points)).map((run) => run.points[0]);
    if (lines.length > 0) {
      context.beginPath();
      for (const { points } of lines) {
        const [first, ...rest] = points;
        context.moveTo(...first);
        for (const [x, y] of rest) context.lineTo(x, y);
      }
      context.lineWidth = width;
      context.stroke();
    }
    if (dots.length === 0) continue;
    context.beginPath();
    for (const [x, y] of dots) {
      context.moveTo(x + width / 2, y);
      context.arc(x, y, width / 2, 0, Math.PI * 2);
    }
    context.fill();
  }
  context.globalCompositeOperation = "source-over";
}

/**
 * A new image of `history` (strokes and fills) applied in order, one pixel per canvas unit. Only
 * for drawings made by code (the development samples); a player's drawing is its image, and its
 * record is never replayed (ADR 0014 §5).
 */
export function paintHistory(history: readonly DrawingOperation[]): OffscreenCanvas {
  const canvas = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas");
  for (const operation of history) {
    if (operation.kind === "stroke") {
      drawStroke(context, operation);
      continue;
    }
    const filled = floodFill(
      context.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE),
      operation.x,
      operation.y,
      operation.color,
    );
    if (filled) context.putImageData(new ImageData(filled, CANVAS_SIZE, CANVAS_SIZE), 0, 0);
  }
  return canvas;
}

/** `image` as PNG bytes: what the library stores as the drawing. */
export async function encodePng(image: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await image.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
