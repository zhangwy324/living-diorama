import { invoke, isTauri } from "@tauri-apps/api/core";

/** A player part as stored: its file's ID and contents, not yet checked (ADR 0025 §6). */
export interface StoredPlayerPart {
  /** A lowercase UUID, the `<uuid>` of the part's `user-part:<uuid>` ID. */
  id: string;
  entry: unknown;
}

/**
 * The player's parts (ADR 0025 §6): one file per part, holding the voxel part and the drawing it
 * was made from. The store only keeps files: it doesn't read the entries, so the frontend checks
 * them against `content-schema`. IDs are lowercase UUIDs; any other ID is refused. Every method
 * rejects with a readable message when the files can't be read or written.
 */
export interface PartsStore {
  /** Every readable part, sorted by ID. Files that aren't readable parts are skipped. */
  list(): Promise<StoredPlayerPart[]>;
  /** Saves a part, adding it or replacing the part with its ID (an edit saves in place). */
  save(id: string, entry: unknown): Promise<void>;
  /** Removes a part. Removing a missing part does nothing. */
  delete(id: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parts kept in memory, for tests and for the frontend in a plain browser. It keeps what it is
 * given and refuses the IDs the app's store refuses, and forgets the parts when the page closes.
 */
export function createMemoryPartsStore(): PartsStore {
  const parts = new Map<string, unknown>();
  const check = (id: string) => {
    if (!UUID.test(id)) throw new Error(`${JSON.stringify(id)} is not a part ID`);
  };
  return {
    list: () =>
      Promise.resolve(
        [...parts]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, entry]) => ({
            id,
            entry: structuredClone(entry),
          })),
      ),
    save: (id, entry) =>
      Promise.resolve().then(() => {
        check(id);
        parts.set(id, structuredClone(entry));
      }),
    delete: (id) =>
      Promise.resolve().then(() => {
        check(id);
        parts.delete(id);
      }),
  };
}

const tauriPartsStore: PartsStore = {
  list: () => invoke("list_parts"),
  save: (id, entry) => invoke("save_part", { id, entry }),
  delete: (id) => invoke("delete_part", { id }),
};

/** The player's parts for the current environment: the app's files in Tauri, else in memory. */
export function connectPartsStore(): PartsStore {
  return isTauri() ? tauriPartsStore : createMemoryPartsStore();
}
