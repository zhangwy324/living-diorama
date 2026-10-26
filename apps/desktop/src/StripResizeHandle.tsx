import type { DesktopShell } from "@living-diorama/desktop-integration";
import { useRef, type PointerEvent } from "react";

/**
 * A thin grip along the strip's top edge (ADR 0008 §4). Dragging it asks the shell for a new
 * height; the shell clamps it and keeps the bottom edge in place, so the top edge follows the
 * pointer.
 */
export function StripResizeHandle({ shell }: { shell: DesktopShell }) {
  /** Where in the handle the pointer grabbed it, so the edge doesn't jump to the pointer. */
  const grab = useRef<number>(undefined);
  const frame = useRef(0);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    grab.current = event.clientY;
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (grab.current === undefined) return;
    // The window's top edge moves with every resize, so measure against where it is now.
    const height = window.innerHeight - (event.clientY - grab.current);
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => void shell.setStripHeight(height));
  };
  const onPointerEnd = () => (grab.current = undefined);

  return (
    <div
      className="strip-resize-handle"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    />
  );
}
