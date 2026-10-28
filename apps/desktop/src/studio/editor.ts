import type { Drawing } from "@living-diorama/content-schema";
import { CANVAS_SIZE, drawRuns, drawStroke, encodePng, strokeRuns, toDrawing } from "../drawing";
import { floodFill } from "./fill";
import { DrawingHistory, type Change } from "./history";
import { LiveStroke, type Brush } from "./live-stroke";

// The drawing editor's canvas, driven imperatively (ADR 0015 §11): React renders the toolbar
// only. The drawing is a 256 px image (ADR 0014 §5), shown scaled up to fit; a stroke is painted
// into it when it ends, a fill when clicked (ADR 0017 §10), and `DrawingHistory` keeps the record
// and the pixels for undo.

/** What the toolbar and the close dialog need to know. */
export interface EditorState {
  canUndo: boolean;
  canRedo: boolean;
  /** Nothing in the record: nothing drawn since the canvas was last empty. */
  empty: boolean;
  /** No pixel is visible: nothing drawn, or all of it erased. */
  blank: boolean;
}

/** A stroke being drawn, and how many of its runs are already in the working image. */
interface Live {
  stroke: LiveStroke;
  pointerId: number;
  box: DOMRect;
  drawnRuns: number;
}

function context2d(canvas: OffscreenCanvas, options?: CanvasRenderingContext2DSettings) {
  const context = canvas.getContext("2d", options);
  if (!context) throw new Error("No 2D canvas");
  return context;
}

/** The toolbar's drawing tools: the brush's two, and the fill tool. */
export type Tool = Brush["tool"] | "fill";

export class DrawingEditor {
  brush: Brush = { tool: "pen", color: "#1e2a14", width: 10 };
  /** Whether a click fills with the brush's colour (ADR 0017 §10) instead of starting a stroke. */
  filling = false;

