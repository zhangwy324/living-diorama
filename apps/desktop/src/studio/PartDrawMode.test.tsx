// @vitest-environment jsdom
import {
  parsePlayerPartEntry,
  type PlayerPartEntry,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import { createMemoryPartsStore, type PartsStore } from "@living-diorama/desktop-integration";
import type { AssemblyView } from "@living-diorama/renderer";
import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloseDialog } from "./CloseDialog";
import { builtInParts } from "./fixtures/built-in-parts";
import { useOpenDraw } from "./open-draw";
import type { DrawRequest, OpenDraw, StudioMode } from "./modes";
import { BASE_GONE, PartDrawMode } from "./PartDrawMode";
import { closeMessage } from "./modes";
import { ModeSwitch } from "./ModeSwitch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The preview draws with WebGL, which jsdom lacks: a stand-in that records what it shows.
const view = vi.hoisted(() => ({
  created: 0,
  disposed: 0,
  assembly: undefined as VoxelAssembly | undefined,
}));
vi.mock("@living-diorama/renderer", () => ({
  createAssemblyView: (): Partial<AssemblyView> => {
    view.created += 1;
    return {
      setAssembly: (assembly) => {
        view.assembly = assembly;
      },
      setHighlightedSockets: () => {},
      dispose: () => {
        view.disposed += 1;
      },
    };
  },
}));
let root: Root | undefined;
let container: HTMLDivElement;

beforeEach(() => {
  view.created = 0;
  view.disposed = 0;
  view.assembly = undefined;
  // A 320 px grid at the page's top-left: 10 px a cell.
  HTMLCanvasElement.prototype.getContext = () => null;
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLCanvasElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 320, height: 320, right: 320, bottom: 320 }) as DOMRect;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

async function setup(store: PartsStore = createMemoryPartsStore()) {
  const onUnsaved = vi.fn<(unsaved: boolean) => void>();
  const onSaved = vi.fn<(entry: PlayerPartEntry) => void>();
  const onUseInBuild = vi.fn<(entry: PlayerPartEntry) => void>();
  const onNew = vi.fn<(partType: string) => void>();
  const client = { parts: () => Promise.resolve(builtInParts()) };
  root = createRoot(container);
  let request: DrawRequest | undefined;
  let active = true;
  const render = () =>
    act(async () =>
      root!.render(
        <PartDrawMode
          active={active}
          keysEnabled={active}
          modeSwitch={null}
          onUnsaved={onUnsaved}
          client={client}
          store={store}
          request={request}
          onNew={onNew}
          onSaved={onSaved}
          onUseInBuild={onUseInBuild}
        />,
      ),
    );
  await render();
  return {
    store,
    onUnsaved,
    onSaved,
    onUseInBuild,
    onNew,
    open: (next: DrawRequest) => {
      request = next;
      return render();
    },
    show: (shown: boolean) => {
      active = shown;
      return render();
    },
  };
}

const canvas = () => container.querySelector<HTMLCanvasElement>("canvas.draw-grid")!;
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const select = (label: string) =>
  [...container.querySelectorAll("label")]
    .find((l) => l.textContent?.startsWith(label))!
    .querySelector("select")!;

const pointer = (target: Element, type: string, x: number, y: number) =>
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1 }),
  );

/** Paints a filled box of cells with the pen, one stroke a row. */
async function paintBox(x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y <= y1; y++) {
    await act(async () => {
      pointer(canvas(), "pointerdown", x0 * 10 + 5, y * 10 + 5);
      pointer(canvas(), "pointermove", x1 * 10 + 5, y * 10 + 5);
      pointer(canvas(), "pointerup", x1 * 10 + 5, y * 10 + 5);
    });
  }
}

