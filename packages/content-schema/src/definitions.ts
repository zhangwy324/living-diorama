import { z } from "zod";
import { SCHEMA_VERSIONS, SIZE_CLASSES, WORLD_TOLERANCES } from "./constants";
import {
  AssetRefSchema,
  ContentIdSchema,
  HexColorSchema,
  LocalIdSchema,
  RegionPositionSchema,
  SemverSchema,
  TransformSchema,
  Vec3Schema,
  type Vec2,
} from "./primitives";
import { ConnectionDefinitionSchema, RegionDefinitionSchema } from "./region";
import { TerrainDefinitionSchema } from "./terrain";
import { VoxelPartSchema } from "./voxel";

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
  /**
   * The prop category it is listed under in the editor's prop drawer, e.g. `hollow:trees`
   * (ADR 0021). An editor lists a prop type without one under "Other".
   */
  category: ContentIdSchema.optional(),
});
export type PropDefinition = z.output<typeof PropDefinitionSchema>;

/**
 * A registered prop category, e.g. trees or rocks: a tab of the editor's prop drawer (ADR 0021).
 * `name` is what the tab shows. Categories are listed by ascending `order`, then by ID.
 */
export const PropCategoryDefinitionSchema = z.strictObject({
  ...header("propCategory"),
  order: z.number(),
});
export type PropCategoryDefinition = z.output<typeof PropCategoryDefinitionSchema>;

/**
 * What a part type does for the engine, beyond fitting sockets (ADR 0022 §10): `tail` marks a
 * part whose attach point is the body's tail, and `root` a part a creature is built on, such as a
 * torso, which the Studio lists first and starts from (ADR 0023 §10). The role is what tools
 * offer, not a rule of the format: an assembly's root may be a part of any type (ADR 0022 §11).
 * Engine code reads roles, never part type IDs.
 */
export const PART_ROLES = ["tail", "root"] as const;
export type PartRole = (typeof PART_ROLES)[number];

/**
 * How a part of a type moves when its creature is animated (M22): `swing` (legs, arms), `wag`
 * (tails), `bob` (heads), `paddle` (fins), `flop` (ears) and `blink` (eyes). The renderer owns
 * what each looks like; a type without one stays still. Like roles, engine code reads motions,
 * never part type IDs.
 */
export const PART_MOTIONS = ["swing", "wag", "bob", "paddle", "flop", "blink"] as const;
export type PartMotion = (typeof PART_MOTIONS)[number];

/**
 * The view a player draws a part of a type in (M23): `side` (the creature seen from its side) or
 * `front` (seen from the front). The voxelizer owns how each maps onto the part's axes.
 */
export const PART_DRAWING_VIEWS = ["side", "front"] as const;
export type PartDrawingView = (typeof PART_DRAWING_VIEWS)[number];

/**
 * How a drawing of a part is given depth (M23): `puffy` (rounded, thickest away from its edges,
 * e.g. a body), `tube` (as deep as it is wide, e.g. a leg) or `flat` (one cube deep, e.g. an
 * ear). The player may switch rules while drawing.
 */
export const PART_DRAWING_RULES = ["puffy", "tube", "flat"] as const;
export type PartDrawingRule = (typeof PART_DRAWING_RULES)[number];

/** How a player draws a part of a type (M23): the view and the depth rule a drawing starts with. */
export const PartDrawingSchema = z.strictObject({
  view: z.enum(PART_DRAWING_VIEWS, {
    error: `Unknown drawing view (expected ${PART_DRAWING_VIEWS.join(", ")})`,
  }),
  rule: z.enum(PART_DRAWING_RULES, {
    error: `Unknown drawing rule (expected ${PART_DRAWING_RULES.join(", ")})`,
  }),
});
export type PartDrawing = z.output<typeof PartDrawingSchema>;

/** The drawing recipe of a part type that doesn't set one: flat, drawn from the side. */
export const DEFAULT_PART_DRAWING: Readonly<PartDrawing> = Object.freeze({
  view: "side",
  rule: "flat",
});

/**
 * A registered voxel part type, e.g. a leg or an eye (ADR 0022 §10). A part of this type fits a
 * socket whose type is in `fits`, which may name another pack's socket types.
 */