  private readonly context: CanvasRenderingContext2D;
  /** The drawing: one pixel per canvas unit, what the library keeps. */
  private readonly image = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE);
  private readonly imageContext = context2d(this.image, { willReadFrequently: true });
  /** While a stroke is drawn: the image with the live stroke's finished runs drawn in. */
  private readonly working = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE);
  private readonly workingContext = context2d(this.working);
  /** While a stroke is drawn: the working image with the live stroke's open run on top. */
  private readonly composed = new OffscreenCanvas(CANVAS_SIZE, CANVAS_SIZE);
  private readonly composedContext = context2d(this.composed);
  private readonly history = new DrawingHistory(CANVAS_SIZE, CANVAS_SIZE);
  private live?: Live;
  private frame?: number;
  private readonly stop: () => void;

  /**
   * `onChange` is called whenever the drawing changes: a stroke ends, a fill, undo, redo or
   * clear.
   * `onStroke` is called when a stroke starts (true) and ends (false).
   */
  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onChange: (state: EditorState) => void,
    private readonly onStroke: (drawing: boolean) => void = () => {},
  ) {
    // Not `desynchronized`: WebView2 takes it, but then shows the canvas's transparent pixels as
    // black instead of the page behind them (ADR 0015 §11).
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas");
    this.context = context;

    // The backing store follows the canvas's size in device pixels, so the image is scaled up
    // once, smoothly, on every monitor; this observer box also fires when only the device pixel
    // ratio changes.
    const resizer = new ResizeObserver(([entry]) => {
      const size = entry?.devicePixelContentBoxSize[0];
      if (size) this.resize(size.inlineSize, size.blockSize);
    });
    resizer.observe(canvas, { box: "device-pixel-content-box" });

    const listeners = {
      pointerdown: (event: PointerEvent) => this.start(event),
      pointermove: (event: PointerEvent) => this.move(event),
      pointerup: (event: PointerEvent) => this.end(event),
      pointercancel: (event: PointerEvent) => this.end(event),
    };
    for (const [type, listener] of Object.entries(listeners)) {
      canvas.addEventListener(type, listener as EventListener);
    }
    this.stop = () => {
      resizer.disconnect();
      for (const [type, listener] of Object.entries(listeners)) {
        canvas.removeEventListener(type, listener as EventListener);
      }
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    };
  }

  /** The record of how the image was drawn (ADR 0014 §5), saved beside it. */
  get drawing(): Drawing {
    return toDrawing(this.history.record);
  }

  get state(): EditorState {
    return {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      empty: this.history.record.length === 0,
      blank: this.history.blank,
    };
  }

  /** Whether a stroke is being drawn; undo and redo wait until it ends. */
  get drawingStroke(): boolean {
    return this.live !== undefined;
  }

  /** The image's pixels, one per canvas unit: what `png` encodes. */
  pixels(): ImageData {
    return this.imageContext.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  /** The image as PNG bytes: the drawing the library keeps. */
  png(): Promise<Uint8Array> {
    return encodePng(this.image);
  }

  undo(): void {
    this.step(() => this.history.undo());
  }

  redo(): void {
    this.step(() => this.history.redo());
  }

  clear(): void {
    if (this.live || !this.history.clear()) return;
    this.imageContext.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    this.requestFrame();
    this.changed();
  }

  /** An empty canvas whose clearing can't be undone, for the next drawing after a release. */
  reset(): void {
    if (this.live) {
      if (this.canvas.hasPointerCapture(this.live.pointerId)) {
        this.canvas.releasePointerCapture(this.live.pointerId);
      }
      this.live = undefined;
      this.onStroke(false);
    }
    this.history.reset();
    this.imageContext.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    this.requestFrame();
    this.changed();
  }

  dispose(): void {
    this.stop();
  }

  /** Applies an undo or redo, putting back the pixels it changed. */
  private step(step: () => Change | undefined) {
    if (this.live) return;
    const change = step();
    if (!change) return;
    if (change.patch) {
      const { x, y, width, height, data } = change.patch;
      this.imageContext.putImageData(new ImageData(data, width, height), x, y);
    }
    this.requestFrame();
    this.changed();
  }

  private resize(width: number, height: number) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.requestFrame();
  }

  private requestFrame() {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = undefined;
      this.draw();
    });
  }

  /** The image, or while a stroke is drawn the image with the stroke, scaled to the canvas. */
  private draw() {
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.imageSmoothingEnabled = true;
    const shown = this.live ? this.compose(this.live) : this.image;
    context.drawImage(shown, 0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * The image with the live stroke, drawn a run at a time (ADR 0015 §11): runs the stroke has
   * finished go into the working image once, and each frame draws only the open run, over a copy
   * of it. A live eraser cuts into these copies, never into the image.
   */
  private compose(live: Live): OffscreenCanvas {
    const stroke = live.stroke.stroke;
    const runs = strokeRuns(stroke);
    // Every run but the last is finished: points added later extend the last run or start new
    // ones, and never change the runs before it.
    const finished = Math.max(0, runs.length - 1);
    if (finished > live.drawnRuns) {
      drawRuns(this.workingContext, stroke, runs.slice(live.drawnRuns, finished));
      live.drawnRuns = finished;
    }
    const composed = this.composedContext;
    composed.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    composed.drawImage(this.working, 0, 0);
    drawRuns(composed, stroke, runs.slice(finished));
    return this.composed;
  }

  private start(event: PointerEvent) {
    if (this.live || event.button !== 0) return;
    if (this.filling) {
      this.fill(event);
      return;
    }
    this.canvas.setPointerCapture(event.pointerId);
    this.live = {
      stroke: new LiveStroke({ ...this.brush }, event.pointerType === "pen"),
      pointerId: event.pointerId,
      box: this.canvas.getBoundingClientRect(),
      drawnRuns: 0,
    };
    this.workingContext.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    this.workingContext.drawImage(this.image, 0, 0);
    this.sample(this.live, event);
    this.requestFrame();
    this.onStroke(true);
  }

  private move(event: PointerEvent) {
    if (event.pointerId !== this.live?.pointerId) return;
    // Every sample counts: a pen sends several between frames.
    const live = this.live;
    for (const sample of event.getCoalescedEvents?.() ?? [event]) this.sample(live, sample);
    this.requestFrame();
  }

  /** Paints the finished stroke into the image whole, as `drawStroke` draws it, and records it. */
  private end(event: PointerEvent) {
    const live = this.live;
    if (event.pointerId !== live?.pointerId) return;
    this.live = undefined;
    const stroke = live.stroke.stroke;
    drawStroke(this.imageContext, stroke);
    this.history.add(stroke, this.pixels().data);
    this.requestFrame();
    this.onStroke(false);
    this.changed();
  }

  /**
   * Fills from the clicked pixel and records it as one step. A click that changes nothing (on an
   * area already of the colour) isn't recorded.
   */
  private fill(event: PointerEvent) {
    const box = this.canvas.getBoundingClientRect();
    const pixel = (offset: number, size: number) =>
      Math.min(CANVAS_SIZE - 1, Math.max(0, Math.floor((offset / size) * CANVAS_SIZE)));
    const x = pixel(event.clientX - box.left, box.width);
    const y = pixel(event.clientY - box.top, box.height);
    const color = this.brush.color;
    const filled = floodFill(this.pixels(), x, y, color);
    if (!filled) return;
    this.imageContext.putImageData(new ImageData(filled, CANVAS_SIZE, CANVAS_SIZE), 0, 0);
    // Read back, as after a stroke, so the history holds exactly what the canvas does.
    this.history.add({ kind: "fill", x, y, color }, this.pixels().data);
    this.requestFrame();
    this.changed();
  }

  private sample({ stroke, box }: Live, event: PointerEvent) {
    const units = CANVAS_SIZE / box.width;
    stroke.add(
      (event.clientX - box.left) * units,
      (event.clientY - box.top) * units,
      event.pressure,
    );
  }

  private changed() {
    this.onChange(this.state);
  }
}
