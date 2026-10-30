import type {
  AppliedWorldEditOp,
  WorldEditInput,
  WorldEditOpInput,
  WorldEditResult,
} from "@living-diorama/content-schema";
import type { PropPreview, ViewPointer } from "@living-diorama/renderer";
import type { SceneProp } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { EditHistory } from "./edit-history";
import {
  COMMIT_DELAY_MS,
  NOTICE_MS,
  PropEditor,
  ROTATE_STEP,
  SCALE_STEP,
  type EditorKey,
  type EditorState,
  type EditorTimers,
} from "./prop-editor";

const prop = (id: string, x: number, z: number, scale = 1): SceneProp => ({
  id,
  model: `hollow:models/${id}.glb`,
  transform: { position: { x, y: 0, z }, rotationY: 0, scale },
  blockRadius: 0.5 * scale,
});

const at = (x: number, z: number): ViewPointer => ({ clientX: x, clientY: z });

const key = (name: string, extra: Partial<EditorKey> = {}): EditorKey => ({
  key: name,
  repeat: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...extra,
});

/** Timers that run only when told to. */
function manualTimers() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: EditorTimers = {
    set(callback, delayMs) {
      const handle = next++;
      due.set(handle, { at: now + delayMs, run: callback });
      return handle;
    },
    clear: (handle) => void due.delete(handle as number),
  };
  return {
    timers,
    advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...due].sort(([, a], [, b]) => a.at - b.at)) {
        if (timer.at > now) continue;
        due.delete(handle);
        timer.run();
      }
    },
  };
}

/**
 * An editor over a fake view, where a pointer's (clientX, clientY) is the ground's (x, z), and a
 * fake worker that applies every edit unless told to refuse.
 */
function setup(props: SceneProp[] = [prop("rock-1", 0, 0), prop("pine-1", 10, 10)]) {
  const sent: WorldEditInput[] = [];
  let answer: (edit: WorldEditInput) => WorldEditResult = (edit) => applied(edit);
  const history = new EditHistory(
    async (edit) => {
      sent.push(edit);
      return answer(edit);
    },
    () => editor.historyChanged(),
  );
  const view = {
    /** The prop under each pointer, by its x. */
    props: new Map<number, string>([
      [0, "rock-1"],
      [10, "pine-1"],
    ]),
    selected: undefined as string | undefined,
    preview: undefined as PropPreview | undefined,
    hidden: undefined as string | undefined,
    pickProp: vi.fn((pointer: ViewPointer) => {
      const placementId = view.props.get(pointer.clientX);
      return placementId === undefined
        ? undefined
        : { placementId, point: { x: pointer.clientX, y: 0, z: pointer.clientY } };
    }),
    pickGround: vi.fn((pointer: ViewPointer) =>
      pointer.clientX < -100 ? undefined : { x: pointer.clientX, y: 1, z: pointer.clientY },
    ),
    selectProp: (id: string | undefined) => (view.selected = id),
    previewProp: (preview: PropPreview | undefined) => (view.preview = preview),
    hideProp: (id: string | undefined) => (view.hidden = id),
  };
  const time = manualTimers();
  let state: EditorState | undefined;
  const editor = new PropEditor({
    view,
    history,
    propTypes: {
      "hollow:rock": { name: "Rock", model: "hollow:models/rock.glb", blockRadius: 0.5 },
    },
    props,
    onChange: (next) => (state = next),
    timers: time.timers,
  });
  editor.setActive(true);
  return {
    editor,
    view,
    sent,
    history,
    time,
    state: () => state,
    answer: (next: (edit: WorldEditInput) => WorldEditResult) => (answer = next),
    /** Lets the edits sent so far be answered. */
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    click(pointer: ViewPointer) {
      editor.pointerDown(pointer, 0);
      editor.pointerUp(pointer);
    },
  };
}

/** The worker's answer to an applied edit: adds get `prop-1`, and the inverse is a marker. */
function applied(edit: WorldEditInput, extra: Partial<WorldEditResult> = {}): WorldEditResult {
  const ops = edit.ops.map((op: WorldEditOpInput) =>
    op.op === "prop.add" ? { rotationY: 0, scale: 1, ...op, id: op.id ?? "prop-1" } : op,
  ) as AppliedWorldEditOp[];
  return {
    ok: true,
    edit: { ops },
    inverse: { ops: [{ op: "prop.remove", id: "inverse" }] },
    footprints: [],
    blockedExits: [],
    warnings: [],
    relocated: [],
    ...extra,
  } as WorldEditResult;
}

