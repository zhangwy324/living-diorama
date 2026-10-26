import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** What the app can ask of the desktop shell it runs in, and hear from it (ADR 0008 §1). */
export interface DesktopShell {
  /** Sets the compact strip height in logical pixels. The shell clamps it to its limits. */
  setStripHeight(height: number): Promise<void>;
  /**
   * Calls `listener` whenever the shell pauses or resumes the simulation (from the tray). The shell
   * starts unpaused. Returns a function that stops listening.
   */
  onPausedChanged(listener: (paused: boolean) => void): () => void;
}

/** A shell that does nothing, for tests and for the frontend running in a plain browser. */
export const noopShell: DesktopShell = {
  setStripHeight: () => Promise.resolve(),
  onPausedChanged: () => () => {},
};

const tauriShell: DesktopShell = {
  setStripHeight: (height) => invoke("set_strip_height", { height }),
  onPausedChanged: (listener) => {
    const unlisten = listen<boolean>("paused-changed", (event) => listener(event.payload));
    return () => void unlisten.then((stop) => stop());
  },
};

/** The shell for the current environment: Tauri's when running in the app, else the no-op one. */
export function connectDesktopShell(): DesktopShell {
  return isTauri() ? tauriShell : noopShell;
}
