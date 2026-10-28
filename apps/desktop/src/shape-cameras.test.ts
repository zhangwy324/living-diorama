import type { CameraState } from "@living-diorama/renderer";
import { expect, it } from "vitest";
import { ShapeCameras } from "./shape-cameras";

/** A view whose camera is wherever it was last put; undefined is the default view. */
function fakeView(start: CameraState | undefined) {
  const view = {
    camera: start,
    cameraState: () => view.camera ?? DEFAULT,
    setCameraState: (state: CameraState | undefined) => (view.camera = state),
  };
  return view;
}

const DEFAULT: CameraState = { position: [0, 10, 40], target: [0, 0, 0] };
const at = (x: number): CameraState => ({ position: [x, 5, 5], target: [x, 0, 0] });

it("gives the normal shape its own camera, starting at the default view", () => {
  const cameras = new ShapeCameras();
  const view = fakeView(at(1));
  cameras.switchTo(true, view);
  expect(view.camera).toBeUndefined();
  view.camera = at(2);
  cameras.switchTo(false, view);
  expect(view.camera).toEqual(at(1));
  cameras.switchTo(true, view);
  expect(view.camera).toEqual(at(2));
});

it("ignores a switch to the shape it has", () => {
  const cameras = new ShapeCameras();
  const view = fakeView(at(1));
  cameras.switchTo(false, view);
  expect(view.camera).toEqual(at(1));
});

it("follows the shape before the view exists", () => {
  const cameras = new ShapeCameras();
  cameras.switchTo(true, undefined);
  const view = fakeView(at(3));
  cameras.switchTo(false, view);
  // The view started in the normal shape; the strip's camera starts at the default view.
  expect(view.camera).toBeUndefined();
  cameras.switchTo(true, view);
  expect(view.camera).toEqual(at(3));
});
