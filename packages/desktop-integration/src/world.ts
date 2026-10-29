import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * The saved world's file. The store only keeps the text: it doesn't read the save, so the
 * simulation checks it before restoring. Every method rejects with a readable message when the
 * file can't be read or written.
 */
export interface WorldStore {
  /**
   * The saved world's JSON text, or `null` when nothing is saved. The app's store falls back to
   * the save before the last one when the last is missing or unreadable.
   */
  load(): Promise<string | null>;
  /** Replaces the saved world, keeping the previous save as a backup. */
  save(json: string): Promise<void>;
}

/**
 * A saved world kept in memory, for tests and for the frontend in a plain browser. It forgets the
 * world when the page closes.
 */
export function createMemoryWorldStore(json: string | null = null): WorldStore {
  let saved = json;
  return {
    load: () => Promise.resolve(saved),
    save: (next) =>
      Promise.resolve().then(() => {
        saved = next;
      }),
  };
}

const tauriWorldStore: WorldStore = {
  load: () => invoke<string | null>("load_world"),
  save: (json) => invoke("save_world", { json }),
};

/** The saved world for the current environment: the app's file in Tauri, else one in memory. */
export function connectWorldStore(): WorldStore {
  return isTauri() ? tauriWorldStore : createMemoryWorldStore();
}
