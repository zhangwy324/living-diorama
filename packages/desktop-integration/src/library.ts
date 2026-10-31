import { invoke, isTauri } from "@tauri-apps/api/core";

/** A library entry as stored: its folder's ID and `entry.json`, not yet checked (ADR 0014 §3). */
export interface StoredLibraryEntry {
  /** A lowercase UUID, the `<uuid>` of the species' `user:<uuid>` ID. */
  id: string;
  entry: unknown;
}

/**
 * The species library's files (ADR 0014): one entry per species, holding its voxel assembly
 * inline (ADR 0022 §17). The store only keeps files: it doesn't read the entries, so the frontend
 * checks them against `content-schema`. Every method rejects with a readable message when the
 * files can't be read or written.
 */
export interface LibraryStore {
  /** Every complete entry, sorted by ID. Folders that aren't readable entries are skipped. */
  list(): Promise<StoredLibraryEntry[]>;
  /** Saves a new entry. Rejects if the ID is taken. */
  save(id: string, entry: unknown): Promise<void>;
  /** Removes an entry. Removing a missing entry does nothing. */
  delete(id: string): Promise<void>;
}

/**
 * A library kept in memory, for tests and for the frontend in a plain browser. It keeps what it
 * is given, as the real store does, and forgets it when the page closes.
 */
export function createMemoryLibraryStore(): LibraryStore {
  const entries = new Map<string, unknown>();
  return {
    list: () =>
      Promise.resolve(
        [...entries]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([id, entry]) => ({ id, entry: structuredClone(entry) })),
      ),
    save: (id, entry) =>
      Promise.resolve().then(() => {
        if (entries.has(id)) throw new Error(`Library entry ${id} already exists`);
        entries.set(id, structuredClone(entry));
      }),
    delete: (id) =>
      Promise.resolve().then(() => {
        entries.delete(id);
      }),
  };
}

const tauriLibraryStore: LibraryStore = {
  list: () => invoke("list_library"),
  save: (id, entry) => invoke("save_library_entry", { id, entry }),
  delete: (id) => invoke("delete_library_entry", { id }),
};

/** The library for the current environment: the app's files in Tauri, else one in memory. */
export function connectLibraryStore(): LibraryStore {
  return isTauri() ? tauriLibraryStore : createMemoryLibraryStore();
}
