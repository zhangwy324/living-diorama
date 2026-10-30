import type {
  WorldEditCheck,
  WorldEditInput,
  WorldEditResult,
} from "@living-diorama/content-schema";
import type { EditHistory } from "./edit-history";
import type { WorldSaving } from "./world-saving";

// A development-only console hook to the saved world (ADR 0019 §9) and to world edits (ADR 0021
// §12); players have no reset. In the dev app's console:
//
//   await livingDiorama.world.reset()   // every creature out, the starting ones in, then saved
//   await livingDiorama.world.save()    // save now instead of within the minute
//   await livingDiorama.world.edit({ ops: [{ op: "prop.add", prop: "hollow:rock",
//                                            position: { x: 0, z: 0 } }] })
//   await livingDiorama.world.validate({ ops: [...] })  // what the edit would do, as a dry run
//   await livingDiorama.world.undo()    // undo the last edit, from here or the editor
//   await livingDiorama.world.redo()

export interface WorldDevHook {
  reset(): Promise<void>;
  save(): Promise<void>;
  /** Applies an edit; it can be undone, here or in the editor. Resolves with the result. */
  edit(edit: WorldEditInput): Promise<WorldEditResult>;
  /** What the edit would do, without doing it. */
  validate(edit: WorldEditInput): Promise<WorldEditCheck>;
  /** Undoes the last edit; resolves undefined when there is none. */
  undo(): Promise<WorldEditResult | undefined>;
  /** Redoes the last undone edit; resolves undefined when there is none. */
  redo(): Promise<WorldEditResult | undefined>;
}

export interface WorldEditing {
  history: EditHistory;
  validateEdit(edit: WorldEditInput): Promise<WorldEditCheck>;
  /** Forgets the undo history and the editor's selection, after a reset. */
  clear(): void;
}

/** The hook's commands. */
export function worldDevHook(saving: WorldSaving, editing: WorldEditing): WorldDevHook {
  return {
    async reset() {
      await saving.reset();
      editing.clear();
    },
    save: () => saving.save(),
    edit: (edit) => editing.history.apply(edit),
    validate: (edit) => editing.validateEdit(edit),
    undo: () => editing.history.undo(),
    redo: () => editing.history.redo(),
  };
}

/** Puts the hook on `window.livingDiorama.world`; returns a function that takes it off again. */
export function installWorldDevHook(saving: WorldSaving, editing: WorldEditing): () => void {
  const hook = worldDevHook(saving, editing);
  window.livingDiorama = { ...window.livingDiorama, world: hook };
  return () => {
    if (window.livingDiorama?.world === hook) delete window.livingDiorama.world;
  };
}
