import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * What the app can ask of the desktop shell it runs in, and hear from it (ADR 0008 §1). The shell
 * owns the paused and expanded state, so the tray and the controls overlay agree: setting either
 * is answered by its change event, which is how the app learns the new state. The shell starts
 * unpaused and collapsed.
 */
export interface DesktopShell {
  /** Sets the compact strip height in logical pixels. The shell clamps it to its limits. */
  setStripHeight(height: number): Promise<void>;
  /** Pauses or resumes the simulation; `onPausedChanged` hears the result. */
  setPaused(paused: boolean): Promise<void>;
  /** Expands or collapses the window; `onExpandedChanged` hears the result. */
  setExpanded(expanded: boolean): Promise<void>;
  /** Hides the window. The simulation keeps running (ADR 0008 §12). */
  hide(): Promise<void>;
  /** Calls `listener` whenever the simulation is paused or resumed. Returns a function that stops listening. */
  onPausedChanged(listener: (paused: boolean) => void): () => void;
  /** Calls `listener` whenever the window is expanded or collapsed. Returns a function that stops listening. */
  onExpandedChanged(listener: (expanded: boolean) => void): () => void;
  /**
   * Calls `listener` when the user quits. The shell exits once the promise it returns settles, or
   * after one second (ADR 0008 §14). Returns a function that stops listening.
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
  hide: () => Promise.resolve(),
  onPausedChanged: () => () => {},
  onExpandedChanged: () => () => {},
  onQuitRequested: () => () => {},
  recordEventCounts: () => Promise.resolve(),
};

/** Listens to a shell event; the returned function stops listening even before `listen` resolves. */
function subscribe<T>(event: string, listener: (payload: T) => void): () => void {
  const unlisten = listen<T>(event, (e) => listener(e.payload));
  return () => void unlisten.then((stop) => stop());
}

const tauriShell: DesktopShell = {
  setStripHeight: (height) => invoke("set_strip_height", { height }),
  setPaused: (paused) => invoke("set_paused", { paused }),
  setExpanded: (expanded) => invoke("set_expanded", { expanded }),
  hide: () => invoke("hide"),
  onPausedChanged: (listener) => subscribe("paused-changed", listener),
  onExpandedChanged: (listener) => subscribe("expanded-changed", listener),
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
