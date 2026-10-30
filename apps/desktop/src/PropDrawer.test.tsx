// @vitest-environment jsdom
import type { PropSummary } from "@living-diorama/simulation";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drawerTabs, PropThumbnails } from "./prop-drawer";
import { PropDrawer, type PropDrawerProps } from "./PropDrawer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const propTypes: Record<string, PropSummary> = {
  "test:pine": { name: "Pine", model: "test:pine.glb", blockRadius: 0.5, category: "test:trees" },
  "test:oak": { name: "Oak", model: "test:oak.glb", blockRadius: 0.5, category: "test:trees" },
  "test:rock": { name: "Rock", model: "test:rock.glb", blockRadius: 0.5, category: "test:rocks" },
  "test:stump": { name: "Stump", model: "test:stump.glb", blockRadius: 0.5 },
};
const tabs = drawerTabs(propTypes, [
  { id: "test:trees", name: "Trees" },
  { id: "test:rocks", name: "Rocks" },
]);

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

/** Renders the drawer with its tab kept as the app keeps it. */
function setup(overrides: Partial<PropDrawerProps> = {}) {
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  const draw = vi.fn<(model: string, size: number) => Promise<string>>((model) =>
    Promise.resolve(`data:image/png;${model}`),
  );
  const thumbnails = new PropThumbnails(draw, 112);
  const editor = {
    choosePlacing: vi.fn(),
    startPlacingDrag: vi.fn(),
    movePlacingDrag: vi.fn(),
    endPlacingDrag: vi.fn(),
    cancelPlacingDrag: vi.fn(),
  };
  const onClose = vi.fn();
  let tab: string | undefined;
  const render = (placing?: string) =>
    root?.render(
      <PropDrawer
        tabs={tabs}
        tab={tab}
        onTab={(next) => {
          tab = next;
          render(placing);
        }}
        propTypes={propTypes}
        placing={placing}
        thumbnails={thumbnails}
        editor={editor}
        overWorld={() => true}
        onClose={onClose}
        {...overrides}
      />,
    );
  act(() => render());
  const tabButtons = () => [...element.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const tiles = () => [...element.querySelectorAll<HTMLButtonElement>(".prop-tile")];
  return { element, draw, editor, onClose, render, tabButtons, tiles };
}

describe("PropDrawer", () => {
  it("has a tab per category, Other last, and a tile per type of the tab shown", () => {
    const { element, tabButtons, tiles } = setup();
    expect(element.querySelector("aside")?.getAttribute("aria-label")).toBe("Props");
    expect(element.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe(
      "Prop categories",
    );
    expect(tabButtons().map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([
      ["Trees", "true"],
      ["Rocks", "false"],
      ["Other", "false"],
    ]);
    const panel = element.querySelector('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabButtons()[0]?.id);
    expect(tiles().map((t) => t.getAttribute("aria-label"))).toEqual([
      "Place an oak",
      "Place a pine",
    ]);
  });

  it("asks for the thumbnails of the tab shown only, once each", async () => {
    const { draw, tabButtons, tiles } = setup();
    expect(draw.mock.calls.map(([model]) => model)).toEqual(["test:oak.glb", "test:pine.glb"]);
    await act(async () => {});
    expect(tiles()[0]?.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;test:oak.glb",
    );
    act(() => tabButtons()[2]?.click());
    expect(tiles().map((t) => t.textContent)).toEqual(["Stump"]);
    act(() => tabButtons()[0]?.click());
    expect(draw.mock.calls.map(([model]) => model)).toEqual([
      "test:oak.glb",
      "test:pine.glb",
      "test:stump.glb",
    ]);
    // Every thumbnail at the one size.
    expect(new Set(draw.mock.calls.map(([, size]) => size))).toEqual(new Set([112]));
  });

  it("moves between tabs with the arrow keys", () => {
    const { tabButtons } = setup();
    const key = (name: string) =>
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", { key: name, bubbles: true }),
        );
      });
    tabButtons()[0]?.focus();
    key("ArrowLeft");
    expect(document.activeElement?.textContent).toBe("Other");
    key("Home");
    key("ArrowRight");
    expect(tabButtons()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabButtons()[1]);
  });

  it("chooses a type on a click, and again stops", () => {
    const { editor, render, tiles, onClose, element } = setup();
    act(() => tiles()[1]?.click());
    expect(editor.choosePlacing).toHaveBeenLastCalledWith("test:pine");
    act(() => render("test:pine"));
    expect(tiles()[1]?.getAttribute("aria-pressed")).toBe("true");
    act(() => tiles()[1]?.click());
    expect(editor.choosePlacing).toHaveBeenLastCalledWith(undefined);
    act(() => element.querySelector<HTMLButtonElement>('[aria-label="Close the drawer"]')?.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("drags a tile into the world without choosing it on the click that ends the drag", () => {
    const { editor, tiles } = setup();
    const tile = tiles()[0]!;
    Object.assign(tile, { setPointerCapture: vi.fn() });
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, { clientX: x, clientY: 10, bubbles: true, button: 0 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      act(() => void tile.dispatchEvent(event));
    };
    pointer("pointerdown", 200);
    pointer("pointermove", 100);
    pointer("pointerup", 100);
    act(() => tile.click());
    expect(editor.startPlacingDrag).toHaveBeenCalledWith("test:oak");
    expect(editor.endPlacingDrag).toHaveBeenCalledWith(
      expect.objectContaining({ clientX: 100 }),
      true,
    );
    expect(editor.choosePlacing).not.toHaveBeenCalled();
  });
});