describe("Draw mode", () => {
  it("starts a drawing of the first part type from its starter, with nothing to lose", async () => {
    const draw = await setup();
    expect(select("Part type").value).toBe("hollow:torso");
    expect(select("Base part").selectedOptions[0]?.textContent).toBeTruthy();
    expect(button("Save").disabled).toBe(true);
    expect(container.textContent).toContain("Draw your part first.");
    expect(draw.onUnsaved).toHaveBeenLastCalledWith(false);
    expect(view.created).toBe(1);
  });

  it("makes a part of what is drawn, shows it in 3D with its points, and has it to lose", async () => {
    const draw = await setup();
    await paintBox(8, 8, 22, 18);
    expect(draw.onUnsaved).toHaveBeenLastCalledWith(true);
    const part = view.assembly?.parts.drawn;
    expect(part?.type).toBe("hollow:torso");
    expect(part?.size.x).toBe(15);
    expect(part?.size.y).toBe(11);
    expect(container.querySelector(".point.attach")).not.toBeNull();
    expect(container.querySelectorAll(".point.socket").length).toBeGreaterThan(0);
  });

  it("undoes a stroke at a time", async () => {
    await setup();
    await paintBox(8, 8, 10, 9);
    expect(view.assembly?.parts.drawn?.size.y).toBe(2);
    const undo = container.querySelector<HTMLButtonElement>("button[title='Undo (Ctrl+Z)']")!;
    await act(async () => undo.click());
    expect(view.assembly?.parts.drawn?.size.y).toBe(1);
    await act(async () =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "y", ctrlKey: true })),
    );
    expect(view.assembly?.parts.drawn?.size.y).toBe(2);
  });

  it("saves version 1, then the next version in place after an edit", async () => {
    const draw = await setup();
    await paintBox(8, 8, 22, 18);
    await act(async () => button("Save").click());
    const [first] = await draw.store.list();
    const parsed = parsePlayerPartEntry(first?.entry);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ name: "My torso", version: 1 });
    expect(parsed.value.id).toBe(`user-part:${first?.id}`);
    expect(draw.onSaved).toHaveBeenCalledWith(parsed.value);
    expect(draw.onUnsaved).toHaveBeenLastCalledWith(false);
    expect(button("Saved").disabled).toBe(true);

    await paintBox(8, 19, 12, 20);
    expect(draw.onUnsaved).toHaveBeenLastCalledWith(true);
    await act(async () => button("Save").click());
    const stored = await draw.store.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.entry).toMatchObject({ id: parsed.value.id, version: 2 });
  });

  it("saves before handing the part to Build", async () => {
    const draw = await setup();
    await paintBox(8, 8, 22, 18);
    await act(async () => button("Use in Build →").click());
    expect(draw.onUseInBuild).toHaveBeenCalledTimes(1);
    const entry = draw.onUseInBuild.mock.calls[0]![0];
    expect(entry.version).toBe(1);
    expect(await draw.store.list()).toHaveLength(1);
    // Saved and unchanged: handed on again without a new version.
    await act(async () => button("Use in Build →").click());
    expect(draw.onUseInBuild.mock.calls[1]![0]).toBe(entry);
  });

  it("opens a new drawing of a type in its recipe's view and rule", async () => {
    const draw = await setup();
    await draw.open({ key: 1, partType: "hollow:leg" });
    expect(select("Part type").value).toBe("hollow:leg");
    expect(select("Drawn from").value).toBe("side");
    expect(container.querySelector("[role='radio'][aria-checked='true']")?.textContent).toBe(
      "Tube",
    );
    await draw.open({ key: 2, partType: "hollow:eye" });
    expect(select("Drawn from").value).toBe("front");
  });

  it("opens a saved part as its drawing, with nothing to lose until it changes", async () => {
    const draw = await setup();
    await paintBox(8, 8, 22, 18);
    await act(async () => button("Save").click());
    const saved = parsePlayerPartEntry((await draw.store.list())[0]?.entry);
    if (!saved.ok) throw new Error("Not saved");
    await draw.open({ key: 1, partType: "hollow:leg" });
    expect(draw.onUnsaved).toHaveBeenLastCalledWith(false);

    await draw.open({ key: 2, entry: saved.value });
    expect(select("Part type").value).toBe("hollow:torso");
    // Drawn against its original base part, its type kept.
    expect(saved.value.drawing.baseId).toBe("hollow:four-legged-torso");
    expect(select("Base part").value).toBe(saved.value.drawing.baseId);
    expect(select("Part type").disabled).toBe(true);
    expect(view.assembly?.parts.drawn).toEqual(saved.value.part);
    expect(draw.onUnsaved).toHaveBeenLastCalledWith(false);
    expect(button("Saved").disabled).toBe(true);
    await paintBox(2, 2, 3, 3);
    expect(draw.onUnsaved).toHaveBeenLastCalledWith(true);
    await act(async () => button("Save").click());
    expect((await draw.store.list())[0]?.entry).toMatchObject({ version: 2 });
  });

  it("makes its 3D view only while shown", async () => {
    const draw = await setup();
    expect(view.created).toBe(1);
    await draw.show(false);
    expect(view.disposed).toBe(1);
    await draw.show(true);
    expect(view.created).toBe(2);
  });
});

