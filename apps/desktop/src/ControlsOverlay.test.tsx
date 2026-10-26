import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ControlsOverlay, type ControlsOverlayProps } from "./ControlsOverlay";

const labels = (state: Pick<ControlsOverlayProps, "paused" | "expanded" | "debug">) => {
  const html = renderToStaticMarkup(
    <ControlsOverlay
      {...state}
      onTogglePaused={() => {}}
      onToggleExpanded={() => {}}
      onResetCamera={() => {}}
      onToggleDebug={() => {}}
      onHide={() => {}}
    />,
  );
  return [...html.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
};

it("offers pause, expand, reset camera, debug overlays and hide", () => {
  expect(labels({ paused: false, expanded: false, debug: false })).toEqual([
    "Pause",
    "Expand",
    "Reset camera",
    "Show debug overlays",
    "Hide",
  ]);
});

it("offers the opposite of the current state", () => {
  expect(labels({ paused: true, expanded: true, debug: true })).toEqual([
    "Resume",
    "Collapse",
    "Reset camera",
    "Hide debug overlays",
    "Hide",
  ]);
});
