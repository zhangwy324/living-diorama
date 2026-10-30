import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ControlsOverlay, type ControlsOverlayProps } from "./ControlsOverlay";

const labels = (
  state: Pick<ControlsOverlayProps, "paused" | "expanded" | "debug"> & {
    fullScreen?: boolean;
    editing?: boolean;
  },
) => {
  const html = renderToStaticMarkup(
    <ControlsOverlay
      fullScreen={false}
      editing={false}
      {...state}
      onTogglePaused={() => {}}
      onToggleExpanded={() => {}}
      onResetCamera={() => {}}
      onToggleDebug={() => {}}
      onToggleFullScreen={() => {}}
      onHide={() => {}}
      onOpenStudio={() => {}}
      onToggleEditing={() => {}}
    />,
  );
  return [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
};

it("offers the Studio, pause, expand, reset camera, debug overlays and hide in the strip", () => {
  // No prop editing in the strip: only the normal window has it.
  expect(labels({ paused: false, expanded: false, debug: false })).toEqual([
    "Creation Studio",
    "Pause",
    "Expand",
    "Reset camera",
    "Show debug overlays",
    "Hide",
  ]);
});

it("offers full screen instead of hide in the normal window", () => {
  expect(labels({ paused: false, expanded: true, debug: false })).toEqual([
    "Creation Studio",
    "Edit props",
    "Pause",
    "Collapse",
    "Reset camera",
    "Show debug overlays",
    "Full screen",
  ]);
});

it("offers the opposite of the current state", () => {
  expect(labels({ paused: true, expanded: true, debug: true, fullScreen: true })).toEqual([
    "Creation Studio",
    "Edit props",
    "Resume",
    "Collapse",
    "Reset camera",
    "Hide debug overlays",
    "Leave full screen",
  ]);
});

it("offers to stop editing while Edit mode is on", () => {
  expect(labels({ paused: false, expanded: true, debug: false, editing: true })).toContain(
    "Stop editing props",
  );
});
