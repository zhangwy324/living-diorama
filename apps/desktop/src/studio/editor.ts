import type { Drawing } from "@living-diorama/content-schema";
import { CANVAS_SIZE, drawStroke, toDrawing } from "../drawing";
import { appendedStroke, StrokeHistory } from "./history";
import { LiveStroke, type Brush } from "./live-stroke";

// The drawing editor's canvas, driven imperatively (ADR 0015 §11): React renders the toolbar
// only. Finished strokes are baked into a bitmap, so a frame draws the bitmap and the live
// stroke's round-capped lines; the stroke list in `StrokeHistory` is the only state.

/** What the toolbar and the close dialog need to know. */
export interface EditorState {
  canUndo: boolean;
  canRedo: boolean;
  empty: boolean;
}

export class DrawingEditor {
  brush: Brush = { tool: "pen", color: "#1e2a14", width: 10 };

  private readonly context: CanvasRenderingContext2D;
  private readonly bitmap = new OffscreenCanvas(1, 1);
  private readonly bitmapContext: OffscreenCanvasRenderingContext2D;
  private readonly history = new StrokeHistory();
  private live?: { stroke: LiveStroke; pointerId: number; box: DOMRect };
  private frame?: number;
  private readonly stop: () => void;

  /**
   * `onChange` is called whenever the strokes change: a stroke ends, undo, redo or clear.
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
    const bitmapContext = this.bitmap.getContext("2d");
    if (!context || !bitmapContext) throw new Error("No 2D canvas");
    this.context = context;
    this.bitmapContext = bitmapContext;

    // The backing store follows the canvas's size in device pixels, so it stays sharp on every
    // monitor; this observer box also fires when only the device pixel ratio changes.
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

  get drawing(): Drawing {
    return toDrawing(this.history.strokes);
  }

  get state(): EditorState {
    return {
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      empty: this.history.strokes.length === 0,
    };
  }

  /** Whether a stroke is being drawn; undo and redo wait until it ends. */
  get drawingStroke(): boolean {
    return this.live !== undefined;
  }

  undo(): void {
    this.replay(() => this.history.undo());
  }

  redo(): void {
    this.replay(() => this.history.redo());
  }

  clear(): void {
    this.replay(() => {
      this.history.clear();
      return true;
    });
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
    this.rebuild();
    this.changed();
  }

  dispose(): void {
    this.stop();
  }

  /** Applies a history step, then draws one stroke more onto the bitmap or rebuilds it. */
  private replay(step: () => boolean) {
    if (this.live) return;
    const before = this.history.strokes;
    if (!step()) return;
    const added = appendedStroke(before, this.history.strokes);
    if (added) this.bake(added);
    else this.rebuild();
    this.changed();
  }

  private resize(width: number, height: number) {
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = this.bitmap.width = width;
    this.canvas.height = this.bitmap.height = height;
    this.rebuild();
  }

  private scale() {
    return this.canvas.width / CANVAS_SIZE;
  }

  private rebuild() {
    const context = this.bitmapContext;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.bitmap.width, this.bitmap.height);
    for (const stroke of this.history.strokes) this.bake(stroke);
    this.requestFrame();
  }

  private bake(stroke: Drawing["strokes"][number]) {
    const scale = this.scale();
    this.bitmapContext.setTransform(scale, 0, 0, scale, 0, 0);
    drawStroke(this.bitmapContext, stroke);
    this.requestFrame();
  }

  private requestFrame() {
    this.frame ??= requestAnimationFrame(() => {
      this.frame = undefined;
      this.draw();
    });
  }

  /** The bitmap, then the live stroke over it; a live eraser cuts into the bitmap's copy. */
  private draw() {
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    context.drawImage(this.bitmap, 0, 0);
    if (this.live) {
      const scale = this.scale();
      context.setTransform(scale, 0, 0, scale, 0, 0);
      drawStroke(context, this.live.stroke.stroke);
    }
  }

  private start(event: PointerEvent) {
    if (this.live || event.button !== 0) return;
    this.canvas.setPointerCapture(event.pointerId);
    this.live = {
      stroke: new LiveStroke({ ...this.brush }, event.pointerType === "pen"),
      pointerId: event.pointerId,
      box: this.canvas.getBoundingClientRect(),
    };
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

  private end(event: PointerEvent) {
    const live = this.live;
    if (event.pointerId !== live?.pointerId) return;
    this.live = undefined;
    this.history.add(live.stroke.stroke);
    this.bake(live.stroke.stroke);
    this.onStroke(false);
    this.changed();
  }

  private sample({ stroke, box }: { stroke: LiveStroke; box: DOMRect }, event: PointerEvent) {
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
