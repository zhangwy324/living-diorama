import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** What the Creation Studio's page can do with its own window (ADR 0015 §10). */
export interface StudioWindow {
  /**
   * Asks `shouldClose` whenever the user closes the window; returning false keeps it open.
   * Returns a function that stops asking.
   */
  onCloseRequested(shouldClose: () => boolean): () => void;
  /** Closes the window without asking. */
  close(): Promise<void>;
}

/** A window that never closes on its own, for tests and the browser. */
export const noopStudioWindow: StudioWindow = {
  onCloseRequested: () => () => {},
  close: () => Promise.resolve(),
};

const tauriStudioWindow: StudioWindow = {
  onCloseRequested: (shouldClose) => {
    // Tauri destroys the window after the handler unless it prevents that.
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      if (!shouldClose()) event.preventDefault();
    });
    return () => void unlisten.then((stop) => stop());
  },
  close: () => getCurrentWindow().destroy(),
};

export function connectStudioWindow(): StudioWindow {
  return isTauri() ? tauriStudioWindow : noopStudioWindow;
}
