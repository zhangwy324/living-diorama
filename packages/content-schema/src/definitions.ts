import { z } from "zod";
import { SCHEMA_VERSIONS, SIZE_CLASSES, WORLD_TOLERANCES } from "./constants";
import {
  AssetRefSchema,
  ContentIdSchema,
  LocalIdSchema,
  RegionPositionSchema,
  SemverSchema,
  TransformSchema,
  Vec3Schema,
  type Vec2,
} from "./primitives";
import { ConnectionDefinitionSchema, RegionDefinitionSchema } from "./region";
import { TerrainDefinitionSchema } from "./terrain";

const header = <K extends keyof typeof SCHEMA_VERSIONS>(kind: K) => ({
  schemaVersion: z.literal(SCHEMA_VERSIONS[kind]),
  id: ContentIdSchema,
  version: SemverSchema,
  name: z.string().min(1),
});

/**
 * What a structure or prop type offers: affordance → its params, e.g.
 * `{ "core:food": { "eatSeconds": 5 } }` (ADR 0018 §2). The params are checked against the
 * affordance type's params schema when references resolve.
 */
export const AffordancesSchema = z.record(ContentIdSchema, z.unknown()).default({});
export type Affordances = z.output<typeof AffordancesSchema>;

/** A registered structure type, e.g. a wooden bridge (ADR 0002 §5). */
export const StructureDefinitionSchema = z.strictObject({
  ...header("structure"),
  visualAssets: z.array(AssetRefSchema).default([]),
  /** What the structure offers, e.g. `{ "core:crossable": {} }`. */
  affordances: AffordancesSchema,
});
export type StructureDefinition = z.output<typeof StructureDefinitionSchema>;

/**
 * A registered prop type, e.g. a pine or a mushroom (ADR 0018 §3). A world's placements name it
 * and add only where it stands.
 */
export const PropDefinitionSchema = z.strictObject({
  ...header("prop"),
  model: AssetRefSchema,
  /**
   * Creatures can't stand within this distance of a placement's position, in metres at scale 1:
   * a placement blocks `blockRadius × transform.scale` (ADR 0018 §3, amending ADR 0005 §8).
   */
  blockRadius: z.number().nonnegative(),
  /** What the prop offers, e.g. `{ "core:food": { "eatSeconds": 5 } }`. */
  affordances: AffordancesSchema,
});
export type PropDefinition = z.output<typeof PropDefinitionSchema>;

/** Params of an affordance that takes none, e.g. `core:crossable` or `core:shelter`. */
export const EmptyAffordanceParamsSchema = z.strictObject({});
export type EmptyAffordanceParams = z.output<typeof EmptyAffordanceParamsSchema>;

/** Params of `core:food` (ADR 0018 §2): how long a creature eats there, in seconds. */
export const FoodAffordanceParamsSchema = z.strictObject({ eatSeconds: z.number().positive() });
export type FoodAffordanceParams = z.output<typeof FoodAffordanceParamsSchema>;

export const SizeClassSchema = z.enum(
  Object.keys(SIZE_CLASSES) as [keyof typeof SIZE_CLASSES, ...(keyof typeof SIZE_CLASSES)[]],
);

/**
 * The range of a body's depth from front to back, as a share of its drawn height (ADR 0017 §11).
 * The default is the depth every body had before it could be chosen.
 */
export const BODY_THICKNESS = { min: 0.1, max: 0.8, default: 0.4 } as const;

/** How a species' body is built from its appearance (ADR 0011, ADR 0017). */
export const BodyShapeSchema = z.strictObject({
  /** Depth from front to back as a share of the drawn height. */
  thickness: z
    .number()
    .gte(BODY_THICKNESS.min, {
      error: `Thickness must be at least ${BODY_THICKNESS.min} of the height`,
    })
    .lte(BODY_THICKNESS.max, {
      error: `Thickness must be at most ${BODY_THICKNESS.max} of the height`,
    })
    .default(BODY_THICKNESS.default),
});
export type BodyShape = z.output<typeof BodyShapeSchema>;

export const SpeciesDefinitionSchema = z.strictObject({
  ...header("species"),
  appearance: AssetRefSchema,
  sizeClass: SizeClassSchema,
  /** Left out, every setting takes its default. */
  body: BodyShapeSchema.prefault({}),
  /** Locomotion and other capabilities → speed factor relative to `baseSpeed` (ADR 0004). */
  capabilities: z
    .record(ContentIdSchema, z.number().positive())
    .refine((caps) => Object.keys(caps).length > 0, {
      error: "A species needs at least one capability",
    }),
  /** Metres per second at capability factor 1. */
  baseSpeed: z.number().positive(),
  behaviors: z.array(ContentIdSchema).min(1, { error: "A species needs at least one behavior" }),
  /**
   * Sense → strength, e.g. `core:vision` → range in metres (ADR 0018 §4). A sense left out is one
   * the creature lacks. Values are checked against the sense's registered range.
   */
  senses: z.record(ContentIdSchema, z.number()).default({}),
  /** Trait → value. A trait left out takes the default its registry entry declares. */
  traits: z.record(ContentIdSchema, z.number()).default({}),
});
export type SpeciesDefinition = z.output<typeof SpeciesDefinitionSchema>;

/** A structure instance and the regions/connections it contributes, in world space. */
export const StructurePlacementSchema = z.strictObject({
  id: LocalIdSchema,
  structure: ContentIdSchema,
  transform: TransformSchema,
  regions: z.array(RegionDefinitionSchema).default([]),
  connections: z.array(ConnectionDefinitionSchema).default([]),
});
export type StructurePlacement = z.output<typeof StructurePlacementSchema>;

