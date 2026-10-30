import type { PropSummary } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { aProp, drawerShown, drawerTabs, OTHER_TAB, PropThumbnails, TileDrag } from "./prop-drawer";
import type { EditorState } from "./prop-editor";

const type = (name: string, category?: string): PropSummary => ({
  name,
  model: `test:models/${name.toLowerCase()}.glb`,
  blockRadius: 0.5,
  ...(category === undefined ? {} : { category }),
});

const categories = [
  { id: "test:trees", name: "Trees" },
  { id: "test:rocks", name: "Rocks" },
  { id: "test:empty", name: "Empty" },
];

describe("drawerTabs", () => {
  it("lists the categories in the order given, each type by name, then Other", () => {
    const tabs = drawerTabs(
      {
        "test:pine": type("Pine", "test:trees"),
        "test:boulder": type("Boulder", "test:rocks"),
        "test:oak": type("Oak", "test:trees"),
        "test:stump": type("Stump"),
        "test:crystal": type("Crystal", "test:gems"),
      },
      categories,
    );
    // An unknown category counts as none; an empty tab isn't shown.
    expect(tabs).toEqual([
      { id: "test:trees", name: "Trees", types: ["test:oak", "test:pine"] },
      { id: "test:rocks", name: "Rocks", types: ["test:boulder"] },
      { id: OTHER_TAB, name: "Other", types: ["test:crystal", "test:stump"] },
    ]);
  });

  it("hides Other when every type has a known category", () => {
    const tabs = drawerTabs({ "test:pine": type("Pine", "test:trees") }, categories);
    expect(tabs.map((t) => t.id)).toEqual(["test:trees"]);
  });

  it("puts everything under Other when there are no categories", () => {
    const tabs = drawerTabs({ "test:pine": type("Pine", "test:trees") }, []);
    expect(tabs).toEqual([{ id: OTHER_TAB, name: "Other", types: ["test:pine"] }]);
    expect(drawerTabs({}, categories)).toEqual([]);
  });
});

describe("drawerShown", () => {
  const state = (active: boolean, drawerOpen: boolean) => ({ active, drawerOpen }) as EditorState;

  it("shows the drawer only in the normal window, in Edit mode, while it is open", () => {
    expect(drawerShown(true, state(true, true))).toBe(true);
    expect(drawerShown(false, state(true, true))).toBe(false);
    expect(drawerShown(true, state(false, true))).toBe(false);
    expect(drawerShown(true, state(true, false))).toBe(false);
    expect(drawerShown(true, undefined)).toBe(false);
  });
});

describe("PropThumbnails", () => {
  it("asks for each model once, at its one size, and tells when one arrives", async () => {
    const draw = vi.fn((model: string, size: number) => Promise.resolve(`data:${model}@${size}`));
    const thumbnails = new PropThumbnails(draw, 112);
    const listener = vi.fn();
    thumbnails.subscribe(listener);
    thumbnails.load(["a", "b"]);
    thumbnails.load(["b", "a", "c"]);
    expect(draw.mock.calls).toEqual([
      ["a", 112],
      ["b", 112],
      ["c", 112],
    ]);
    expect(thumbnails.get("a")).toBeUndefined();
    await Promise.resolve();
    expect(thumbnails.get("a")).toBe("data:a@112");
    expect(listener).toHaveBeenCalledTimes(3);
    expect(thumbnails.version).toBe(3);
  });

  it("leaves out a thumbnail the view can't draw, without asking again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const draw = vi.fn((model: string) =>
      model === "bad" ? Promise.reject(new Error("no")) : Promise.resolve(undefined),
    );
    const thumbnails = new PropThumbnails(draw, 56);
    thumbnails.load(["bad", "gone"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    thumbnails.load(["bad", "gone"]);
    expect(draw).toHaveBeenCalledTimes(2);
    expect(thumbnails.get("gone")).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("TileDrag", () => {
  const setup = (overWorld = (p: { clientX: number }) => p.clientX < 100) => {
    const editor = {
      startPlacingDrag: vi.fn(),
      movePlacingDrag: vi.fn(),
      endPlacingDrag: vi.fn(),
      cancelPlacingDrag: vi.fn(),
    };
    const drag = new TileDrag(editor, "test:pine", { clientX: 150, clientY: 50 }, overWorld);
    return { editor, drag };
  };
  const at = (clientX: number, clientY = 50) => ({ clientX, clientY });

  it("is a click, left to the tile, while it moves no further than a click may", () => {
    const { editor, drag } = setup();
    drag.move(at(152));
    drag.up(at(152));
    expect(drag.dragged).toBe(false);
    expect(Object.values(editor).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("drags the type into the world, saying where the pointer is", () => {
    const { editor, drag } = setup();
    drag.move(at(140));
    expect(editor.startPlacingDrag).toHaveBeenCalledWith("test:pine");
    expect(editor.movePlacingDrag).toHaveBeenLastCalledWith(at(140), false);
    drag.move(at(60));
    expect(editor.movePlacingDrag).toHaveBeenLastCalledWith(at(60), true);
    drag.up(at(60));
    expect(editor.endPlacingDrag).toHaveBeenCalledWith(at(60), true);
    expect(drag.dragged).toBe(true);
    // Losing the capture after the release changes nothing.
    drag.cancel();
    expect(editor.cancelPlacingDrag).not.toHaveBeenCalled();
  });

  it("is released over the drawer, or loses the pointer", () => {
    const over = setup();
    over.drag.move(at(120));
    over.drag.up(at(120));
    expect(over.editor.endPlacingDrag).toHaveBeenCalledWith(at(120), false);

    const lost = setup();
    lost.drag.move(at(60));
    lost.drag.cancel();
    lost.drag.move(at(70));
    lost.drag.up(at(70));
    expect(lost.editor.cancelPlacingDrag).toHaveBeenCalledOnce();
    expect(lost.editor.endPlacingDrag).not.toHaveBeenCalled();
    expect(lost.editor.movePlacingDrag).toHaveBeenCalledOnce();
  });
});

it("names a prop type with its article", () => {
  expect(aProp("Round tree")).toBe("a round tree");
  expect(aProp("Oak")).toBe("an oak");
});