/** A store whose saves wait until the test lets them through. */
function slowStore() {
  const store = createMemoryPartsStore();
  const waiting: (() => void)[] = [];
  return {
    store: {
      ...store,
      save: (id: string, entry: unknown) =>
        new Promise<void>((resolve) =>
          waiting.push(() => void store.save(id, entry).then(resolve)),
        ),
    } satisfies PartsStore,
    release: () => act(async () => waiting.splice(0).forEach((go) => go())),
    list: () => store.list(),
  };
}

const marker = (kind: "attach" | "socket", index = 0) =>
  container.querySelectorAll<HTMLElement>(`.point.${kind}`)[index]!;
const key = (keyName: string, options: KeyboardEventInit = {}) =>
  act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, ...options })));
const pressedTool = () =>
  container
    .querySelector("[aria-label='Tools'] button[aria-pressed='true']")
    ?.getAttribute("title");

describe("Draw mode's points and keys", () => {
  it("drags a point, refits it on drop, and undoes the drag", async () => {
    await setup();
    await paintBox(8, 8, 22, 18);
    const before = marker("attach").style.left;
    await act(async () => pointer(marker("attach"), "pointerdown", 150, 185));
    await act(async () => pointer(marker("attach"), "pointermove", 200, 185));
    // Shown where the pointer is while dragged.
    expect(marker("attach").style.left).toBe("62.5%");
    await act(async () => pointer(marker("attach"), "pointerup", 200, 185));
    expect(marker("attach").style.left).toBe("62.5%");
    expect(view.assembly?.parts.drawn?.attach.x).toBe(12);
    await key("z", { ctrlKey: true });
    expect(marker("attach").style.left).toBe(before);
    await key("y", { ctrlKey: true });
    expect(marker("attach").style.left).toBe("62.5%");
  });

  it("puts a dragged point back on Escape or a lost pointer", async () => {
    await setup();
    await paintBox(8, 8, 22, 18);
    const before = marker("attach").style.left;
    await act(async () => pointer(marker("attach"), "pointerdown", 150, 185));
    await act(async () => pointer(marker("attach"), "pointermove", 200, 185));
    await key("Escape");
    expect(marker("attach").style.left).toBe(before);
    await act(async () => pointer(marker("attach"), "pointerdown", 150, 185));
    await act(async () => pointer(marker("attach"), "pointermove", 200, 185));
    expect(marker("attach").style.left).toBe("62.5%");
    await act(async () =>
      marker("attach").dispatchEvent(new Event("lostpointercapture", { bubbles: true })),
    );
    expect(marker("attach").style.left).toBe(before);
  });

  it("undoes a change of view with the points it reset", async () => {
    await setup();
    await paintBox(8, 8, 22, 18);
    await act(async () => pointer(marker("attach"), "pointerdown", 150, 185));
    await act(async () => pointer(marker("attach"), "pointermove", 200, 185));
    await act(async () => pointer(marker("attach"), "pointerup", 200, 185));
    const moved = marker("attach").style.left;
    expect(moved).toBe("62.5%");
    const viewSelect = select("Drawn from");
    await act(async () => {
      viewSelect.value = "front";
      viewSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select("Drawn from").value).toBe("front");
    await key("z", { ctrlKey: true });
    expect(select("Drawn from").value).toBe("side");
    expect(marker("attach").style.left).toBe(moved);
  });

  it("picks the tools with P, E and F, but not while typing", async () => {
    await setup();
    expect(pressedTool()).toBe("Pen (P)");
    await key("e");
    expect(pressedTool()).toBe("Eraser (E)");
    await key("f");
    expect(pressedTool()).toBe("Fill (F)");
    await key("p");
    expect(pressedTool()).toBe("Pen (P)");
    const nameField = container.querySelector<HTMLInputElement>("input[type='text']")!;
    await act(async () =>
      nameField.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })),
    );
    expect(pressedTool()).toBe("Pen (P)");
  });

  it("holds undo off during a stroke, and Escape drops the stroke", async () => {
    await setup();
    await paintBox(8, 8, 10, 9);
    await act(async () => {
      pointer(canvas(), "pointerdown", 85, 205);
      pointer(canvas(), "pointermove", 125, 205);
    });
    await key("z", { ctrlKey: true });
    // The two rows are still there: undo waited.
    expect(view.assembly?.parts.drawn?.size.y).toBe(2);
    await key("Escape");
    await act(async () => pointer(canvas(), "pointerup", 125, 205));
    expect(view.assembly?.parts.drawn?.size.y).toBe(2);
  });

  it("moves the depth rule with the arrow keys", async () => {
    await setup();
    const checked = () =>
      container.querySelector<HTMLElement>("[aria-label='Depth rule'] [aria-checked='true']")!;
    expect(checked().textContent).toBe("Puffy");
    await act(async () =>
      checked().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })),
    );
    expect(checked().textContent).toBe("Tube");
    expect(checked().tabIndex).toBe(0);
  });

  it("keeps a shallow socket flagged when the part is opened again", async () => {
    const draw = await setup();
    await paintBox(8, 8, 22, 18);
    await act(async () => button("Flat").click());
    expect(container.querySelectorAll(".point.socket.shallow").length).toBeGreaterThan(0);
    await act(async () => button("Save").click());
    const saved = parsePlayerPartEntry((await draw.store.list())[0]?.entry);
    if (!saved.ok) throw new Error("Not saved");
    await draw.open({ key: 1, partType: "hollow:leg" });
    await draw.open({ key: 2, entry: saved.value });
    expect(container.querySelectorAll(".point.socket.shallow").length).toBeGreaterThan(0);
  });

  it("keeps a saved part's type while it is edited", async () => {
    const draw = await setup();
    await paintBox(8, 8, 22, 18);
    await act(async () => button("Save").click());
    const saved = parsePlayerPartEntry((await draw.store.list())[0]?.entry);
    if (!saved.ok) throw new Error("Not saved");
    await draw.open({ key: 1, entry: saved.value });
    const typeSelect = select("Part type");
    expect(typeSelect.disabled).toBe(true);
    await act(async () => {
      typeSelect.value = "hollow:leg";
      typeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select("Part type").value).toBe("hollow:torso");
    expect(view.assembly?.parts.drawn?.type).toBe("hollow:torso");
    // A new drawing may pick its type again.
    await draw.open({ key: 2, partType: "hollow:torso" });
    expect(select("Part type").disabled).toBe(false);
  });

  it("draws a saved part against another base when its own is gone, and says so", async () => {
    const draw = await setup();
    await paintBox(8, 8, 22, 18);
    await act(async () => button("Save").click());
    const saved = parsePlayerPartEntry((await draw.store.list())[0]?.entry);
    if (!saved.ok) throw new Error("Not saved");
    const orphan = { ...saved.value, drawing: { ...saved.value.drawing, baseId: "hollow:gone" } };
    await draw.open({ key: 1, entry: orphan });
    expect(select("Base part").value).toBe("hollow:four-legged-torso");
    expect(container.textContent).toContain(BASE_GONE);
    // A note in the panel, not a passing notice: it stays.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 3100)));
    expect(container.textContent).toContain(BASE_GONE);
    // Saving would record the stand-in base, so there is something to save.
    expect(draw.onUnsaved).toHaveBeenLastCalledWith(true);
    // Another drawing has no such note.
    await draw.open({ key: 2, entry: saved.value });
    expect(container.textContent).not.toContain(BASE_GONE);
  }, 10_000);

  it("makes no undo step for a point dropped where it was", async () => {
    await setup();
    await paintBox(8, 8, 22, 18);
    const undoButton = container.querySelector<HTMLButtonElement>("button[title='Undo (Ctrl+Z)']")!;
    await act(async () => button("Put the points back where the base part has them").click());
    await act(async () => pointer(marker("attach"), "pointerdown", 200, 185));
    await act(async () => pointer(marker("attach"), "pointermove", 200, 185));
    await act(async () => pointer(marker("attach"), "pointerup", 200, 185));
    // Placed once: one step.
    await key("z", { ctrlKey: true });
    await key("y", { ctrlKey: true });
    const left = marker("attach").style.left;
    await act(async () => pointer(marker("attach"), "pointerdown", 200, 185));
    await act(async () => pointer(marker("attach"), "pointerup", 200, 185));
    expect(marker("attach").style.left).toBe(left);
    // Undo goes back past the first drop, not to the same place again.
    await key("z", { ctrlKey: true });
    expect(marker("attach").style.left).not.toBe(left);
    expect(undoButton.disabled).toBe(false);
  });

  it("warns when the part is much bigger than its base part", async () => {
    await setup();
    await paintBox(2, 2, 29, 29);
    expect(container.textContent).toContain("Much bigger than its base part");
    expect(container.querySelector(".size-readout")?.textContent).toMatch(
      /About [\d.]+× its base part/,
    );
  });

  it("leaves a new drawing be when an earlier save finishes after it began", async () => {
    const slow = slowStore();
    const draw = await setup(slow.store);
    await paintBox(8, 8, 22, 18);
    await act(async () => void button("Use in Build →").click());
    expect(button("Saving…")).toBeDefined();
    await draw.open({ key: 1, partType: "hollow:leg" });
    await slow.release();
    // The first part is saved, but the new drawing stays new and Build gets nothing.
    expect(await slow.list()).toHaveLength(1);
    expect(draw.onSaved).toHaveBeenCalledTimes(1);
    expect(draw.onUseInBuild).not.toHaveBeenCalled();
    expect(select("Part type").value).toBe("hollow:leg");
    expect(button("Save").disabled).toBe(true);
    await paintBox(8, 8, 10, 20);
    await act(async () => void button("Save").click());
    await slow.release();
    const stored = await slow.list();
    expect(stored).toHaveLength(2);
    expect(stored.map(({ entry }) => (entry as PlayerPartEntry).version)).toEqual([1, 1]);
  });
});