export const PartTypeDefinitionSchema = z.strictObject({
  ...header("partType"),
  /** The socket types a part of this type fits. Left empty, it can only be an assembly's root. */
  fits: z.array(ContentIdSchema).default([]),
  role: z
    .enum(PART_ROLES, { error: `Unknown part role (expected ${PART_ROLES.join(", ")})` })
    .optional(),
  /** How parts of this type move. Left out, they don't. */
  motion: z
    .enum(PART_MOTIONS, { error: `Unknown part motion (expected ${PART_MOTIONS.join(", ")})` })
    .optional(),
  /** How a player draws a part of this type. Left out, `DEFAULT_PART_DRAWING`. */
  drawing: PartDrawingSchema.optional(),
});
export type PartTypeDefinition = z.output<typeof PartTypeDefinitionSchema>;

/** A registered socket type, e.g. a hip or a neck (ADR 0022 §10): a kind of place parts hang from. */
export const SocketTypeDefinitionSchema = z.strictObject({ ...header("socketType") });
export type SocketTypeDefinition = z.output<typeof SocketTypeDefinitionSchema>;

/**
 * A registered palette of suggested colours (ADR 0022 §4, ADR 0023 §11): plain sRGB colours the
 * Studio offers for recolouring parts, beside a free colour picker. Nothing limits a part to them.
 * Each colour is listed once, ignoring case.
 */
export const PaletteDefinitionSchema = z
  .strictObject({
    ...header("palette"),
    colors: z.array(HexColorSchema).min(1, { error: "A palette needs at least one colour" }),
  })
  .superRefine(({ colors }, ctx) => {
    const seen = new Set<string>();
    colors.forEach((color, i) => {
      const key = color.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", message: `${color} is listed twice`, path: ["colors", i] });
      }
      seen.add(key);
    });
  });
export type PaletteDefinition = z.output<typeof PaletteDefinitionSchema>;

/**
 * A registered voxel part, e.g. a starter leg (ADR 0022 §17, M20): a part a creature can be built
 * from, held inline. An assembly that uses it holds a frozen copy of `part`, with this ID as the
 * copy's `source`, so the part itself has none. Its part type and socket types are checked when
 * references resolve.
 */
export const PartDefinitionSchema = z
  .strictObject({
    ...header("part"),
    /**
     * Whether the Studio starts a new creature from this part (ADR 0023 §10). Meant for a part of
     * a `root` type; the Studio ignores it on any other. When several parts say so, the first by
     * ID wins, so the choice never depends on the order packs load in.
     */
    starter: z.boolean().optional(),
    part: VoxelPartSchema,
  })
  .superRefine(({ part }, ctx) => {
    if (part.source !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A registered part has no source: it is the source of the copies made from it",
        path: ["part", "source"],
      });
    }
  });
export type PartDefinition = z.output<typeof PartDefinitionSchema>;

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

/**
 * A drawing's width and height in pixels: the body image (ADR 0011 §1, ADR 0017 §8). Anchors are
 * stored in these pixels (ADR 0020 §10).
 */
export const DRAWING_SIZE = 256;

/** The ways a creature can move on land (ADR 0020 §1). A gait is a style, not a capability. */
export const LAND_GAITS = ["walk", "hop"] as const;
export type LandGait = (typeof LAND_GAITS)[number];

/**
 * How a species moves within each medium, one style per medium (ADR 0020 §11). Only land has a
 * style for now, its gait; a water style will sit beside it as `water`. Where a species can move
 * is not here but in its `capabilities`, so the land gait is used only when the species has a land
 * capability.
 */
export const BodyLocomotionSchema = z.strictObject({
  land: z
    .strictObject({
      gait: z
        .enum(LAND_GAITS, {
          error: `Unknown land gait (expected one of ${LAND_GAITS.join(", ")})`,
        })
        .default("walk"),
    })
    .prefault({}),
});
export type BodyLocomotion = z.output<typeof BodyLocomotionSchema>;

/**
 * A medium the body plan gives a style for, e.g. `land`. A capability's locomotion rule can name
 * one to take its animation profile from the species' style there (ADR 0020 §8).
 */
export type LocomotionMedium = keyof BodyLocomotion;
export const LOCOMOTION_MEDIA = Object.keys(
  BodyLocomotionSchema.shape,
) as readonly LocomotionMedium[];

/**
 * The named points on a body (ADR 0020 §10): the center of gravity, which land movement tilts and
 * squashes about, and the tail, which sets the swim's axis. Every species may have both, and each
 * is optional.
 */
