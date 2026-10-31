import {
  formatDiagnostic,
  MAX_PLAYER_PART_NAME_LENGTH,
  parsePlayerPartEntry,
  playerPartId,
  type PlayerPartEntry,
} from "@living-diorama/content-schema";
import type { PartsStore } from "@living-diorama/desktop-integration";
import type { PartSummary } from "@living-diorama/simulation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// The player's own parts (ADR 0025 §6, §7): read from the parts store, checked against
// `content-schema`, and offered to Build mode's tray beside the packs' parts. Renaming saves the
// part in place with its version raised; deleting removes its file. Creatures already released
// keep their frozen copies either way (ADR 0022 §17).

/** A checked player part: the UUID it is stored under and its entry. */
export interface PlayerPart {
  /** The lowercase UUID of its `parts/<uuid>.json` file. */
  uuid: string;
  entry: PlayerPartEntry;
  /** The part as the tray lists it, made once per loaded entry so its identity is stable. */
  summary: PartSummary;
}

/** The part as the tray and the assembly take it: its version as a string, as a pack part's is. */
export const playerPartSummary = (entry: PlayerPartEntry): PartSummary => ({
  id: entry.id,
  name: entry.name,
  version: String(entry.version),
  part: entry.part,
});

/** A store's rejection in words: Tauri rejects with a string, the memory store with an Error. */
export const describeStoreError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The stored entry if it is a valid player part under its own file's ID, else undefined with a
 * line in the log. Its file is left alone.
 */
export function checkPlayerPart(uuid: string, input: unknown): PlayerPart | undefined {
  const parsed = parsePlayerPartEntry(input, `parts/${uuid}.json`);
  if (!parsed.ok) {
    console.warn(
      [`Skipped player part ${uuid}`, ...parsed.diagnostics.map(formatDiagnostic)].join("\n  "),
    );
    return undefined;
  }
  if (parsed.value.id !== playerPartId(uuid)) {
    console.warn(`Skipped player part ${uuid}: it holds ${parsed.value.id}`);
    return undefined;
  }
  return { uuid, entry: parsed.value, summary: playerPartSummary(parsed.value) };
}

/** Oldest first, so a new part goes last and a renamed one keeps its place. */
const byCreation = (a: PlayerPart, b: PlayerPart) =>
  Date.parse(a.entry.createdAt) - Date.parse(b.entry.createdAt) || (a.uuid < b.uuid ? -1 : 1);

/** Every valid player part in the store, oldest first; invalid ones are skipped (logged). */
export async function loadPlayerParts(store: PartsStore): Promise<PlayerPart[]> {
  const stored = await store.list();
  return stored
    .map(({ id, entry }) => checkPlayerPart(id, entry))
    .filter((part) => part !== undefined)
    .sort(byCreation);
}

/** The entry renamed to `name` (trimmed), saved as its next version. */
export const renamedEntry = (entry: PlayerPartEntry, name: string, now: Date): PlayerPartEntry => ({
  ...entry,
  name: name.trim(),
  version: entry.version + 1,
  updatedAt: now.toISOString(),
});

/** Whether `name` can be a part's name. */
export const validPartName = (name: string): boolean => {
  const trimmed = name.trim();
  return trimmed !== "" && trimmed.length <= MAX_PLAYER_PART_NAME_LENGTH;
};

/** Said when a part is renamed or deleted before the parts have been read. */
export const NOT_READ_YET = "Your parts haven't been read yet. Try again in a moment.";

/** The player's parts and what can be done with them, for the tray and My parts. */
export interface PlayerPartsState {
  /** Undefined until first read. */
  parts: readonly PlayerPart[] | undefined;
  /** The last failure to read, rename or delete, in words. */
  error: string | undefined;
  /** Reads the store again, e.g. after Draw mode saved a part. */
  reload(): Promise<void>;
  /** Renames a part, saving it as its next version. Resolves false when it failed (see `error`). */
  rename(uuid: string, name: string): Promise<boolean>;
  /** Deletes a part; the caller asks first. Resolves false when it failed (see `error`). */
  remove(uuid: string): Promise<boolean>;
}

/**
 * The player's parts from `store`, read when it is given and again on `reload`. With no store,
 * nothing is read and `parts` stays undefined.
 */
export function usePlayerParts(
  store: PartsStore | undefined,
  now: () => Date = () => new Date(),
): PlayerPartsState {
  const [parts, setParts] = useState<readonly PlayerPart[]>();
  const [error, setError] = useState<string>();
  // Only the latest read lands, so an older, slower one can't undo a newer one.
  const reads = useRef(0);
  const latest = useRef(parts);
  const nowRef = useRef(now);
  useEffect(() => {
    latest.current = parts;
    nowRef.current = now;
  });

  const reload = useCallback((): Promise<void> => {
    if (!store) return Promise.resolve();
    const read = ++reads.current;
    return loadPlayerParts(store).then(
      (loaded) => {
        if (read !== reads.current) return;
        setParts(loaded);
        setError(undefined);
      },
      (cause: unknown) => {
        if (read !== reads.current) return;
        console.warn("Could not read your parts", cause);
        setError(`Could not read your parts: ${describeStoreError(cause)}`);
      },
    );
  }, [store]);

  // A new store's read is newer than any still on its way for the old one, so those are dropped.
  useEffect(() => {
    void reload();
  }, [reload]);

  const rename = useCallback(
    async (uuid: string, name: string) => {
      if (!store) return false;
      if (!latest.current) {
        setError(NOT_READ_YET);
        return false;
      }
      const known = latest.current.find((part) => part.uuid === uuid);
      if (!known || !validPartName(name)) return false;
      const entry = renamedEntry(known.entry, name, nowRef.current());
      try {
        await store.save(uuid, entry);
      } catch (cause) {
        setError(`Could not rename ${known.entry.name}: ${describeStoreError(cause)}`);
        return false;
      }
      const renamed = { uuid, entry, summary: playerPartSummary(entry) };
      setParts((list) => list?.map((part) => (part.uuid === uuid ? renamed : part)));
      setError(undefined);
      // Read again, so a read that started before the save can't bring the old name back.
      void reload();
      return true;
    },
    [store, reload],
  );

  const remove = useCallback(
    async (uuid: string) => {
      if (!store) return false;
      if (!latest.current) {
        setError(NOT_READ_YET);
        return false;
      }
      const known = latest.current.find((part) => part.uuid === uuid);
      if (!known) return false;
      try {
        await store.delete(uuid);
      } catch (cause) {
        setError(`Could not delete ${known.entry.name}: ${describeStoreError(cause)}`);
        return false;
      }
      setParts((list) => list?.filter((part) => part.uuid !== uuid));
      setError(undefined);
      void reload();
      return true;
    },
    [store, reload],
  );

  return useMemo(
    () => ({ parts, error, reload, rename, remove }),
    [parts, error, reload, rename, remove],
  );
}
