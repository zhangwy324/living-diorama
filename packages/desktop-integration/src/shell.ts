import { invoke, isTauri } from "@tauri-apps/api/core";
import { STRIP_WINDOW, subscribeAs } from "./events";

/**
 * What the app can ask of the desktop shell it runs in, and hear from it (ADR 0008 §1). The shell
 * owns the paused, expanded and full-screen state, so the tray and the controls overlay agree:
 * setting one is answered by its change event, which is how the app learns the new state. The
 * shell starts unpaused, collapsed and not full screen.
 */
export interface DesktopShell {
  /** Sets the compact strip height in logical pixels. The shell clamps it to its limits. */
  setStripHeight(height: number): Promise<void>;
  /** Pauses or resumes the simulation; `onPausedChanged` hears the result. */
  setPaused(paused: boolean): Promise<void>;
  /**
   * Turns the strip into the normal window or back (ADR 0016 §1); `onExpandedChanged` hears the
   * result.
   */
  setExpanded(expanded: boolean): Promise<void>;
  /**
   * Enters or leaves full screen; only the normal window has it (ADR 0016 §2).
   * `onFullScreenChanged` hears the result.
   */
  setFullScreen(fullScreen: boolean): Promise<void>;
  /** Hides the window. The simulation keeps running (ADR 0008 §12). */
  hide(): Promise<void>;
  /** Opens the Creation Studio's window, or shows and focuses it if it is open (ADR 0015 §1). */
  openStudio(): Promise<void>;
  /** Calls `listener` whenever the simulation is paused or resumed. Returns a function that stops listening. */
  onPausedChanged(listener: (paused: boolean) => void): () => void;
  /** Calls `listener` whenever the window is expanded or collapsed. Returns a function that stops listening. */
  onExpandedChanged(listener: (expanded: boolean) => void): () => void;
  /** Calls `listener` whenever the window enters or leaves full screen. Returns a function that stops listening. */
  onFullScreenChanged(listener: (fullScreen: boolean) => void): () => void;
  /**
   * Calls `listener` when the user quits, and when Windows shuts down, restarts or signs out. The
   * shell exits once the promise it returns settles, or after three seconds (ADR 0008 §14, ADR 0019
   * §4). Returns a function that stops listening.
   */
  onQuitRequested(listener: () => Promise<void> | void): () => void;
  /** Writes the simulation event counts where the measuring script reads them (ADR 0009 §5). */
  recordEventCounts(counts: EventCounts): Promise<void>;
}

/** The events the soak test checks (ADR 0009 §6). */
export interface EventCounts {
  /** `creature_stuck` events. */
  stuck: number;
  /** Stuck events the creature recovered from by moving away again. */
  recovered: number;
  /** `path_failed` events. */
  pathFailed: number;
}

/** A shell that does nothing and never reports a change, for tests. */
export const noopShell: DesktopShell = {
  setStripHeight: () => Promise.resolve(),
  setPaused: () => Promise.resolve(),
  setExpanded: () => Promise.resolve(),
  setFullScreen: () => Promise.resolve(),
  hide: () => Promise.resolve(),
  openStudio: () => Promise.resolve(),
  onPausedChanged: () => () => {},
  onExpandedChanged: () => () => {},
  onFullScreenChanged: () => () => {},
  onQuitRequested: () => () => {},
  recordEventCounts: () => Promise.resolve(),
};

/** Listens to a shell event, which the shell sends to the strip only (ADR 0015 §6). */
const subscribe = <T>(event: string, listener: (payload: T) => void) =>
  subscribeAs(STRIP_WINDOW, event, listener);

const tauriShell: DesktopShell = {
  setStripHeight: (height) => invoke("set_strip_height", { height }),
  setPaused: (paused) => invoke("set_paused", { paused }),
  setExpanded: (expanded) => invoke("set_expanded", { expanded }),
  setFullScreen: (fullScreen) => invoke("set_full_screen", { fullScreen }),
  hide: () => invoke("hide"),
  openStudio: () => invoke("open_studio"),
  onPausedChanged: (listener) => subscribe("paused-changed", listener),
  onExpandedChanged: (listener) => subscribe("expanded-changed", listener),
  onFullScreenChanged: (listener) => subscribe("full-screen-changed", listener),
  onQuitRequested: (listener) =>
    subscribe("quit-requested", () => {
      void Promise.resolve()
        .then(listener)
        .catch((error: unknown) => console.error("Shutdown failed", error))
        .finally(() => void invoke("quit_ready"));
    }),
  recordEventCounts: (counts) => invoke("record_event_counts", { counts }),
};

/**
 * The shell for the current environment: Tauri's when running in the app, else the no-op one. The
 * frontend is not supported in a plain browser, but it still loads there, with shell controls
 * that do nothing.
 */
export function connectDesktopShell(): DesktopShell {
  return isTauri() ? tauriShell : noopShell;
}
