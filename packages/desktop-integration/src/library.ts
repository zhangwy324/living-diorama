import { invoke, isTauri } from "@tauri-apps/api/core";

/** A library entry as stored: its folder's ID and `entry.json`, not yet checked (ADR 0014 §3). */
export interface StoredLibraryEntry {
  /** A lowercase UUID, the `<uuid>` of the species' `user:<uuid>` ID. */
  id: string;
  entry: unknown;
}

/**
 * A drawn species' files beside its entry: the drawing record and the PNG it is built from. A
 * voxel species has none, since its assembly is inline in the entry (ADR 0022 §17).
 */
export interface DrawnLibraryFiles {
  drawing: unknown;
  image: Uint8Array;
}

/**
 * The species library's files (ADR 0014). The store only keeps files: it doesn't read the
 * entries, so the frontend checks them against `content-schema`. Every method rejects with a
 * readable message when the files can't be read or written.
 */
export interface LibraryStore {
  /** Every complete entry, sorted by ID. Folders that aren't readable entries are skipped. */
  list(): Promise<StoredLibraryEntry[]>;
  /** A drawn entry's drawing record. Rejects for a voxel entry, which has none. */
  loadDrawing(id: string): Promise<unknown>;
  /** A drawn entry's appearance image, as PNG bytes. Rejects for a voxel entry. */
  loadImage(id: string): Promise<Uint8Array>;
  /**
   * Saves a new entry and its files at once: a drawn species with its `drawn` files, a voxel
   * species without. Rejects if the ID is taken.
   */
  save(id: string, entry: unknown, drawn?: DrawnLibraryFiles): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * A library kept in memory, for tests and for the frontend in a plain browser. It keeps what it
 * is given, as the real store does, and forgets it when the page closes.
 */
export function createMemoryLibraryStore(): LibraryStore {
  const entries = new Map<string, { entry: unknown; drawn?: DrawnLibraryFiles }>();
  const find = (id: string) => {
    const stored = entries.get(id);
    if (!stored) throw new Error(`No library entry ${id}`);
    return stored;
  };
  const drawn = (id: string) => {
    const files = find(id).drawn;
    if (!files) throw new Error(`Library entry ${id} has no drawing`);
    return files;
  };
  return {
    list: () =>
      Promise.resolve(
        [...entries.keys()].sort().map((id) => ({ id, entry: structuredClone(find(id).entry) })),
      ),
    loadDrawing: (id) => Promise.resolve().then(() => structuredClone(drawn(id).drawing)),
    loadImage: (id) => Promise.resolve().then(() => drawn(id).image.slice()),
    save: (id, entry, files) =>
      Promise.resolve().then(() => {
        if (entries.has(id)) throw new Error(`Library entry ${id} already exists`);
        entries.set(id, {
          entry: structuredClone(entry),
          ...(files && {
            drawn: { drawing: structuredClone(files.drawing), image: files.image.slice() },
          }),
        });
      }),
    delete: (id) =>
      Promise.resolve().then(() => {
        find(id);
        entries.delete(id);
      }),
  };
}

const tauriLibraryStore: LibraryStore = {
  list: () => invoke("list_library"),
  loadDrawing: (id) => invoke("load_library_drawing", { id }),
  loadImage: async (id) => new Uint8Array(await invoke<ArrayBuffer>("load_library_image", { id })),
  // The image goes as a JSON array of numbers, fine for the Studio's small PNGs (ADR 0014).
  save: (id, entry, drawn) =>
    invoke("save_library_entry", {
      id,
      entry,
      drawing: drawn?.drawing ?? null,
      image: drawn ? Array.from(drawn.image) : null,
    }),
  delete: (id) => invoke("delete_library_entry", { id }),
};

/** The library for the current environment: the app's files in Tauri, else one in memory. */
export function connectLibraryStore(): LibraryStore {
  return isTauri() ? tauriLibraryStore : createMemoryLibraryStore();
}
