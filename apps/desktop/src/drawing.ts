import {
  DRAWING_SCHEMA_VERSION,
  STROKE_POINT_STRIDE,
  type Drawing,
  type Stroke,
} from "@living-diorama/content-schema";
import { getStroke } from "perfect-freehand";

// Strokes to pixels (ADR 0015 §9), one way for the Studio's editor and for the PNG the body is
// built from, so the released image matches what the player saw.

/** The drawing canvas's width and height in units: the body image's size (ADR 0011 §1). */
export const CANVAS_SIZE = 256;

/** What drawing a stroke needs of a 2D context, on screen or offscreen. */
export type StrokeContext = CanvasCompositing &
  CanvasFillStrokeStyles &
  Pick<CanvasPath, "moveTo" | "quadraticCurveTo" | "closePath"> &
  Pick<CanvasDrawPath, "beginPath" | "fill">;

/** A drawing of `strokes` on the Studio's canvas. */
export const toDrawing = (strokes: readonly Stroke[]): Drawing => ({
  schemaVersion: DRAWING_SCHEMA_VERSION,
  canvas: { width: CANVAS_SIZE, height: CANVAS_SIZE },
  strokes: [...strokes],
});

/**
 * The outline polygon of `stroke`, in canvas units, from perfect-freehand. With `thinning` 1 and
 * `size` half the width, the stroke is `width × pressure` wide, as ADR 0014 defines. `last` is
 * false while the stroke is still being drawn.
 */
export function strokeOutline(stroke: Stroke, last = true): number[][] {
  const points: number[][] = [];
  for (let i = 0; i < stroke.points.length; i += STROKE_POINT_STRIDE) {
    points.push(stroke.points.slice(i, i + STROKE_POINT_STRIDE));
  }
  return getStroke(points, {
    size: stroke.width / 2,
    thinning: 1,
    simulatePressure: false,
    last,
  });
}

/** Fills `stroke`'s outline: a pen with its colour, an eraser cutting out what is under it. */
export function drawStroke(context: StrokeContext, stroke: Stroke, last = true): void {
  const outline = strokeOutline(stroke, last) as [number, number][];
  const [first, second] = outline;
  if (!first || !second || outline.length < 3) return;
  context.globalCompositeOperation = stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.fillStyle = stroke.color;
  // A smooth closed curve through the midpoints, the outline's points as control points.
  const mid = (a: [number, number], b: [number, number]) =>
    [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as const;
  context.beginPath();
  context.moveTo(...mid(first, second));
  for (let i = 1; i <= outline.length; i++) {
    const point = outline[i % outline.length] ?? first;
    const next = outline[(i + 1) % outline.length] ?? first;
    context.quadraticCurveTo(point[0], point[1], ...mid(point, next));
  }
  context.closePath();
  context.fill();
  context.globalCompositeOperation = "source-over";
}

/** Draws every stroke of `drawing`, in order, at one pixel per unit. */
export function drawDrawing(context: StrokeContext, drawing: Drawing): void {
  for (const stroke of drawing.strokes) drawStroke(context, stroke);
}

/** Draws `drawing` to PNG bytes, one pixel per canvas unit. */
export async function rasterize(drawing: Drawing): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(drawing.canvas.width, drawing.canvas.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas");
  drawDrawing(context, drawing);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}