export const ANCHOR_NAMES = ["centerOfGravity", "tail"] as const;
export type AnchorName = (typeof ANCHOR_NAMES)[number];

const drawingPixel = (axis: "x" | "y") => {
  const error = `An anchor's ${axis} must be within the drawing, 0 to ${DRAWING_SIZE}`;
  return z.number().gte(0, { error }).lte(DRAWING_SIZE, { error });
};

/** A point on the drawing, in its pixels from the top left (ADR 0020 §10). */
export const AnchorSchema = z.strictObject({ x: drawingPixel("x"), y: drawingPixel("y") });
export type Anchor = z.output<typeof AnchorSchema>;

/**
 * The anchors the player placed, by name. An anchor left out sits where `defaultAnchor` puts it.
 */
export const AnchorsSchema = z.strictObject(
  Object.fromEntries(ANCHOR_NAMES.map((name) => [name, AnchorSchema.optional()])) as Record<
    AnchorName,
    z.ZodOptional<typeof AnchorSchema>
  >,
);
export type Anchors = z.output<typeof AnchorsSchema>;

/**
 * A species' body plan: how its body is built from its appearance (ADR 0011, ADR 0017 §11) and how
 * it moves (ADR 0020 §11). Where it can move is in its capabilities, not here. The gait has a
 * default, so a species without a body plan walks. The drawn-only settings have none: left out,
 * they stay out, so the parsed species says what its pack wrote, and the renderer uses the default
 * thickness and anchors (ADR 0020 §13).
 */
export const BodyShapeSchema = z.strictObject({
  /** Depth from front to back as a share of the drawn height. Left out, `BODY_THICKNESS.default`. */
  thickness: z
    .number()
    .gte(BODY_THICKNESS.min, {
      error: `Thickness must be at least ${BODY_THICKNESS.min} of the height`,
    })
    .lte(BODY_THICKNESS.max, {
      error: `Thickness must be at most ${BODY_THICKNESS.max} of the height`,
    })
    .optional(),
  /** The style per medium: for now the land gait. */
  locomotion: BodyLocomotionSchema.prefault({}),
  /** Left out, every anchor sits where `defaultAnchor` puts it. */
  anchors: AnchorsSchema.optional(),
});
export type BodyShape = z.output<typeof BodyShapeSchema>;

/**
 * Body plan settings only a drawn body has: a voxel body's cubes give its depth and its anchors
 * (ADR 0022, M19 decisions). A voxel species may not set them.
 */
export const DRAWN_ONLY_BODY_SETTINGS = ["thickness", "anchors"] as const;
export type DrawnOnlyBodySetting = (typeof DRAWN_ONLY_BODY_SETTINGS)[number];

/** The drawn-only settings a body plan sets: what a voxel species must not have. */
export const drawnOnlySettings = (body: BodyShape): DrawnOnlyBodySetting[] =>
  DRAWN_ONLY_BODY_SETTINGS.filter((setting) => body[setting] !== undefined);

/** A body plan with every default: the walk gait alone (ADR 0020 §13). A fresh object. */
export const defaultBody = (): BodyShape => BodyShapeSchema.parse({});

/** The drawn shape's bounds in drawing pixels: left and top inclusive, right and bottom exclusive. */
export interface DrawingBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where an anchor the player didn't place sits (ADR 0020 §10): the center of gravity in the middle
 * of the drawn shape's bounds (only its x is used: the body rocks and squashes about the point on
 * the ground below it); the tail at the middle of the bounds' left edge, the rear, since drawings
 * face right.
 */
export function defaultAnchor(name: AnchorName, bounds: DrawingBounds): Anchor {
  switch (name) {
    case "centerOfGravity":
      return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
    case "tail":
      return { x: bounds.left, y: (bounds.top + bounds.bottom) / 2 };
  }
}

export const SpeciesDefinitionSchema = z.strictObject({
  ...header("species"),
  appearance: AssetRefSchema,
  sizeClass: SizeClassSchema,
  /** The body plan. Left out, it is the walk gait alone. */
  body: BodyShapeSchema.prefault({}),
  /**
   * Locomotion and other capabilities → speed factor relative to `baseSpeed` (ADR 0004). Where
   * the species can move: at least one must be a locomotion capability, which is checked when
   * references resolve (ADR 0020 §1).
   */
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
/** A species as written, before defaults are filled in. */
export type SpeciesDefinitionInput = z.input<typeof SpeciesDefinitionSchema>;

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
