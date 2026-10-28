import type { DrawingOperation } from "@living-diorama/content-schema";

/** A rectangle of the image's pixels: RGBA, row by row. */
export interface Patch {
  x: number;
  y: number;
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** What an undo or redo did to the image: the pixels to put back, if any changed. */
export interface Change {
  patch?: Patch;
}

/** One step: the record and the changed pixels before and after it. */
interface Step {
  records: [before: readonly DrawingOperation[], after: readonly DrawingOperation[]];
  patches?: [before: Patch, after: Patch];
  bytes: number;
}

/**
 * Undo keeps at most this many bytes of pixels (ADR 0015 §11): at least 64 steps that change
 * the whole canvas, and about a thousand ordinary strokes. The oldest steps go first.
 */
export const HISTORY_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * The editor's image and record, with undo and redo (ADR 0015 §11). The image is the drawing;
 * each step keeps the pixels it changed, before and after, cut to the rectangle that changed,
 * and the record it replaced. Undoing and redoing put pixels back and never replay operations.
 * A new operation drops the steps undone before it, from the image's history and the record
 * alike, so the record always tells how the image now shown was made.
 */
export class DrawingHistory {
  record: readonly DrawingOperation[] = [];
  private pixels: Uint8ClampedArray;
  private past: Step[] = [];
  private future: Step[] = [];
  private bytes = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly budget = HISTORY_BUDGET_BYTES,
  ) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** The bytes of pixels undo and redo keep. */
  get size(): number {
    return this.bytes;
  }

  /** Records that `operation` turned the image into `pixels` (RGBA, the image's size). */
  add(operation: DrawingOperation, pixels: Uint8ClampedArray): void {
    this.change([...this.record, operation], pixels);
  }

  /**
   * Records that the image was emptied, as one step that can be undone, and starts the record
   * over. Returns false, and does nothing, if nothing was drawn.
   */
  clear(): boolean {
    if (this.record.length === 0) return false;
    this.change([], new Uint8ClampedArray(this.pixels.length));
    return true;
  }

  /** Starts over: an empty image, an empty record and nothing to undo or redo. */
  reset(): void {
    this.record = [];
    this.pixels = new Uint8ClampedArray(this.pixels.length);
    this.past = [];
    this.future = [];
    this.bytes = 0;
  }

  /** Steps back. Undefined if there was nothing to undo. */
  undo(): Change | undefined {
    const step = this.past.pop();
    if (!step) return undefined;
    this.future.push(step);
    return this.apply(step, 0);
  }

  /** Steps forward again. Undefined if there was nothing to redo. */
  redo(): Change | undefined {
    const step = this.future.pop();
    if (!step) return undefined;
    this.past.push(step);
    return this.apply(step, 1);
  }

  private apply(step: Step, side: 0 | 1): Change {
    this.record = step.records[side];
    const patch = step.patches?.[side];
    if (patch) putPatch(this.pixels, this.width, patch);
    return { patch };
  }

  private change(record: readonly DrawingOperation[], pixels: Uint8ClampedArray) {
    if (pixels.length !== this.pixels.length) throw new Error("The image changed size");
    for (const undone of this.future) this.bytes -= undone.bytes;
    this.future = [];
    const box = changedBox(this.pixels, pixels, this.width);
    const patches: Step["patches"] = box && [
      cutPatch(this.pixels, this.width, box),
      cutPatch(pixels, this.width, box),
    ];
    const bytes = patches ? patches[0].data.length * 2 : 0;
    this.past.push({ records: [this.record, record], patches, bytes });
    this.bytes += bytes;
    // The newest step is always kept, however big.
    while (this.bytes > this.budget && this.past.length > 1) {
      this.bytes -= this.past.shift()?.bytes ?? 0;
    }
    this.record = record;
    this.pixels = pixels.slice();
  }
}

type Box = Omit<Patch, "data">;

/** The smallest rectangle holding every pixel that differs, or undefined if none does. */
export function changedBox(
  before: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
): Box | undefined {
  // A pixel at a time, as one 32-bit number.
  const a = new Uint32Array(before.buffer, before.byteOffset, before.length / 4);
  const b = new Uint32Array(after.buffer, after.byteOffset, after.length / 4);
  const height = a.length / width;
  let left = width;
  let right = -1;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1;
    for (let x = 0; x < width; x++) {
      if (a[row + x] !== b[row + x]) {
        first = x;
        break;
      }
    }
    if (first < 0) continue;
    if (top < 0) top = y;
    bottom = y;
    left = Math.min(left, first);
    for (let x = width - 1; x > right; x--) {
      if (a[row + x] !== b[row + x]) {
        right = x;
        break;
      }
    }
  }
  if (top < 0) return undefined;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function cutPatch(pixels: Uint8ClampedArray, width: number, box: Box): Patch {
  const data = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) {
    const from = ((box.y + y) * width + box.x) * 4;
    data.set(pixels.subarray(from, from + box.width * 4), y * box.width * 4);
  }
  return { ...box, data };
}

function putPatch(pixels: Uint8ClampedArray, width: number, patch: Patch) {
  for (let y = 0; y < patch.height; y++) {
    const row = patch.data.subarray(y * patch.width * 4, (y + 1) * patch.width * 4);
    pixels.set(row, ((patch.y + y) * width + patch.x) * 4);
  }
}