/** What the Studio stand-in last rendered with. */
const studio: { mode: StudioMode; open?: OpenDraw } = { mode: "build" };

/** Draw mode with the Studio's opening and its "Discard your part?" question, as in Studio.tsx. */
function DrawStudio() {
  const unsaved = useRef(false);
  const [mode, setMode] = useState<StudioMode>("build");
  const openDraw = useOpenDraw({ unsaved: () => unsaved.current, onMode: setMode });
  useEffect(() => {
    studio.mode = mode;
    studio.open = openDraw.open;
  });
  return (
    <>
      <PartDrawMode
        active={true}
        keysEnabled={!openDraw.confirming}
        modeSwitch={null}
        onUnsaved={(value) => {
          unsaved.current = value;
        }}
        client={CLIENT}
        store={STORE}
        request={openDraw.request}
        onNew={(partType) => openDraw.open({ partType })}
        onSaved={() => {}}
        onUseInBuild={() => {}}
      />
      {openDraw.confirming && (
        <CloseDialog
          title="Discard your part?"
          drafts={false}
          onDiscard={openDraw.confirm}
          onCancel={openDraw.cancel}
        />
      )}
    </>
  );
}
const CLIENT = { parts: () => Promise.resolve(builtInParts()) };
const STORE = createMemoryPartsStore();

