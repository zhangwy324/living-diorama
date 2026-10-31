// @vitest-environment jsdom
import {
  parsePlayerPartEntry,
  type PlayerPartEntry,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import { createMemoryPartsStore, type PartsStore } from "@living-diorama/desktop-integration";
import type { AssemblyView } from "@living-diorama/renderer";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { builtInParts } from "./fixtures/built-in-parts";
import type { DrawRequest } from "./modes";
import { PartDrawMode } from "./PartDrawMode";
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
    expect(select("Base part").value).toBe(saved.value.id);
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
