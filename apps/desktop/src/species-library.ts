import {
  BODY_THICKNESS,
  error,
  formatDiagnostic,
  LIBRARY_ENTRY_SCHEMA_VERSION,
  libraryAppearance,
  measureAssembly,
  parseDrawing,
  parseLibraryEntry,
  SCHEMA_VERSIONS,
  validate,
  VoxelAssemblySchema,
  type Diagnostic,
  type Drawing,
  type LibraryBodyKind,
  type LibraryEntry,
  type Result,
  type SizeClass,
  type SpeciesDefinitionInput,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import type { LibraryStore, StoredLibraryEntry } from "@living-diorama/desktop-integration";
import type { Limit } from "@living-diorama/simulation";
import type { SimulationClient } from "./simulation-client";
import {
  defaultPlan,
  locomotionCapabilities,
  planBody,
  planVoxelBody,
  type BodyPlanChoice,
} from "./body-plan";
import { USER_SPECIES_DEFAULTS } from "./startup";
import { userSpeciesIds, type UserSpeciesIds } from "./user-species";

// The species library at run time (ADR 0014): the species the player keeps, drawn or voxel
// (ADR 0022 §17), registered in the running world, and what can be done with them.

interface LibrarySpeciesBase {
  speciesId: string;
  name: string;
  sizeClass: SizeClass;
  createdAt: string;
  /** What its body is made of: a drawing, or voxel parts. */
  body: LibraryBodyKind;
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

/** A voxel species' saved assembly, with the species version it is drawn at (ADR 0023 §19). */
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
   * The saved assembly of a voxel species in the list, available or not, e.g. to draw its
   * thumbnail or to edit a copy (ADR 0023 §3, §19). `unknown_species` if the list doesn't hold
   * it, `not_voxel` for a drawn species.
   */
  assembly(speciesId: string): Result<LibraryAssembly>;
  /**
   * Makes a species from a drawing and its image (PNG bytes), registers it and stores it.
   * `options.id` is the lowercase UUID to keep it under, a fresh one by default; one already used
   * is refused. `options.thickness` is the body's depth as a share of its height, the default
   * one if left out. `options.plan` is the body plan the player chose, on land and walking if left
   * out: it gives the species its capabilities, gait and anchors (ADR 0020 §14).
   */
  save(
    drawing: Drawing,
    image: Uint8Array,
    name: string,
    sizeClass: SizeClass,
    options?: SaveOptions,
  ): Promise<Result<LibrarySpecies>>;
  /**
   * Makes a voxel species from an assembly (ADR 0022), registers it and stores it. An assembly over
   * `MAX_ASSEMBLY_BYTES` as JSON is refused first (`assembly_too_big`). Its size class is measured
   * from its cubes, and one too large for every class is refused (`too_large`). Its parts must fit
   * the world's part and socket types, checked here, at release, and not when it loads again.
   * `plan`'s ways of moving give it its capabilities and gait; a voxel species has no placed
   * anchors. `options.id` as for `save`.
   */
  saveVoxel(
    assembly: unknown,
    name: string,
    plan: Pick<BodyPlanChoice, "locomotion">,
    options?: Pick<SaveOptions, "id">,
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
  thickness?: number;
  plan?: BodyPlanChoice;
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

const describeEntry = ({ species, createdAt, body }: LibraryEntry): LibrarySpeciesBase => ({
  speciesId: species.id,
  name: species.name,
  sizeClass: species.sizeClass,
  createdAt,
  body: body.kind,
});

/**
 * What the world draws a species from, as the asset kind it registers: a drawn one's image (PNG
 * bytes), or a voxel one's assembly, which its entry holds inline (ADR 0022 §17).
 */
type Appearance = { kind: "image"; image: Uint8Array } | { kind: "voxel"; assembly: VoxelAssembly };

/** The file of an appearance, for its `blob:` URL: the PNG, or the assembly as JSON. */
const appearanceBlob = (appearance: Appearance): Blob =>
  appearance.kind === "voxel"
    ? new Blob([JSON.stringify(appearance.assembly)], { type: "application/json" })
    : new Blob([appearance.image.slice()], { type: "image/png" });

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
    const appearance = libraryAppearance(ids.speciesId, parsed.value.body.kind);
    if (species.id !== ids.speciesId || species.appearance !== appearance) {
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

/** A voxel entry's assembly and version, for `Kept`; nothing for a drawn one. */
const voxelOf = ({ species, body }: LibraryEntry): Pick<Kept, "voxel"> =>
  body.kind === "voxel" ? { voxel: { version: species.version, assembly: body.assembly } } : {};

interface Kept {
  species: LibrarySpecies;
  uuid: string;
  /** A voxel species' assembly and version, as its entry holds them. */
  voxel?: Omit<LibraryAssembly, "speciesId">;
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

  /** Registers `entry`'s species from its appearance, and keeps it in the list. */
  const register = async (uuid: string, entry: LibraryEntry, appearance: Appearance) => {
    const url = URL.createObjectURL(appearanceBlob(appearance));
    const registered = await world.registerSpecies(entry.species, url, appearance.kind);
    if (!registered.ok) {
      URL.revokeObjectURL(url);
      return registered;
    }
    const species: LibrarySpecies = {
      ...describeEntry(entry),
      available: true,
      limits: registered.value.limits,
    };
    entries.set(species.speciesId, { uuid, species, url, ...voxelOf(entry) });
    return { ok: true as const, value: species };
  };
  const keepUnavailable = (uuid: string, entry: LibraryEntry, reasons: Diagnostic[]) => {
    console.warn(
      [`${entry.species.id} is unavailable`, ...reasons.map(formatDiagnostic)].join("\n  "),
    );
    entries.set(entry.species.id, {
      uuid,
      species: { ...describeEntry(entry), available: false, reasons },
      ...voxelOf(entry),
    });
  };

  /**
   * Checks a new entry, registers it and stores it as written, with a drawn species' files.
   * Registered first, so a species the world rejects never reaches the disk. Stored as written,
   * not parsed: parsing fills in defaults, such as the drawn-only body settings a voxel entry
   * must not hold.
   */
  const keepNew = async (
    uuid: string,
    written: Record<string, unknown>,
    drawn?: { drawing: Drawing; image: Uint8Array },
  ): Promise<Result<LibrarySpecies>> => {
    const parsed = parseLibraryEntry(written);
    if (!parsed.ok) return parsed;
    const entry = parsed.value;
    const appearance: Appearance | undefined =
      entry.body.kind === "voxel"
        ? { kind: "voxel", assembly: entry.body.assembly }
        : drawn && { kind: "image", image: drawn.image };
    if (!appearance) return failure("missing_image", "A drawn species needs its image");
    const registered = await register(uuid, entry, appearance);
    if (!registered.ok) return registered;
    const speciesId = entry.species.id;
    try {
      await store.save(uuid, written, drawn);
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
    // A voxel species has no image: its entry holds its assembly.
    let appearance: Appearance;
    if (entry.body.kind === "voxel") {
      appearance = { kind: "voxel", assembly: entry.body.assembly };
    } else {
      try {
        appearance = { kind: "image", image: await store.loadImage(id) };
      } catch (cause) {
        keepUnavailable(id, entry, [
          error("library_io", `Could not read the image: ${describeError(cause)}`, []),
        ]);
        continue;
      }
    }
    const registered = await register(id, entry, appearance);
    if (!registered.ok) keepUnavailable(id, entry, registered.diagnostics);
  }

  return {
    list: () =>
      [...entries.values()]
        .map(({ species }) => species)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),

    async save(
      drawingInput,
      image,
      name,
      sizeClass,
      { id = uuid(), thickness, plan = defaultPlan() } = {},
    ) {
      const drawing = parseDrawing(drawingInput);
      if (!drawing.ok) return drawing;
      const fresh = freshIds(id);
      if (!fresh.ok) return fresh;
      const ids = fresh.value;
      const species: SpeciesDefinitionInput = {
        // First, so the app defaults never override the plan or anything below.
        ...structuredClone(USER_SPECIES_DEFAULTS),
        schemaVersion: SCHEMA_VERSIONS.species,
        id: ids.speciesId,
        version: "1.0.0",
        name,
        appearance: ids.appearanceId,
        sizeClass,
        body: planBody(plan, thickness ?? BODY_THICKNESS.default),
        capabilities: locomotionCapabilities(plan.locomotion),
      };
      const entry = {
        schemaVersion: LIBRARY_ENTRY_SCHEMA_VERSION,
        species,
        body: { kind: "drawn" },
        createdAt: now().toISOString(),
      };
      return keepNew(ids.uuid, entry, { drawing: drawing.value, image });
    },

    assembly(speciesId) {
      const found = entries.get(speciesId);
      if (!found) return failure("unknown_species", `${speciesId} is not in the library`);
      if (!found.voxel) return failure("not_voxel", `${found.species.name} is drawn, not built`);
      return { ok: true, value: { speciesId, ...found.voxel } };
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
        appearance: libraryAppearance(ids.speciesId, "voxel"),
        sizeClass,
        body: planVoxelBody(plan),
        capabilities: locomotionCapabilities(plan.locomotion),
      };
      const entry = {
        schemaVersion: LIBRARY_ENTRY_SCHEMA_VERSION,
        species,
        body: { kind: "voxel", assembly: assembly.value },
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
