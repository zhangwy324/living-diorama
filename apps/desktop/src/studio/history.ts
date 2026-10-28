import type { Stroke } from "@living-diorama/content-schema";

/**
 * The editor's strokes with undo and redo (ADR 0015 §11). Each change keeps the stroke list it
 * replaced; the lists share their strokes, so a step costs one array.
 */
export class StrokeHistory {
  strokes: readonly Stroke[] = [];
  private past: (readonly Stroke[])[] = [];
  private future: (readonly Stroke[])[] = [];

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  add(stroke: Stroke): void {
    this.change([...this.strokes, stroke]);
  }

  /** Removes every stroke, as one step that can be undone. Does nothing if there are none. */
  clear(): void {
    if (this.strokes.length > 0) this.change([]);
  }

  /** Returns whether there was something to undo. */
  undo(): boolean {
    const previous = this.past.pop();
    if (!previous) return false;
    this.future.push(this.strokes);
    this.strokes = previous;
    return true;
  }

  /** Returns whether there was something to redo. */
  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.strokes);
    this.strokes = next;
    return true;
  }

  private change(strokes: readonly Stroke[]) {
    this.past.push(this.strokes);
    this.future = [];
    this.strokes = strokes;
  }
}

/** The stroke `after` adds to the end of `before`, if that is the only difference. */
export function appendedStroke(
  before: readonly Stroke[],
  after: readonly Stroke[],
): Stroke | undefined {
  if (after.length !== before.length + 1) return undefined;
  return before.every((stroke, i) => after[i] === stroke) ? after.at(-1) : undefined;
}
