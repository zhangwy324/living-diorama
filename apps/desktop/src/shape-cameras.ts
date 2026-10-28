import type { CameraState, DioramaView } from "@living-diorama/renderer";

type Shape = "strip" | "normal";

/**
 * One camera per window shape (ADR 0016 §6): each starts at the default view and keeps its place
 * while the app runs, across switches. Not saved across launches.
 */
export class ShapeCameras {
  private shape: Shape = "strip";
  private readonly saved = new Map<Shape, CameraState>();

  /** Keeps the camera of the shape being left and brings back the other one's. */
  switchTo(
    expanded: boolean,
    view: Pick<DioramaView, "cameraState" | "setCameraState"> | undefined,
  ) {
    const next: Shape = expanded ? "normal" : "strip";
    if (next === this.shape) return;
    if (view) {
      this.saved.set(this.shape, view.cameraState());
      view.setCameraState(this.saved.get(next));
    }
    this.shape = next;
  }
}
