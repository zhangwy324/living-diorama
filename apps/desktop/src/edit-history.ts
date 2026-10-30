import type {
  AppliedWorldEdit,
  WorldEditInput,
  WorldEditResult,
} from "@living-diorama/content-schema";

/** An applied edit and the edit that undoes it, as the worker returned them. */
interface EditStep {
  forward: AppliedWorldEdit;
  backward: AppliedWorldEdit;
}

/** Most undo steps kept; the oldest is dropped beyond it. */
export const MAX_UNDO_STEPS = 100;

/**
 * The session's undo and redo stacks over the worker's edit command (ADR 0021 §4, §10). Every
 * applied edit returns its inverse, so undoing is one more edit, and redoing applies the inverse
 * of that. Edits, undos and redos run one at a time in the order asked, so an undo asked while an
 * edit is still being applied undoes that edit. The stacks are session history only, never saved.
 *
 * A refused undo or redo leaves its step where it was, so it can be tried again once whatever
 * stood in its way is gone. `clear` (on a restore or reset) forgets both stacks, and an edit still
 * being applied when it is called adds no step.
 */
export class EditHistory {
  readonly #edit: (edit: WorldEditInput) => Promise<WorldEditResult>;
  readonly #onChange: () => void;
  #undo: EditStep[] = [];
  #redo: EditStep[] = [];
  #queue: Promise<unknown> = Promise.resolve();
  #generation = 0;

  constructor(edit: (edit: WorldEditInput) => Promise<WorldEditResult>, onChange = () => {}) {
    this.#edit = edit;
    this.#onChange = onChange;
  }

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

  /** Applies a new edit; once applied, it is the step to undo and nothing is left to redo. */
  apply(edit: WorldEditInput): Promise<WorldEditResult> {
    return this.#run(async (current) => {
      const result = await this.#edit(edit);
      if (result.ok && current()) {
        this.#undo.push({ forward: result.edit, backward: result.inverse });
        if (this.#undo.length > MAX_UNDO_STEPS) this.#undo.shift();
        this.#redo = [];
        this.#onChange();
      }
      return result;
    });
  }

  /** Undoes the last step; resolves undefined when there was none. */
  undo(): Promise<WorldEditResult | undefined> {
    return this.#run(async (current) => {
      const step = this.#undo.at(-1);
      if (!step) return undefined;
      const result = await this.#edit(step.backward);
      if (result.ok && current()) {
        this.#undo.pop();
        this.#redo.push({ forward: result.inverse, backward: result.edit });
        this.#onChange();
      }
      return result;
    });
  }

  /** Redoes the last undone step; resolves undefined when there was none. */
  redo(): Promise<WorldEditResult | undefined> {
    return this.#run(async (current) => {
      const step = this.#redo.at(-1);
      if (!step) return undefined;
      const result = await this.#edit(step.forward);
      if (result.ok && current()) {
        this.#redo.pop();
        this.#undo.push({ forward: result.edit, backward: result.inverse });
        this.#onChange();
      }
      return result;
    });
  }

  /** Forgets both stacks, e.g. after the world was replaced by a save. */
  clear(): void {
    this.#generation++;
    const changed = this.canUndo || this.canRedo;
    this.#undo = [];
    this.#redo = [];
    if (changed) this.#onChange();
  }

  /** Runs `task` after every earlier one; `current` says whether no `clear` came since it began. */
  #run<T>(task: (current: () => boolean) => Promise<T>): Promise<T> {
    const generation = this.#generation;
    const run = this.#queue.then(() => task(() => generation === this.#generation));
    // A failed task must not stop the ones queued behind it.
    this.#queue = run.catch(() => {});
    return run;
  }
}
