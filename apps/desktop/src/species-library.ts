import {
  error,
  formatDiagnostic,
  LIBRARY_ENTRY_SCHEMA_VERSION,
  parseDrawing,
  parseLibraryEntry,
  SCHEMA_VERSIONS,
  type Diagnostic,
  type Drawing,
  type LibraryEntry,
  type Result,
  type SizeClass,
  type SpeciesDefinition,
} from "@living-diorama/content-schema";
import type { LibraryStore, StoredLibraryEntry } from "@living-diorama/desktop-integration";
import type { SimulationClient } from "./simulation-client";
import { DRAWN_SPECIES_DEFAULTS } from "./startup";
import { userSpeciesIds } from "./user-species";

// The species library at run time (ADR 0014): the drawn species the player keeps, registered in
// the running world, and what can be done with them.

interface LibrarySpeciesBase {
  speciesId: string;
  name: string;
  sizeClass: SizeClass;
  createdAt: string;
}

/** A species in the library, and whether the world took it (ADR 0014 §8). */
export type LibrarySpecies = LibrarySpeciesBase &
  (
    | {
        available: true;
        /** Where its creatures don't fit in this world (ADR 0013). */
        limits: Diagnostic[];
      }
    | {
        available: false;
        /** Why it can't be used. */
        reasons: Diagnostic[];
      }
  );

export interface SpeciesLibrary {
  /** Every species in the library, oldest first. */
  list(): LibrarySpecies[];
  /** Makes a species from a drawing and its image (PNG bytes), registers it and stores it. */
  save(
    drawing: Drawing,
    image: Uint8Array,
    name: string,
    sizeClass: SizeClass,
  ): Promise<Result<LibrarySpecies>>;
  /** Adds a creature of a registered species at a random spawn point. Resolves with its ID. */
  addCreature(speciesId: string): Promise<Result<string>>;
  removeCreature(creatureId: string): Promise<Result<string>>;
  /**
   * Takes the species' creatures out of the world and deletes its files. It stays registered,
   * unseen, until the next launch (ADR 0014 §9).
   */
  deleteSpecies(speciesId: string): Promise<Result<void>>;
}

/** What the library needs of the running world. */
export interface LibraryWorld extends Pick<
  SimulationClient,
  "registerSpecies" | "spawn" | "despawn"
> {
  /** The creatures in the world now, from the latest snapshot. */
  creatures(): readonly { id: string; speciesId: string }[];
}

export interface LibraryOptions {
  now?: () => Date;
  /** A fresh lowercase UUID for each saved species. */
  uuid?: () => string;
  /** Called after the list changes: a species saved or deleted. */
  onChange?: () => void;
}

const failure = (code: string, message: string): { ok: false; diagnostics: Diagnostic[] } => ({
  ok: false,
  diagnostics: [error(code, message, [])],
});

const describeError = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const describeEntry = ({ species, createdAt }: LibraryEntry): LibrarySpeciesBase => ({
  speciesId: species.id,
  name: species.name,
  sizeClass: species.sizeClass,
  createdAt,
});

/**
 * The entry stored under `id` if it passes its schema and holds that ID's species, else undefined
 * with a warning. Its files are left alone (ADR 0014 §3).
 */
function checkEntry(id: string, input: unknown): LibraryEntry | undefined {
  const parsed = parseLibraryEntry(input, `library/${id}/entry.json`);
  let diagnostics = parsed.ok ? [] : parsed.diagnostics;
  if (parsed.ok) {
    const { species } = parsed.value;
    const ids = userSpeciesIds(id);
    if (species.id !== ids.speciesId || species.appearance !== ids.appearanceId) {
      diagnostics = [error("library_id_mismatch", `The entry holds ${species.id}`, ["species"])];
    }
  }
  if (!parsed.ok || diagnostics.length > 0) {
    console.warn(
      [`Skipped library entry ${id}`, ...diagnostics.map(formatDiagnostic)].join("\n  "),
    );
    return undefined;
  }
  return parsed.value;
}

interface Kept {
  species: LibrarySpecies;
  uuid: string;
  /** The `blob:` URL the world draws the species from, while it is registered. */
  url?: string;
}

/**
 * Opens the library and registers its species in `world`, one at a time and without creatures
 * (ADR 0014 §8). A species the world rejects is listed as unavailable.
 */
