import { z } from "zod";
import { SpeciesDefinitionSchema } from "./definitions";
import type { Result } from "./diagnostics";
import { migrate, type Migration } from "./migrate";
import { validate } from "./parse";
import { HexColorSchema } from "./primitives";

// Files of the species library (roadmap M10): what the player drew, and the species made from it.
// Each is migrated to the current version before it is validated, so a later release can add
// data by adding a migration (ADR 0014).

/** Current data-format version of a drawing. */
export const DRAWING_SCHEMA_VERSION = 2;
/** Current data-format version of a library entry. */
export const LIBRARY_ENTRY_SCHEMA_VERSION = 3;

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

// Version 3 adds the body plan (ADR 0020 §13). Entries of versions 1 and 2 are not migrated: no
// backward compatibility is required yet (AGENTS.md), so they fail to load.
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

/** A drawn species in the library. Its drawing and image are stored beside it. */
export const LibraryEntrySchema = z.strictObject({
  schemaVersion: z.literal(LIBRARY_ENTRY_SCHEMA_VERSION),
  /** The name shown to the player is the species' name. */
  species: SpeciesDefinitionSchema,
  createdAt: z.iso.datetime({ offset: true }),
});
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
