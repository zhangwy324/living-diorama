import { invoke, isTauri } from "@tauri-apps/api/core";

/** What the app can ask of the desktop shell it runs in (ADR 0008 §1). */
export interface DesktopShell {
  /** Sets the compact strip height in logical pixels. The shell clamps it to its limits. */
  setStripHeight(height: number): Promise<void>;
}

/** A shell that does nothing, for tests and for the frontend running in a plain browser. */
export const noopShell: DesktopShell = {
  setStripHeight: () => Promise.resolve(),
};

const tauriShell: DesktopShell = {
  setStripHeight: (height) => invoke("set_strip_height", { height }),
};

/** The shell for the current environment: Tauri's when running in the app, else the no-op one. */
export function connectDesktopShell(): DesktopShell {
  return isTauri() ? tauriShell : noopShell;
}
