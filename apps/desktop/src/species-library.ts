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
  type LibraryBody,
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
import { DRAWN_SPECIES_DEFAULTS } from "./startup";
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

export interface SpeciesLibrary {
  /** Every species in the library, oldest first. */
  list(): LibrarySpecies[];
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
   * Makes a voxel species from an assembly (ADR 0022), registers it and stores it. Its size class
   * is measured from its cubes, and one too large for every class is refused. Its parts must fit
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
  "registerSpecies" | "spawn" | "despawn"
> {
  /** The creatures in the world now, from the latest snapshot. */
  creatures(): readonly { id: string; speciesId: string }[];
  /**
   * What is wrong with a voxel assembly's part and socket types in this world: types that aren't
   * registered and parts that don't fit their sockets (`checkAssemblyTypes`).
   */
  checkAssembly(assembly: VoxelAssembly): Promise<Diagnostic[]>;
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

/** The asset kind a library species' appearance registers as. */
const APPEARANCE_KINDS = { drawn: "image", voxel: "voxel" } as const satisfies Record<
  LibraryBodyKind,
  string
>;

/**
 * The file the world draws a species from: a drawn one's PNG, or a voxel one's assembly as JSON,
 * made from the entry, which holds it inline (ADR 0022 §17).
 */
const appearanceBlob = (body: LibraryBody, image: Uint8Array | undefined): Blob =>
  body.kind === "voxel"
    ? new Blob([JSON.stringify(body.assembly)], { type: "application/json" })
    : new Blob([image?.slice() ?? new Uint8Array()], { type: "image/png" });

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

  /**
   * Registers `entry`'s species from its appearance, a drawn one's image or a voxel one's
   * assembly, and keeps it in the list.
   */
  const register = async (uuid: string, entry: LibraryEntry, image?: Uint8Array) => {
    const url = URL.createObjectURL(appearanceBlob(entry.body, image));
    const registered = await world.registerSpecies(
      entry.species,
      url,
      APPEARANCE_KINDS[entry.body.kind],
    );
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
    const registered = await register(uuid, entry, drawn?.image);
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
    let image;
    try {
      if (entry.body.kind === "drawn") image = await store.loadImage(id);
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
        ...structuredClone(DRAWN_SPECIES_DEFAULTS),
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

    async saveVoxel(assemblyInput, name, plan, { id = uuid() } = {}) {
      const assembly = validate(VoxelAssemblySchema, assemblyInput);
      if (!assembly.ok) return assembly;
      const fresh = freshIds(id);
      if (!fresh.ok) return fresh;
      const ids = fresh.value;
      // Measured from the cubes (ADR 0022 §3); the part type roles it can take move only the tail.
      const { sizeClass } = measureAssembly(assembly.value);
      if (!sizeClass) return failure("too_large", `${name} is too large for every size class`);
      // Fits are checked at release only (ADR 0022, M19 decisions).
      const misfits = await world.checkAssembly(assembly.value);
      if (misfits.some((d) => d.severity === "error")) return { ok: false, diagnostics: misfits };
      const species: SpeciesDefinitionInput = {
        // First, so the app defaults never override the plan or anything below.
        ...structuredClone(DRAWN_SPECIES_DEFAULTS),
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
