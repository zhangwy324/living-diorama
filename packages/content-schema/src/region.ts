import { z } from "zod";
import {
  ContentIdSchema,
  LocalIdSchema,
  PolygonSchema,
  Vec2Schema,
  Vec3Schema,
} from "./primitives";

export const RegionKindSchema = z.enum(["land", "water", "cave", "air"]);
export type RegionKind = z.output<typeof RegionKindSchema>;

/** Params are validated against the registered surface type's own schema. */
export const SurfaceRefSchema = z.strictObject({
  type: ContentIdSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});
export type SurfaceRef = z.output<typeof SurfaceRefSchema>;

/** Params of the v1 `heightfield` surface: it samples the world terrain. */
export const HeightfieldSurfaceParamsSchema = z.strictObject({});
export type HeightfieldSurfaceParams = z.output<typeof HeightfieldSurfaceParamsSchema>;

/** Params of the v1 `deck` surface: a strip along a world-space centerline. */
export const DeckSurfaceParamsSchema = z.strictObject({
  centerline: z.array(Vec3Schema).min(2, { error: "A deck centerline needs at least 2 points" }),
  width: z.number().positive(),
});
export type DeckSurfaceParams = z.output<typeof DeckSurfaceParamsSchema>;

export const RegionDefinitionSchema = z.strictObject({
  id: LocalIdSchema,
  kind: RegionKindSchema,
  surface: SurfaceRefSchema,
  footprint: PolygonSchema,
});
export type RegionDefinition = z.output<typeof RegionDefinitionSchema>;

/** XZ segment where a creature crosses between two regions. */
export const PortalSchema = z.strictObject({ a: Vec2Schema, b: Vec2Schema });
export type Portal = z.output<typeof PortalSchema>;

export const ConnectionDefinitionSchema = z
  .strictObject({
    id: LocalIdSchema,
    from: LocalIdSchema,
    to: LocalIdSchema,
    portal: PortalSchema,
    bidirectional: z.boolean().default(true),
    /** A creature needs all of these to traverse (ADR 0004). */
    requiredCapabilities: z
      .array(ContentIdSchema)
      .min(1, { error: "A connection must require at least one capability" }),
    /** Extra cost in metre-equivalents on top of the distance travelled. */
    cost: z.number().nonnegative().default(0),
  })
  .refine((c) => c.from !== c.to, {
    error: "A connection must link two different regions",
    path: ["to"],
  });
export type ConnectionDefinition = z.output<typeof ConnectionDefinitionSchema>;