describe("PropEditor selection", () => {
  it("selects a prop on a click, and a click on the ground or Esc deselects", () => {
    const { editor, view, click, state } = setup();
    click(at(0, 0));
    expect(view.selected).toBe("rock-1");
    expect(state()?.selected).toBe("rock-1");
    click(at(5, 5));
    expect(view.selected).toBeUndefined();
    click(at(10, 10));
    expect(view.selected).toBe("pine-1");
    expect(editor.key(key("Escape"))).toBe(true);
    expect(view.selected).toBeUndefined();
    // With nothing selected, Esc is left to the window (it leaves full screen).
    expect(editor.key(key("Escape"))).toBe(false);
  });

  it("leaves a press anywhere but on the selected prop to the camera", () => {
    const { editor, click } = setup();
    expect(editor.pointerDown(at(0, 0), 0)).toBe(false);
    editor.pointerUp(at(0, 0));
    expect(editor.pointerDown(at(10, 10), 0)).toBe(false);
    editor.pointerUp(at(10, 10));
    click(at(0, 0));
    expect(editor.pointerDown(at(0, 0), 0)).toBe(true);
    // Only the left button.
    expect(editor.pointerDown(at(0, 0), 2)).toBe(false);
  });

  it("keeps the selection when the press orbits the camera", () => {
    const { editor, view, click } = setup();
    click(at(0, 0));
    editor.pointerDown(at(5, 5), 0);
    editor.pointerUp(at(40, 5));
    expect(view.selected).toBe("rock-1");
  });

  it("does nothing while Edit mode is off, and turning it off deselects", () => {
    const { editor, view, click } = setup();
    click(at(0, 0));
    editor.setActive(false);
    expect(view.selected).toBeUndefined();
    click(at(0, 0));
    expect(view.selected).toBeUndefined();
    expect(editor.wheel(100)).toBe(false);
    expect(editor.key(key("Delete"))).toBe(false);
  });

  it("drops the selection when its prop is gone from the drawn props", () => {
    const { editor, view, click } = setup();
    click(at(0, 0));
    editor.setProps([prop("pine-1", 10, 10)]);
    expect(view.selected).toBeUndefined();
  });
});

