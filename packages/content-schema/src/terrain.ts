import { z } from "zod";
import { AssetRefSchema, LocalIdSchema } from "./primitives";

// Grid layout and sampling rules: docs/world-coordinates.md, "Heightfield grid".

const GridSchema = {
  columns: z.int().min(2),
  rows: z.int().min(2),
  cellSize: z.number().positive(),
};

const InlineHeightsSchema = z.strictObject({
  source: z.literal("inline"),
  ...GridSchema,
  /** Row-major heights in metres, rows from min.z to max.z. */
  heights: z.array(z.number()),
});

const AssetHeightsSchema = z.strictObject({
  source: z.literal("asset"),
  ...GridSchema,
  asset: AssetRefSchema,
  /** `png16`: 16-bit grayscale PNG; `r16`: raw little-endian uint16. */
  format: z.enum(["png16", "r16"]),
  /** Decoded height: `heightOffset + raw * heightScale`. */
  heightScale: z.number().positive(),
  heightOffset: z.number().default(0),
});

export const HeightfieldSchema = z.discriminatedUnion("source", [
  InlineHeightsSchema,
  AssetHeightsSchema,
]);
export type Heightfield = z.output<typeof HeightfieldSchema>;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const MaterialZoneSchema = z.strictObject({
  name: LocalIdSchema,
  color: z.string().regex(HEX_COLOR, { error: 'Expected a colour like "#7fae5a"' }),
});

/** One palette index per heightfield sample, same layout as the heights. */
export const MaterialZonesSchema = z.strictObject({
  palette: z.array(MaterialZoneSchema).min(1),
  indices: z.discriminatedUnion("source", [
    z.strictObject({ source: z.literal("inline"), values: z.array(z.int().nonnegative()) }),
    z.strictObject({ source: z.literal("asset"), asset: AssetRefSchema, format: z.enum(["png8"]) }),
  ]),
});
export type MaterialZones = z.output<typeof MaterialZonesSchema>;

export const TerrainDefinitionSchema = z
  .strictObject({
    heightfield: HeightfieldSchema,
    materials: MaterialZonesSchema,
  })
  .superRefine((terrain, ctx) => {
    const { heightfield, materials } = terrain;
    const samples = heightfield.columns * heightfield.rows;
    if (heightfield.source === "inline" && heightfield.heights.length !== samples) {
      ctx.addIssue({
        code: "custom",
        message: `Expected ${samples} heights (${heightfield.columns} columns × ${heightfield.rows} rows), got ${heightfield.heights.length}`,
        path: ["heightfield", "heights"],
      });
    }
    if (materials.indices.source === "inline") {
      const { values } = materials.indices;
      if (values.length !== samples) {
        ctx.addIssue({
          code: "custom",
          message: `Expected ${samples} material indices to match the heightfield, got ${values.length}`,
          path: ["materials", "indices", "values"],
        });
      }
      const bad = values.findIndex((v) => v >= materials.palette.length);
      if (bad !== -1) {
        ctx.addIssue({
          code: "custom",
          message: `Material index ${values[bad]} is outside the palette (${materials.palette.length} zones)`,
          path: ["materials", "indices", "values", bad],
        });
      }
    }
  });
export type TerrainDefinition = z.output<typeof TerrainDefinitionSchema>;
