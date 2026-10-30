import type {
  AppliedWorldEdit,
  WorldEditInput,
  WorldEditResult,
} from "@living-diorama/content-schema";
import { describe, expect, it, vi } from "vitest";
import { EditHistory, MAX_UNDO_STEPS } from "./edit-history";

const removal = (id: string): AppliedWorldEdit => ({ ops: [{ op: "prop.remove", id }] });

/**
 * A worker that applies every edit: each edit is a removal named after what it does, and its
 * inverse removes `un<name>`, so an undo of `a` sends `una` and a redo sends `ununa`.
 */
function fakeWorker() {
  const sent: string[] = [];
  let refuse = false;
  const edit = vi.fn((input: WorldEditInput): Promise<WorldEditResult> => {
    const op = input.ops[0];
    const name = op?.op === "prop.remove" ? op.id : "?";
    sent.push(name);
    if (refuse) {
      return Promise.resolve({
        ok: false,
        diagnostics: [{ severity: "error", code: "no", message: "refused", path: [] }],
      });
    }
    return Promise.resolve({
      ok: true,
      edit: removal(name),
      inverse: removal(`un${name}`),
      footprints: [],
      blockedExits: [],
      warnings: [],
      relocated: [],
    });
  });
  return {
    edit,
    sent,
    refuse: (value: boolean) => (refuse = value),
  };
}

describe("EditHistory", () => {
  it("undoes with the inverse and redoes with the inverse of that", async () => {
    const worker = fakeWorker();
    const onChange = vi.fn();
    const history = new EditHistory(worker.edit, onChange);
    expect(history.canUndo).toBe(false);
    await history.apply(removal("a"));
    await history.apply(removal("b"));
    expect(history.canUndo).toBe(true);
    await history.undo();
    await history.undo();
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
    await history.redo();
    await history.undo();
    expect(worker.sent).toEqual(["a", "b", "unb", "una", "ununa", "unununa"]);
    expect(onChange).toHaveBeenCalledTimes(6);
  });

  it("resolves undefined with nothing to undo or redo, sending nothing", async () => {
    const worker = fakeWorker();
    const history = new EditHistory(worker.edit);
    expect(await history.undo()).toBeUndefined();
    expect(await history.redo()).toBeUndefined();
    expect(worker.sent).toEqual([]);
  });

  it("drops what was undone when a new edit is applied", async () => {
    const worker = fakeWorker();
    const history = new EditHistory(worker.edit);
    await history.apply(removal("a"));
    await history.undo();
    await history.apply(removal("b"));
    expect(history.canRedo).toBe(false);
  });

  it("keeps a refused undo's step, so it can be tried again", async () => {
    const worker = fakeWorker();
    const history = new EditHistory(worker.edit);
    await history.apply(removal("a"));
    worker.refuse(true);
    const refused = await history.undo();
    expect(refused?.ok).toBe(false);
    expect(history.canUndo).toBe(true);
    expect(history.canRedo).toBe(false);
    worker.refuse(false);
    await history.undo();
    expect(worker.sent).toEqual(["a", "una", "una"]);
  });

  it("adds no step for a refused edit", async () => {
    const worker = fakeWorker();
    const history = new EditHistory(worker.edit);
    worker.refuse(true);
    await history.apply(removal("a"));
    expect(history.canUndo).toBe(false);
  });

  it("runs an undo asked while an edit is applied after it, undoing that edit", async () => {
    const worker = fakeWorker();
    const history = new EditHistory(worker.edit);
    const applying = history.apply(removal("a"));
    const undoing = history.undo();
    await Promise.all([applying, undoing]);
    expect(worker.sent).toEqual(["a", "una"]);
  });

  it("forgets both stacks on clear, and an edit in flight then adds no step", async () => {
    const worker = fakeWorker();
    const history = new EditHistory(worker.edit);
    await history.apply(removal("a"));
    await history.apply(removal("b"));
    await history.undo();
    const applying = history.apply(removal("c"));
    history.clear();
    await applying;
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
  });

  it("keeps at most MAX_UNDO_STEPS steps", async () => {
    const worker = fakeWorker();
    const history = new EditHistory(worker.edit);
    for (let i = 0; i <= MAX_UNDO_STEPS; i++) await history.apply(removal(`e${i}`));
    let undone = 0;
    while (history.canUndo) {
      await history.undo();
      undone++;
    }
    expect(undone).toBe(MAX_UNDO_STEPS);
    expect(worker.sent.at(-1)).toBe("une1");
  });

  it("carries on after an edit that throws", async () => {
    const worker = fakeWorker();
    worker.edit.mockRejectedValueOnce(new Error("stopped"));
    const history = new EditHistory(worker.edit);
    await expect(history.apply(removal("a"))).rejects.toThrow("stopped");
    await history.apply(removal("b"));
    expect(history.canUndo).toBe(true);
  });
});