/**
 * A prop in a world. Its type (`prop`) gives the model, block radius and affordances; the
 * placement adds where it stands. `transform.scale` scales the type's block radius too.
 */
export const PropPlacementSchema = z.strictObject({
  id: LocalIdSchema,
  prop: ContentIdSchema,
  transform: TransformSchema,
});
export type PropPlacement = z.output<typeof PropPlacementSchema>;

export const SpawnPointSchema = z.strictObject({
  id: LocalIdSchema,
  position: RegionPositionSchema,
  heading: z.number().default(0),
});
export type SpawnPoint = z.output<typeof SpawnPointSchema>;

export const WorldBoundsSchema = z.strictObject({ min: Vec3Schema, max: Vec3Schema });
export type WorldBounds = z.output<typeof WorldBoundsSchema>;

export const WorldDefinitionSchema = z
  .strictObject({
    ...header("world"),
    bounds: WorldBoundsSchema,
    terrain: TerrainDefinitionSchema,
    regions: z.array(RegionDefinitionSchema).min(1),
    connections: z.array(ConnectionDefinitionSchema).default([]),
    structures: z.array(StructurePlacementSchema).default([]),
    props: z.array(PropPlacementSchema).default([]),
    spawnPoints: z
      .array(SpawnPointSchema)
      .min(1, { error: "A world needs at least one spawn point" }),
  })
  .superRefine((world, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: "custom", message, path });
    const { min, max } = world.bounds;
    const eps = WORLD_TOLERANCES.positionEpsilon;

    for (const axis of ["x", "y", "z"] as const) {
      if (!(min[axis] < max[axis])) {
        issue(`bounds.min.${axis} must be less than bounds.max.${axis}`, ["bounds"]);
        return;
      }
    }

    const hf = world.terrain.heightfield;
    const coverX = (hf.columns - 1) * hf.cellSize;
    const coverZ = (hf.rows - 1) * hf.cellSize;
    if (Math.abs(coverX - (max.x - min.x)) > eps || Math.abs(coverZ - (max.z - min.z)) > eps) {
      issue(
        `Heightfield covers ${coverX} × ${coverZ} m but the bounds are ${max.x - min.x} × ${max.z - min.z} m`,
        ["terrain", "heightfield"],
      );
    }
    if (hf.source === "inline") {
      const bad = hf.heights.findIndex((h) => h < min.y || h > max.y);
      if (bad !== -1) {
        issue(`Height ${hf.heights[bad]} is outside bounds Y [${min.y}, ${max.y}]`, [
          "terrain",
          "heightfield",
          "heights",
          bad,
        ]);
      }
    }

    const inside = (p: Vec2, path: (string | number)[]) => {
      if (p.x < min.x - eps || p.x > max.x + eps || p.z < min.z - eps || p.z > max.z + eps) {
        issue(`Position (${p.x}, ${p.z}) is outside the world bounds`, path);
      }
    };

    // Every local ID shares one namespace, including structure-contributed regions.
    const seen = new Map<string, string>();
    const claim = (id: string, path: (string | number)[]) => {
      const first = seen.get(id);
      if (first !== undefined) issue(`Duplicate ID "${id}" (first used at ${first})`, path);
      else seen.set(id, path.join("."));
    };

    const regions = [
      ...world.regions.map((r, i) => ({ region: r, path: ["regions", i] })),
      ...world.structures.flatMap((s, si) =>
        s.regions.map((r, i) => ({ region: r, path: ["structures", si, "regions", i] })),
      ),
    ];
    const connections = [
      ...world.connections.map((c, i) => ({ connection: c, path: ["connections", i] })),
      ...world.structures.flatMap((s, si) =>
        s.connections.map((c, i) => ({
          connection: c,
          path: ["structures", si, "connections", i],
        })),
      ),
    ];

    for (const { region, path } of regions) {
      claim(region.id, [...path, "id"]);
      region.footprint.forEach((p, i) => inside(p, [...path, "footprint", i]));
    }
    const regionIds = new Set(regions.map(({ region }) => region.id));

    for (const { connection, path } of connections) {
      claim(connection.id, [...path, "id"]);
      for (const end of ["from", "to"] as const) {
        if (!regionIds.has(connection[end])) {
          issue(`Unknown region "${connection[end]}"`, [...path, end]);
        }
      }
      inside(connection.portal.a, [...path, "portal", "a"]);
      inside(connection.portal.b, [...path, "portal", "b"]);
    }

    world.structures.forEach((s, i) => {
      claim(s.id, ["structures", i, "id"]);
      inside(s.transform.position, ["structures", i, "transform", "position"]);
    });
    world.props.forEach((p, i) => {
      claim(p.id, ["props", i, "id"]);
      inside(p.transform.position, ["props", i, "transform", "position"]);
    });
    world.spawnPoints.forEach((s, i) => {
      claim(s.id, ["spawnPoints", i, "id"]);
      if (!regionIds.has(s.position.regionId)) {
        issue(`Unknown region "${s.position.regionId}"`, [
          "spawnPoints",
          i,
          "position",
          "regionId",
        ]);
      }
      inside(s.position, ["spawnPoints", i, "position"]);
    });
  });
export type WorldDefinition = z.output<typeof WorldDefinitionSchema>;

/** All regions of a world, including those contributed by structure placements. */
export function allRegions(world: WorldDefinition) {
  return [...world.regions, ...world.structures.flatMap((s) => s.regions)];
}

/** All connections of a world, including those contributed by structure placements. */
export function allConnections(world: WorldDefinition) {
  return [...world.connections, ...world.structures.flatMap((s) => s.connections)];
}
