import type { WorldEditInput, WorldEditResult } from "@living-diorama/content-schema";
import { expect, it, vi } from "vitest";
import { worldDevHook } from "./dev-world";
import { EditHistory } from "./edit-history";
import type { WorldSaving } from "./world-saving";

it("edits, validates, undoes and redoes through the editor's history", async () => {
  const sent: string[] = [];
  const edit = vi.fn(async (input: WorldEditInput): Promise<WorldEditResult> => {
    const op = input.ops[0];
    const id = op?.op === "prop.remove" ? op.id : "?";
    sent.push(id);
    return {
      ok: true,
      edit: { ops: [{ op: "prop.remove", id }] },
      inverse: { ops: [{ op: "prop.remove", id: `un${id}` }] },
      footprints: [],
      blockedExits: [],
      warnings: [],
      relocated: [],
    };
  });
  const history = new EditHistory(edit);
  const validateEdit = vi.fn(async () => ({
    ok: true as const,
    footprints: [],
    blockedExits: [],
    warnings: [],
    relocated: [],
  }));
  const hook = worldDevHook({} as WorldSaving, { history, validateEdit, clear: () => {} });
  const removeRock = { ops: [{ op: "prop.remove" as const, id: "rock" }] };
  expect((await hook.validate(removeRock)).ok).toBe(true);
  expect(validateEdit).toHaveBeenCalledWith(removeRock);
  expect(sent).toEqual([]);
  await hook.edit(removeRock);
  expect(history.canUndo).toBe(true);
  await hook.undo();
  await hook.redo();
  expect(sent).toEqual(["rock", "unrock", "ununrock"]);
});
