import type { PropEditor } from "./prop-editor";

/**
 * Routes the view's pointer and wheel to the prop editor before the camera sees them. The
 * listeners are on `element`, the view's container, in the capture phase, so they run before the
 * camera's on its canvas, and an event the editor takes stops there: a press on the selected prop
 * drags it instead of orbiting, and the wheel scales it instead of zooming. Everything else
 * reaches the camera as before. Returns a function that removes the listeners.
 */
export function attachEditorInput(
  element: HTMLElement,
  editor: Pick<PropEditor, "pointerDown" | "pointerMove" | "pointerUp" | "pointerCancel" | "wheel">,
): () => void {
  const take = (event: Event) => {
    event.stopPropagation();
    event.preventDefault();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (!editor.pointerDown(event, event.button)) return;
    take(event);
    // The drag goes on when the pointer leaves the view.
    element.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (editor.pointerMove(event)) take(event);
  };
  const onPointerUp = (event: PointerEvent) => {
    if (editor.pointerUp(event)) take(event);
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  };
  const onPointerCancel = () => editor.pointerCancel();
  const onWheel = (event: WheelEvent) => {
    // A scroll in lines or pages (rare on Windows) counts as one notch.
    const deltaY =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : Math.sign(event.deltaY) * 100;
    if (editor.wheel(deltaY)) take(event);
  };
  const options = { capture: true };
  element.addEventListener("pointerdown", onPointerDown, options);
  element.addEventListener("pointermove", onPointerMove, options);
  element.addEventListener("pointerup", onPointerUp, options);
  element.addEventListener("pointercancel", onPointerCancel, options);
  element.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return () => {
    element.removeEventListener("pointerdown", onPointerDown, options);
    element.removeEventListener("pointermove", onPointerMove, options);
    element.removeEventListener("pointerup", onPointerUp, options);
    element.removeEventListener("pointercancel", onPointerCancel, options);
    element.removeEventListener("wheel", onWheel, options);
  };
}
