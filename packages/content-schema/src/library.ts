import { z } from "zod";
import { SCHEMA_VERSIONS } from "./constants";
import { SpeciesDefinitionSchema } from "./definitions";
import type { Result } from "./diagnostics";
import { VoxelAssemblySchema, measureAssembly } from "./voxel-assembly";
import { migrate, type Migration } from "./migrate";
import { validate } from "./parse";

// The species library's entries (roadmap M10, ADR 0014): each a species the player built, with its
// voxel assembly. An entry is migrated to the current version before it is validated, so a later
// release can add data by adding a migration.

/** Current data-format version of a library entry. */
export const LIBRARY_ENTRY_SCHEMA_VERSION = 7;

// Version 3 adds the body plan (ADR 0020 §13); version 4 drops its template (ADR 0020, Follow-up:
// no body templates); version 5 adds the body, drawn or voxel (ADR 0022 §17); version 6 holds only
// a voxel assembly, as drawn bodies are gone (M23); version 7 holds a species of schema version 2,
// whose body plan has lost the drawn-only thickness and anchors (M23), which a voxel entry never
// held. Entries before version 6 are not migrated: no backward compatibility is required yet
// (AGENTS.md), so they fail to load.
const LIBRARY_ENTRY_MIGRATIONS: Readonly<Record<number, Migration>> = {
  6: (entry) => ({
    ...entry,
    species: { ...(entry.species as object), schemaVersion: SCHEMA_VERSIONS.species },
  }),
};

/**
 * The appearance a library species of `speciesId` (e.g. `user:3f9c…`) has: its assembly,
 * `user:3f9c…/assembly.json`, which its entry holds inline (ADR 0022 §17).
 */
export const libraryAppearance = (speciesId: string): string => `${speciesId}/assembly.json`;

/**
 * A species in the library: it holds its voxel assembly as frozen copies of its parts (ADR 0022
 * §17), and its species' body plan is its gait alone.
 */
export const LibraryEntrySchema = z
  .strictObject({
    schemaVersion: z.literal(LIBRARY_ENTRY_SCHEMA_VERSION),
    /** The name shown to the player is the species' name. */
    species: SpeciesDefinitionSchema,
    assembly: VoxelAssemblySchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .superRefine(
    ({ species, assembly }, ctx) => {
      const appearance = libraryAppearance(species.id);
      if (species.appearance !== appearance) {
        ctx.addIssue({
          code: "custom",
          message: `A library species' appearance is "${appearance}"`,
          path: ["species", "appearance"],
        });
      }
      // The size class is stored, and must be the one the cubes give (ADR 0022 §3).
      const { sizeClass } = measureAssembly(assembly);
      if (sizeClass !== species.sizeClass) {
        ctx.addIssue({
          code: "custom",
          message:
            sizeClass === undefined
              ? "The body is too large for every size class"
              : `The body's size class is ${sizeClass}, not ${species.sizeClass}`,
          path: ["species", "sizeClass"],
        });
      }
    },
    { when: ({ issues }) => issues.length === 0 },
  );
export type LibraryEntry = z.output<typeof LibraryEntrySchema>;

export function parseLibraryEntry(input: unknown, source?: string): Result<LibraryEntry> {
  const migrated = migrate(
    "library entry",
    input,
    LIBRARY_ENTRY_SCHEMA_VERSION,
    LIBRARY_ENTRY_MIGRATIONS,
    source,
  );
  return migrated.ok ? validate(LibraryEntrySchema, migrated.value, source) : migrated;
}
