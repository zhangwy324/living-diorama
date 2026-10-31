import { useRef, useState } from "react";
import type { DrawRequest, OpenDraw, StudioMode } from "./modes";

// Opening Draw mode on a new part or a saved one (ADR 0025 §9), from the tray's "Draw your own"
// tiles, My parts' Edit or Draw mode's own New part, asking first when a drawing would be lost.

export interface OpenDrawOptions {
  /** Whether Draw mode holds a drawing that isn't saved, so opening asks first. */
  unsaved(): boolean;
  onMode(mode: StudioMode): void;
}

/**
 * Draw mode's requests for the Studio. `open` opens Draw mode on a request, or, when the drawing
 * there isn't saved, first sets `confirming` to it for the Studio to ask whether to discard the
 * drawing: `confirm` then opens it and `cancel` keeps the drawing. `request` is the latest for
 * `PartDrawMode`, each with a new key.
 */
export function useOpenDraw({ unsaved, onMode }: OpenDrawOptions) {
  const [request, setRequest] = useState<DrawRequest>();
  const [confirming, setConfirming] = useState<Omit<DrawRequest, "key">>();
  const key = useRef(0);
  const start = (next: Omit<DrawRequest, "key">) => {
    setRequest({ ...next, key: ++key.current });
    onMode("draw");
  };
  const open: OpenDraw = (next) => {
    if (unsaved()) setConfirming(next);
    else start(next);
  };
  return {
    request,
    confirming,
    open,
    confirm() {
      if (!confirming) return;
      setConfirming(undefined);
      start(confirming);
    },
    cancel: () => setConfirming(undefined),
  };
}
