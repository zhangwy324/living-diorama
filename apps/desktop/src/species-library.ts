import {
  error,
  formatDiagnostic,
  LIBRARY_ENTRY_SCHEMA_VERSION,
  libraryAppearance,
  measureAssembly,
  parseLibraryEntry,
  SCHEMA_VERSIONS,
  validate,
  VoxelAssemblySchema,
  type Diagnostic,
  type LibraryEntry,
  type Result,
  type SizeClass,
  type SpeciesDefinitionInput,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import type { LibraryStore, StoredLibraryEntry } from "@living-diorama/desktop-integration";
import type { Limit } from "@living-diorama/simulation";
import type { SimulationClient } from "./simulation-client";
import { locomotionCapabilities, planVoxelBody, type BodyPlanChoice } from "./body-plan";
import { USER_SPECIES_DEFAULTS } from "./startup";
import { userSpeciesIds, type UserSpeciesIds } from "./user-species";

// The species library at run time (ADR 0014): the voxel species the player keeps (ADR 0022 §17),
// registered in the running world, and what can be done with them.

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
        limits: Limit[];
      }
    | {
        available: false;
        /** Why it can't be used. */
        reasons: Diagnostic[];
      }
  );

/** A species' saved assembly, with the species version it is drawn at (ADR 0023 §19). */
export interface LibraryAssembly {
  speciesId: string;
  version: string;
  assembly: VoxelAssembly;
}

/**
 * The most bytes a voxel assembly may take as JSON (UTF-8): the store's limit on a whole library
 * entry, which holds it (#208). An assembly over it is refused before anything else.
 */
export const MAX_ASSEMBLY_BYTES = 8 * 1024 * 1024;

/** How many bytes `assembly` takes as JSON, or undefined if it isn't JSON. */
export function assemblyBytes(assembly: unknown): number | undefined {
  try {
    const json = JSON.stringify(assembly) as string | undefined;
    return json === undefined ? undefined : new TextEncoder().encode(json).length;
  } catch {
    return undefined;
  }
}

export interface SpeciesLibrary {
  /** Every species in the library, oldest first. */
  list(): LibrarySpecies[];
  /**
   * The saved assembly of a species in the list, available or not, e.g. to draw its thumbnail or
   * to edit a copy (ADR 0023 §3, §19). `unknown_species` if the list doesn't hold it.
   */
  assembly(speciesId: string): Result<LibraryAssembly>;
  /**
   * Makes a voxel species from an assembly (ADR 0022), registers it and stores it. An assembly over
   * `MAX_ASSEMBLY_BYTES` as JSON is refused first (`assembly_too_big`). Its size class is measured
   * from its cubes, and one too large for every class is refused (`too_large`). Its parts must fit
   * the world's part and socket types, checked here, at release, and not when it loads again.
   * `plan`'s ways of moving give it its capabilities and gait; its cubes give its anchors.
   * `options.id` is the lowercase UUID to keep it under, a fresh one by default; one already used
   * is refused.
   */
  saveVoxel(
    assembly: unknown,
    name: string,
    plan: BodyPlanChoice,
    options?: SaveOptions,
  ): Promise<Result<LibrarySpecies>>;
  /**
   * Adds a creature of a registered species at a random spawn point, released from the Studio
   * (ADR 0018 amendments, §13). Resolves with its ID.
   */
  addCreature(speciesId: string): Promise<Result<string>>;
  removeCreature(creatureId: string): Promise<Result<string>>;
  /**
   * Takes the species' creatures out of the world and deletes its files. It stays registered,
   * unseen, until the next launch (ADR 0014 §9).
   */
  deleteSpecies(speciesId: string): Promise<Result<void>>;
}

export interface SaveOptions {
  id?: string;
}

/** What the library needs of the running world. */
export interface LibraryWorld extends Pick<
  SimulationClient,
  "registerSpecies" | "spawn" | "despawn" | "checkAssembly"
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
 * The file the world draws a species from, for its `blob:` URL: its assembly as JSON, which its
 * entry holds inline (ADR 0022 §17).
 */
const assemblyBlob = (assembly: VoxelAssembly): Blob =>
  new Blob([JSON.stringify(assembly)], { type: "application/json" });

/**
 * The entry stored under `id` if it passes its schema and holds that ID's species, else undefined
 * with a warning: an entry of an older version, such as a drawn species from before M23, is
 * skipped so. Its files are left alone (ADR 0014 §3).
 */