export async function openSpeciesLibrary(
  store: LibraryStore,
  world: LibraryWorld,
  {
    now = () => new Date(),
    uuid = () => crypto.randomUUID(),
    onChange = () => {},
  }: LibraryOptions = {},
): Promise<SpeciesLibrary> {
  const entries = new Map<string, Kept>();
  /** Deleted, or never stored, this run but still registered: no new creatures. */
  const unseen = new Set<string>();

  /** Registers `entry`'s species from its image, and keeps it in the list. */
  const register = async (uuid: string, entry: LibraryEntry, image: Uint8Array) => {
    const url = URL.createObjectURL(new Blob([image.slice()], { type: "image/png" }));
    const registered = await world.registerSpecies(entry.species, url);
    if (!registered.ok) {
      URL.revokeObjectURL(url);
      return registered;
    }
    const species: LibrarySpecies = {
      ...describeEntry(entry),
      available: true,
      limits: registered.value.limits,
    };
    entries.set(species.speciesId, { uuid, species, url });
    return { ok: true as const, value: species };
  };
  const keepUnavailable = (uuid: string, entry: LibraryEntry, reasons: Diagnostic[]) => {
    console.warn(
      [`${entry.species.id} is unavailable`, ...reasons.map(formatDiagnostic)].join("\n  "),
    );
    entries.set(entry.species.id, {
      uuid,
      species: { ...describeEntry(entry), available: false, reasons },
    });
  };

  let stored: StoredLibraryEntry[];
  try {
    stored = await store.list();
  } catch (cause) {
    console.warn(`Could not read the species library: ${describeError(cause)}`);
    stored = [];
  }
  for (const { id, entry: input } of stored) {
    const entry = checkEntry(id, input);
    if (!entry) continue;
    let image;
    try {
      image = await store.loadImage(id);
    } catch (cause) {
      keepUnavailable(id, entry, [
        error("library_io", `Could not read the image: ${describeError(cause)}`, []),
      ]);
      continue;
    }
    const registered = await register(id, entry, image);
    if (!registered.ok) keepUnavailable(id, entry, registered.diagnostics);
  }

  return {
    list: () =>
      [...entries.values()]
        .map(({ species }) => species)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),

    async save(drawingInput, image, name, sizeClass) {
      const drawing = parseDrawing(drawingInput);
      if (!drawing.ok) return drawing;
      const ids = userSpeciesIds(uuid());
      const species: SpeciesDefinition = {
        schemaVersion: SCHEMA_VERSIONS.species,
        id: ids.speciesId,
        version: "1.0.0",
        name,
        appearance: ids.appearanceId,
        sizeClass,
        ...structuredClone(DRAWN_SPECIES_DEFAULTS),
      };
      const entry = parseLibraryEntry({
        schemaVersion: LIBRARY_ENTRY_SCHEMA_VERSION,
        species,
        createdAt: now().toISOString(),
      });
      if (!entry.ok) return entry;
      // Registered first, so a species the world rejects never reaches the disk.
      const registered = await register(ids.uuid, entry.value, image);
      if (!registered.ok) return registered;
      try {
        await store.save(ids.uuid, entry.value, drawing.value, image);
      } catch (cause) {
        // Registered but not kept: unseen until the next launch, as after a delete.
        URL.revokeObjectURL(entries.get(ids.speciesId)?.url ?? "");
        entries.delete(ids.speciesId);
        unseen.add(ids.speciesId);
        return failure("library_io", `Could not save ${name}: ${describeError(cause)}`);
      }
      onChange();
      return registered;
    },

    addCreature: (speciesId) =>
      unseen.has(speciesId)
        ? Promise.resolve(failure("species_deleted", `${speciesId} is not in the library`))
        : world.spawn(speciesId),

    removeCreature: (creatureId) => world.despawn(creatureId),

    async deleteSpecies(speciesId) {
      const found = entries.get(speciesId);
      if (!found) return failure("unknown_species", `${speciesId} is not in the library`);
      try {
        await store.delete(found.uuid);
      } catch (cause) {
        return failure(
          "library_io",
          `Could not delete ${found.species.name}: ${describeError(cause)}`,
        );
      }
      entries.delete(speciesId);
      unseen.add(speciesId);
      onChange();
      const leaving = world.creatures().filter((creature) => creature.speciesId === speciesId);
      await Promise.all(leaving.map((creature) => world.despawn(creature.id)));
      if (found.url) URL.revokeObjectURL(found.url);
      return { ok: true, value: undefined };
    },
  };
}
