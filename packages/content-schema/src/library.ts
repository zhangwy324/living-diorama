import { z } from "zod";
import {
  SpeciesDefinitionSchema,
  writtenDrawnOnlySettings,
  type BodyShape,
  type SpeciesDefinition,
} from "./definitions";
import type { Result } from "./diagnostics";
import { VoxelAssemblySchema, measureAssembly } from "./voxel-assembly";
import { migrate, type Migration } from "./migrate";
import { validate } from "./parse";
import { HexColorSchema } from "./primitives";

// Files of the species library (roadmap M10): what the player drew, and the species made from it.
// Each is migrated to the current version before it is validated, so a later release can add
// data by adding a migration (ADR 0014).

/** Current data-format version of a drawing. */
export const DRAWING_SCHEMA_VERSION = 2;
/** Current data-format version of a library entry. */
export const LIBRARY_ENTRY_SCHEMA_VERSION = 5;

const DRAWING_MIGRATIONS: Readonly<Record<number, Migration>> = {
  // Version 1 held the strokes as the source of truth. Version 2 holds a record of operations
  // beside the image, which is the drawing (ADR 0014 §5 amendment): each stroke becomes a stroke
  // operation, in the same order.
  1: ({ strokes, ...data }) => ({
    ...data,
    history: Array.isArray(strokes)
      ? strokes.map((stroke: unknown) =>
          typeof stroke === "object" && stroke !== null ? { kind: "stroke", ...stroke } : stroke,
        )
      : strokes,
  }),
};

// Version 3 adds the body plan (ADR 0020 §13); version 4 drops its template (ADR 0020, Follow-up:
// no body templates); version 5 adds the body, drawn or voxel (ADR 0022 §17). Older entries are
// not migrated: no backward compatibility is required yet (AGENTS.md), so they fail to load.
const LIBRARY_ENTRY_MIGRATIONS: Readonly<Record<number, Migration>> = {};

/** Values per stroke point: x and y in canvas pixels, then pressure. */
export const STROKE_POINT_STRIDE = 3;

/** One stroke as drawn. An eraser stroke removes what is under it. */
export const StrokeSchema = z.strictObject({
  kind: z.literal("stroke"),
  tool: z.enum(["pen", "eraser"]),
  color: HexColorSchema,
  /** Width in canvas pixels at full pressure. */
  width: z.number().positive(),
  /** Flat `[x, y, pressure, x, y, pressure, …]`, pressure from 0 to 1. */
  points: z
    .array(z.number())
    .min(STROKE_POINT_STRIDE, { error: "A stroke needs at least one point" })
    .refine((points) => points.length % STROKE_POINT_STRIDE === 0, {
      error: "Points come in threes: x, y, pressure",
    })
    .refine(
      (points) =>
        points.every((value, i) => i % STROKE_POINT_STRIDE !== 2 || (value >= 0 && value <= 1)),
      { error: "Pressure must be between 0 and 1" },
    ),
});
export type Stroke = z.output<typeof StrokeSchema>;

/**
 * One click of the fill tool (ADR 0017 §10): the pixel clicked and the colour it filled with.
 * Whether it filled the background or recoloured follows from the image at that pixel, so it isn't
 * stored.
 */
export const FillSchema = z.strictObject({
  kind: z.literal("fill"),
  /** The pixel clicked, in canvas pixels from the top left. */
  x: z.int().nonnegative(),
  y: z.int().nonnegative(),
  color: HexColorSchema,
});
export type Fill = z.output<typeof FillSchema>;

/** One operation of the drawing record, told apart by `kind`: a stroke or a fill. */
export const DrawingOperationSchema = z.discriminatedUnion("kind", [StrokeSchema, FillSchema]);
export type DrawingOperation = z.output<typeof DrawingOperationSchema>;

/**
 * How a drawing was made. The image stored beside it is the drawing itself (ADR 0014 §5
 * amendment); this is a record only and is never replayed to make the image, so a change to how
 * strokes are drawn can't change a saved creature.
 */
export const DrawingSchema = z.strictObject({
  schemaVersion: z.literal(DRAWING_SCHEMA_VERSION),
  /** The image's size; operations are in its pixels. */
  canvas: z.strictObject({ width: z.int().positive(), height: z.int().positive() }),
  /**
   * The operations that made the image, in order, since the canvas was last empty. Undone
   * operations are not in it.
   */
  history: z.array(DrawingOperationSchema),
});
export type Drawing = z.output<typeof DrawingSchema>;

/**
 * What a library species' body is made of: a drawing, stored beside the entry with its image, or
 * a voxel assembly, held inline as frozen copies of its parts (ADR 0022 §17).
 */
