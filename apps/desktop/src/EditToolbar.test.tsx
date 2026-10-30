import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { EditToolbar } from "./EditToolbar";
import type { EditorState } from "./prop-editor";

const state: EditorState = {
  active: true,
  selected: undefined,
  placing: undefined,
  placingDrag: false,
  drawerOpen: true,
  canUndo: false,
  canRedo: false,
  notice: undefined,
};

const render = (next: Partial<EditorState>) =>
  renderToStaticMarkup(
    <EditToolbar
      state={{ ...state, ...next }}
      propTypes={{ "test:oak": { name: "Oak", model: "test:oak.glb", blockRadius: 1 } }}
      onToggleDrawer={() => {}}
      onRotate={() => {}}
      onDelete={() => {}}
      onUndo={() => {}}
      onRedo={() => {}}
    />,
  );

it("has the drawer's toggle where the palette was, then turn, delete, undo and redo", () => {
  const html = render({});
  expect([...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual([
    "Edit props",
    "Hide the props drawer",
    "Turn left (R)",
    "Turn right (Shift+R)",
    "Delete (Del)",
    "Undo (Ctrl+Z)",
    "Redo (Ctrl+Y)",
  ]);
  expect(html).toContain('aria-pressed="true"');
  expect(render({ drawerOpen: false })).toContain('aria-label="Show the props drawer"');
});

it("says what a click or a release does", () => {
  expect(render({})).toContain("Click a prop to select it, or drag one in from the drawer");
  expect(render({ drawerOpen: false })).toContain("Click a prop to select it<");
  expect(render({ placing: "test:oak" })).toContain("Click the ground to place an oak");
  expect(render({ placing: "test:oak", placingDrag: true })).toContain(
    "Release over the ground to place an oak",
  );
});