describe("PropEditor moving", () => {
  it("drags the selected prop with a preview and commits one move on release", async () => {
    const { editor, view, sent, click, settle } = setup();
    click(at(0, 0));
    // Grabbed 1 m off its centre: it keeps that offset.
    view.props.set(1, "rock-1");
    expect(editor.pointerDown(at(1, 0), 0)).toBe(true);
    // A small move is not yet a drag.
    expect(editor.pointerMove(at(2, 2))).toBe(false);
    for (let x = 4; x <= 9; x++) expect(editor.pointerMove(at(x, 3))).toBe(true);
    expect(view.hidden).toBe("rock-1");
    expect(view.preview?.transform.position).toEqual({ x: 8, y: 1, z: 3 });
    // Nothing is sent while dragging.
    expect(sent).toEqual([]);
    expect(editor.pointerUp(at(9, 3))).toBe(true);
    await settle();
    expect(sent).toEqual([{ ops: [{ op: "prop.move", id: "rock-1", position: { x: 8, z: 3 } }] }]);
    // The preview stays until the edit is drawn, so the prop doesn't jump back meanwhile.
    expect(view.preview).toBeDefined();
    editor.setProps([prop("rock-1", 8, 3), prop("pine-1", 10, 10)]);
    expect(view.preview).toBeUndefined();
    expect(view.hidden).toBeUndefined();
    expect(view.selected).toBe("rock-1");
  });

  it("keeps the prop where the pointer last met the ground", async () => {
    const { editor, sent, click, settle } = setup();
    click(at(0, 0));
    editor.pointerDown(at(0, 0), 0);
    editor.pointerMove(at(6, 0));
    editor.pointerMove(at(-200, 0));
    editor.pointerUp(at(-200, 0));
    await settle();
    expect(sent[0]?.ops[0]).toMatchObject({ position: { x: 6, z: 0 } });
  });

  it("takes the preview away at once when the move is refused, and says why", async () => {
    const { editor, view, sent, click, settle, answer, state } = setup();
    answer(() => ({
      ok: false,
      diagnostics: [
        { severity: "error", code: "outside_world", message: "Outside the world", path: [] },
      ],
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    click(at(0, 0));
    editor.pointerDown(at(0, 0), 0);
    editor.pointerMove(at(30, 0));
    editor.pointerUp(at(30, 0));
    await settle();
    expect(sent).toHaveLength(1);
    expect(view.preview).toBeUndefined();
    expect(view.hidden).toBeUndefined();
    expect(state()?.notice).toEqual({ kind: "error", text: "Outside the world" });
    warn.mockRestore();
  });

  it("drops a drag the pointer was taken from", () => {
    const { editor, view, sent, click } = setup();
    click(at(0, 0));
    editor.pointerDown(at(0, 0), 0);
    editor.pointerMove(at(6, 0));
    editor.pointerCancel();
    expect(view.preview).toBeUndefined();
    expect(view.hidden).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe("PropEditor scaling and turning", () => {
  it("scales with the wheel, previewing, and commits once after a pause", async () => {
    const { editor, view, sent, click, time, settle } = setup();
    expect(editor.wheel(-100)).toBe(false);
    click(at(0, 0));
    expect(editor.wheel(-100)).toBe(true);
    time.advance(COMMIT_DELAY_MS - 1);
    expect(editor.wheel(-100)).toBe(true);
    time.advance(COMMIT_DELAY_MS - 1);
    expect(view.preview?.transform.scale).toBeCloseTo(SCALE_STEP ** 2);
    expect(view.preview?.blockRadius).toBeCloseTo(0.5 * SCALE_STEP ** 2);
    expect(view.hidden).toBe("rock-1");
    expect(sent).toEqual([]);
    time.advance(1);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ops).toHaveLength(1);
    expect(sent[0]?.ops[0]).toMatchObject({ op: "prop.scale", id: "rock-1" });
    const op = sent[0]?.ops[0];
    expect(op?.op === "prop.scale" && op.scale).toBeCloseTo(SCALE_STEP ** 2);
  });

  it("never scales to 0 or below", () => {
    const { editor, view, click } = setup();
    click(at(0, 0));
    for (let i = 0; i < 200; i++) editor.wheel(1000);
    expect(view.preview?.transform.scale).toBeGreaterThan(0);
  });

  it("starts the next scale from the last one committed, before it is drawn", async () => {
    const { editor, sent, click, time, settle } = setup();
    click(at(0, 0));
    editor.wheel(-100);
    time.advance(COMMIT_DELAY_MS);
    await settle();
    editor.wheel(-100);
    time.advance(COMMIT_DELAY_MS);
    await settle();
    const op = sent[1]?.ops[0];
    expect(op?.op === "prop.scale" && op.scale).toBeCloseTo(SCALE_STEP ** 2);
  });

  it("turns with R and Shift+R, turn and scale going as one edit", async () => {
    const { editor, sent, click, time, settle } = setup();
    click(at(0, 0));
    expect(editor.key(key("r"))).toBe(true);
    expect(editor.key(key("R", { shiftKey: true }))).toBe(true);
    expect(editor.key(key("r"))).toBe(true);
    editor.wheel(-100);
    time.advance(COMMIT_DELAY_MS);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ops[0]).toEqual({ op: "prop.move", id: "rock-1", rotationY: ROTATE_STEP });
    expect(sent[0]?.ops[1]).toMatchObject({ op: "prop.scale", id: "rock-1" });
  });

  it("commits a pending turn before another prop is selected", async () => {
    const { editor, sent, click, settle } = setup();
    click(at(0, 0));
    editor.rotate(-1);
    click(at(10, 10));
    await settle();
    expect(sent[0]?.ops[0]).toEqual({
      op: "prop.move",
      id: "rock-1",
      rotationY: 2 * Math.PI - ROTATE_STEP,
    });
  });

  it("moves, turns and scales in one edit when a drag follows a turn", async () => {
    const { editor, sent, click, time, settle } = setup();
    click(at(0, 0));
    editor.rotate(1);
    editor.pointerDown(at(0, 0), 0);
    editor.pointerMove(at(5, 0));
    editor.wheel(-100);
    editor.pointerUp(at(5, 0));
    time.advance(COMMIT_DELAY_MS * 2);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.ops[0]).toEqual({
      op: "prop.move",
      id: "rock-1",
      position: { x: 5, z: 0 },
      rotationY: ROTATE_STEP,
    });
    expect(sent[0]?.ops[1]).toMatchObject({ op: "prop.scale", id: "rock-1" });
  });
});

describe("PropEditor deleting, adding and undo", () => {
  it("deletes the selected prop with Delete or Backspace", async () => {
    const { editor, view, sent, click, settle } = setup();
    expect(editor.key(key("Delete"))).toBe(false);
    click(at(0, 0));
    expect(editor.key(key("Delete"))).toBe(true);
    expect(view.selected).toBeUndefined();
    click(at(10, 10));
    expect(editor.key(key("Backspace"))).toBe(true);
    await settle();
    expect(sent).toEqual([
      { ops: [{ op: "prop.remove", id: "rock-1" }] },
      { ops: [{ op: "prop.remove", id: "pine-1" }] },
    ]);
  });

  it("places a prop from the palette with a preview following the pointer, then selects it", async () => {
    const { editor, view, sent, click, settle, state } = setup();
    editor.choosePlacing("hollow:rock");
    expect(state()?.placing).toBe("hollow:rock");
    editor.pointerMove(at(4, 4));
    expect(view.preview).toEqual({
      model: "hollow:models/rock.glb",
      transform: { position: { x: 4, y: 1, z: 4 }, rotationY: 0, scale: 1 },
      blockRadius: 0.5,
    });
    editor.key(key("r"));
    // A press that orbits places nothing.
    expect(editor.pointerDown(at(5, 5), 0)).toBe(false);
    editor.pointerUp(at(50, 5));
    expect(sent).toEqual([]);
    click(at(6, 7));
    expect(state()?.placing).toBeUndefined();
    await settle();
    expect(sent).toEqual([
      {
        ops: [
          { op: "prop.add", prop: "hollow:rock", position: { x: 6, z: 7 }, rotationY: ROTATE_STEP },
        ],
      },
    ]);
    expect(view.selected).toBe("prop-1");
  });

  it("stops placing with Esc or the chosen chip again", () => {
    const { editor, view, state } = setup();
    editor.choosePlacing("hollow:rock");
    editor.pointerMove(at(4, 4));
    expect(editor.key(key("Escape"))).toBe(true);
    expect(state()?.placing).toBeUndefined();
    expect(view.preview).toBeUndefined();
    editor.choosePlacing("hollow:unknown");
    expect(state()?.placing).toBeUndefined();
  });

  it("undoes with Ctrl+Z and redoes with Ctrl+Y or Ctrl+Shift+Z", async () => {
    const { editor, sent, click, settle, state } = setup();
    click(at(0, 0));
    editor.key(key("Delete"));
    await settle();
    expect(state()?.canUndo).toBe(true);
    expect(editor.key(key("z", { ctrlKey: true }))).toBe(true);
    await settle();
    expect(state()?.canRedo).toBe(true);
    expect(editor.key(key("y", { ctrlKey: true }))).toBe(true);
    await settle();
    expect(editor.key(key("z", { ctrlKey: true }))).toBe(true);
    await settle();
    expect(editor.key(key("Z", { ctrlKey: true, shiftKey: true }))).toBe(true);
    await settle();
    expect(sent.map((edit) => edit.ops[0])).toEqual([
      { op: "prop.remove", id: "rock-1" },
      { op: "prop.remove", id: "inverse" },
      { op: "prop.remove", id: "inverse" },
      { op: "prop.remove", id: "inverse" },
      { op: "prop.remove", id: "inverse" },
    ]);
  });

  it("commits a pending scale before undoing, so the undo takes it back", async () => {
    const { editor, sent, click, settle } = setup();
    click(at(0, 0));
    editor.wheel(-100);
    await editor.undo();
    await settle();
    expect(sent.map((edit) => edit.ops[0]?.op)).toEqual(["prop.scale", "prop.remove"]);
  });

  it("shows an applied edit's warnings and moved creatures, for a while", async () => {
    const { editor, click, settle, answer, state, time } = setup();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    answer((edit) =>
      applied(edit, {
        warnings: [
          {
            severity: "warning",
            code: "water_exit_blocked",
            message: "Blocks a way out",
            path: [],
          },
        ],
        relocated: [
          {
            creatureId: "c1",
            from: { regionId: "r", x: 0, z: 0 },
            to: { regionId: "r", x: 1, z: 0 },
          },
        ],
      } as Partial<WorldEditResult>),
    );
    click(at(0, 0));
    editor.deleteSelected();
    await settle();
    expect(state()?.notice).toEqual({
      kind: "warning",
      text: "Moved 1 creature out of the way (+1 more)",
    });
    time.advance(NOTICE_MS);
    expect(state()?.notice).toBeUndefined();
    warn.mockRestore();
  });
});

describe("PropEditor clearing", () => {
  it("forgets the undo history, the selection and a pending scale on a restore", async () => {
    const { editor, view, sent, click, settle, time, state } = setup();
    click(at(0, 0));
    editor.key(key("Delete"));
    await settle();
    click(at(10, 10));
    editor.wheel(-100);
    editor.clear();
    expect(view.selected).toBeUndefined();
    expect(view.preview).toBeUndefined();
    expect(view.hidden).toBeUndefined();
    expect(state()).toMatchObject({ selected: undefined, canUndo: false, canRedo: false });
    time.advance(COMMIT_DELAY_MS);
    await settle();
    // The pending scale was dropped, not committed.
    expect(sent).toHaveLength(1);
    expect(await editor.undo()).toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});