export const LibraryBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("drawn") }),
  z.strictObject({ kind: z.literal("voxel"), assembly: VoxelAssemblySchema }),
]);
export type LibraryBody = z.output<typeof LibraryBodySchema>;
export type LibraryBodyKind = LibraryBody["kind"];

/** The file a library species' appearance names, per kind of body. */
export const LIBRARY_APPEARANCE_FILES = {
  drawn: "appearance.png",
  voxel: "assembly.json",
} as const satisfies Record<LibraryBodyKind, string>;

/**
 * The appearance a library species of `speciesId` (e.g. `user:3f9c…`) has: its image for a drawn
 * body, `user:3f9c…/appearance.png`, or its assembly for a voxel one, `user:3f9c…/assembly.json`.
 */
export const libraryAppearance = (speciesId: string, kind: LibraryBodyKind): string =>
  `${speciesId}/${LIBRARY_APPEARANCE_FILES[kind]}`;

/**
 * Rejects drawn-only body plan settings on a voxel species, as written. Parsing the species fills
 * in their defaults, so the parsed entry drops them again (`dropDrawnOnlySettings`).
 */
function checkVoxelBodyPlan(input: unknown, ctx: z.RefinementCtx): void {
  if (typeof input !== "object" || input === null) return;
  const entry = input as { body?: { kind?: unknown }; species?: unknown };
  if (entry.body?.kind !== "voxel") return;
  for (const setting of writtenDrawnOnlySettings(entry.species)) {
    ctx.addIssue({
      code: "custom",
      message: `A voxel species has no ${setting}: its cubes give it`,
      path: ["species", "body", setting],
    });
  }
}

const LibraryEntryShapeSchema = z
  .strictObject({
    schemaVersion: z.literal(LIBRARY_ENTRY_SCHEMA_VERSION),
    /** The name shown to the player is the species' name. */
    species: SpeciesDefinitionSchema,
    body: LibraryBodySchema,
    createdAt: z.iso.datetime({ offset: true }),
  })
  .superRefine(
    ({ species, body }, ctx) => {
      const appearance = libraryAppearance(species.id, body.kind);
      if (species.appearance !== appearance) {
        ctx.addIssue({
          code: "custom",
          message: `A ${body.kind} species' appearance is "${appearance}"`,
          path: ["species", "appearance"],
        });
      }
      if (body.kind !== "voxel") return;
      // The size class is stored, and must be the one the cubes give (ADR 0022 §3).
      const { sizeClass } = measureAssembly(body.assembly);
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
  )
  .transform(dropDrawnOnlySettings);

/** A voxel library species' body plan: its gait alone (ADR 0022, M19 decisions). */
export type VoxelBodyPlan = Pick<BodyShape, "locomotion">;

/**
 * A parsed voxel entry without the drawn-only body settings the species schema filled in, so it
 * is an entry as written: it validates again and can be stored again as it is.
 */
function dropDrawnOnlySettings<E extends { species: SpeciesDefinition; body: LibraryBody }>(
  entry: E,
):
  | (E & { body: { kind: "drawn" } })
  | (Omit<E, "species"> & {
      species: Omit<SpeciesDefinition, "body"> & { body: VoxelBodyPlan };
      body: Extract<LibraryBody, { kind: "voxel" }>;
    }) {
  if (entry.body.kind !== "voxel") return entry as E & { body: { kind: "drawn" } };
  const { locomotion } = entry.species.body;
  return {
    ...entry,
    species: { ...entry.species, body: { locomotion } },
    body: entry.body,
  };
}

/**
 * A species in the library, drawn or voxel. A drawn one's drawing and image are stored beside it;
 * a voxel one holds its assembly in `body`, and its species' body plan is its gait alone.
 */
export const LibraryEntrySchema = z
  .unknown()
  .superRefine(checkVoxelBodyPlan)
  .pipe(LibraryEntryShapeSchema);
export type LibraryEntry = z.output<typeof LibraryEntrySchema>;

function parseMigrated<T>(
  kind: string,
  schema: z.ZodType<T>,
  current: number,
  migrations: Readonly<Record<number, Migration>>,
  input: unknown,
  source?: string,
): Result<T> {
  const migrated = migrate(kind, input, current, migrations, source);
  return migrated.ok ? validate(schema, migrated.value, source) : migrated;
}

export const parseDrawing = (input: unknown, source?: string): Result<Drawing> =>
  parseMigrated(
    "drawing",
    DrawingSchema,
    DRAWING_SCHEMA_VERSION,
    DRAWING_MIGRATIONS,
    input,
    source,
  );

export const parseLibraryEntry = (input: unknown, source?: string): Result<LibraryEntry> =>
  parseMigrated(
    "library entry",
    LibraryEntrySchema,
    LIBRARY_ENTRY_SCHEMA_VERSION,
    LIBRARY_ENTRY_MIGRATIONS,
    input,
    source,
  );