describe("opening Draw mode", () => {
  const dialog = () => container.querySelector("dialog");
  const mount = async () => {
    root = createRoot(container);
    await act(async () => root!.render(<DrawStudio />));
  };
  const open = (request: Parameters<OpenDraw>[0]) => act(async () => studio.open!(request));

  it("opens straight away with nothing to lose, and switches to Draw", async () => {
    await mount();
    await open({ partType: "hollow:leg" });
    expect(dialog()).toBeNull();
    expect(studio.mode).toBe("draw");
    expect(select("Part type").value).toBe("hollow:leg");
  });

  it("asks before openDraw drops an unsaved drawing: Cancel keeps it, Discard opens", async () => {
    await mount();
    await paintBox(8, 8, 22, 18);
    await open({ partType: "hollow:leg" });
    expect(dialog()?.textContent).toContain("Discard your part?");
    expect(dialog()?.textContent).not.toContain("Save draft");
    await act(async () => button("Cancel").click());
    expect(dialog()).toBeNull();
    expect(select("Part type").value).toBe("hollow:torso");
    await open({ partType: "hollow:leg" });
    await act(async () => button("Discard").click());
    expect(dialog()).toBeNull();
    expect(select("Part type").value).toBe("hollow:leg");
    expect(button("Save").disabled).toBe(true);
  });

  it("asks before New part drops an unsaved drawing", async () => {
    await mount();
    await paintBox(8, 8, 22, 18);
    await act(async () => button("New part").click());
    expect(dialog()?.textContent).toContain("Discard your part?");
    await act(async () => button("Discard").click());
    expect(dialog()).toBeNull();
    expect(select("Part type").value).toBe("hollow:torso");
    expect(container.textContent).toContain("Draw your part first.");
  });
});

describe("the Studio's modes", () => {
  it("switches between Build and Draw", async () => {
    const onMode = vi.fn();
    root = createRoot(container);
    await act(async () => root!.render(<ModeSwitch mode="build" onMode={onMode} />));
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Build", "Draw"]);
    expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => buttons[1]!.click());
    expect(onMode).toHaveBeenCalledWith("draw");
  });

  it("says what closing would lose", () => {
    expect(closeMessage({ build: true, draw: false })).toContain("creature hasn't been released");
    expect(closeMessage({ build: false, draw: true })).toBe(
      "Your part hasn't been saved. Closing now loses it.",
    );
    expect(closeMessage({ build: true, draw: true })).toContain("Closing now loses them.");
  });
});