function checkEntry(id: string, input: unknown): LibraryEntry | undefined {
  const parsed = parseLibraryEntry(input, `library/${id}/entry.json`);
  let diagnostics = parsed.ok ? [] : parsed.diagnostics;
  if (parsed.ok) {
    const { species } = parsed.value;
    const ids = userSpeciesIds(id);
    if (species.id !== ids.speciesId || species.appearance !== libraryAppearance(ids.speciesId)) {
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

/** Said when an assembly is over `MAX_ASSEMBLY_BYTES`. */
export const tooBigMessage = (name: string) =>
  `${name} has too much detail to save. Use fewer or smaller parts.`;

/** An entry's assembly and version, for `Kept`. */
const assemblyOf = ({ species, assembly }: LibraryEntry): Kept["assembly"] => ({
  version: species.version,
  assembly,
});

interface Kept {
  species: LibrarySpecies;
  uuid: string;
  /** The species' assembly and version, as its entry holds them. */
  assembly: Omit<LibraryAssembly, "speciesId">;
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

  /** Registers `entry`'s species from its assembly, and keeps it in the list. */
  const register = async (uuid: string, entry: LibraryEntry) => {
    const url = URL.createObjectURL(assemblyBlob(entry.assembly));
    const registered = await world.registerSpecies(entry.species, url, "voxel");
    if (!registered.ok) {
      URL.revokeObjectURL(url);
      return registered;
    }
    const species: LibrarySpecies = {
      ...describeEntry(entry),
      available: true,
      limits: registered.value.limits,
    };
    entries.set(species.speciesId, { uuid, species, url, assembly: assemblyOf(entry) });
    return { ok: true as const, value: species };
  };
  const keepUnavailable = (uuid: string, entry: LibraryEntry, reasons: Diagnostic[]) => {
    console.warn(
      [`${entry.species.id} is unavailable`, ...reasons.map(formatDiagnostic)].join("\n  "),
    );
    entries.set(entry.species.id, {
      uuid,
      species: { ...describeEntry(entry), available: false, reasons },
      assembly: assemblyOf(entry),
    });
  };

  /**
   * Checks a new entry, registers it and stores it as written. Registered first, so a species the
   * world rejects never reaches the disk. Stored as written, not parsed: parsing fills in
   * defaults, such as the gait and empty senses, which the entry needn't hold.
   */
  const keepNew = async (
    uuid: string,
    written: Record<string, unknown>,
  ): Promise<Result<LibrarySpecies>> => {
    const parsed = parseLibraryEntry(written);
    if (!parsed.ok) return parsed;
    const entry = parsed.value;
    const registered = await register(uuid, entry);
    if (!registered.ok) return registered;
    const speciesId = entry.species.id;
    try {
      await store.save(uuid, written);
    } catch (cause) {
      // Registered but not kept: unseen until the next launch, as after a delete.
      URL.revokeObjectURL(entries.get(speciesId)?.url ?? "");
      entries.delete(speciesId);
      unseen.add(speciesId);
      return failure("library_io", `Could not save ${entry.species.name}: ${describeError(cause)}`);
    }
    onChange();
    return registered;
  };
  /** The IDs of a new species stored under `id`, or why it can't be. */
  const freshIds = (id: string): Result<UserSpeciesIds> => {
    const ids = userSpeciesIds(id);
    return entries.has(ids.speciesId) || unseen.has(ids.speciesId)
      ? failure("species_exists", `${ids.speciesId} is already in the library`)
      : { ok: true, value: ids };
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
    const registered = await register(id, entry);
    if (!registered.ok) keepUnavailable(id, entry, registered.diagnostics);
  }

  return {
    list: () =>
      [...entries.values()]
        .map(({ species }) => species)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),

    assembly(speciesId) {
      const found = entries.get(speciesId);
      if (!found) return failure("unknown_species", `${speciesId} is not in the library`);
      return { ok: true, value: { speciesId, ...found.assembly } };
    },

    async saveVoxel(assemblyInput, name, plan, { id = uuid() } = {}) {
      const bytes = assemblyBytes(assemblyInput);
      if (bytes === undefined) return failure("invalid_assembly", `${name}'s assembly isn't JSON`);
      if (bytes > MAX_ASSEMBLY_BYTES) return failure("assembly_too_big", tooBigMessage(name));
      const assembly = validate(VoxelAssemblySchema, assemblyInput);
      if (!assembly.ok) return assembly;
      const fresh = freshIds(id);
      if (!fresh.ok) return fresh;
      const ids = fresh.value;
      // Measured from the cubes (ADR 0022 §3); the part type roles it can take move only the tail.
      const { sizeClass } = measureAssembly(assembly.value);
      if (!sizeClass) return failure("too_large", `${name} is too large for every size class`);
      // Fits are checked at release only, by the world (ADR 0022, M19 decisions).
      let checked: Result<Diagnostic[]>;
      try {
        checked = await world.checkAssembly(assembly.value);
      } catch (cause) {
        return failure("assembly_check_failed", `Could not check ${name}: ${describeError(cause)}`);
      }
      if (!checked.ok) return checked;
      if (checked.value.some((d) => d.severity === "error")) {
        return { ok: false, diagnostics: checked.value };
      }
      const species: SpeciesDefinitionInput = {
        // First, so the app defaults never override the plan or anything below.
        ...structuredClone(USER_SPECIES_DEFAULTS),
        schemaVersion: SCHEMA_VERSIONS.species,
        id: ids.speciesId,
        version: "1.0.0",
        name,
        appearance: libraryAppearance(ids.speciesId),
        sizeClass,
        body: planVoxelBody(plan),
        capabilities: locomotionCapabilities(plan.locomotion),
      };
      const entry = {
        schemaVersion: LIBRARY_ENTRY_SCHEMA_VERSION,
        species,
        assembly: assembly.value,
        createdAt: now().toISOString(),
      };
      return keepNew(ids.uuid, entry);
    },

    addCreature: (speciesId) =>
      unseen.has(speciesId)
        ? Promise.resolve(failure("species_deleted", `${speciesId} is not in the library`))
        : world.spawn(speciesId, { released: true }),

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
