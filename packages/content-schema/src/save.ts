import { z } from "zod";
import { WORLD_SAVE_SCHEMA_VERSION } from "./constants";
import { ContentIdSchema, LocalIdSchema, RegionPositionSchema, SemverSchema } from "./primitives";

// The world save (ADR 0019): the simulation's state as plain data, written on quit and every so
// often, and read back at startup. These schemas mirror the simulation's runtime types
// (`CreatureState`, `RngState`, `DayPhase`, …) field for field. This package can't import the
// simulation, so the simulation checks at type level that its state and this schema agree.
// Action state and behavior memory are left `unknown`: their owning code validates them.

const tick = z.int().nonnegative();
const int32 = z.int().gte(-0x80000000).lte(0x7fffffff);
const uint32 = z.int().gte(0).lte(0xffffffff);

/**
 * Plain-data state of one sfc32 stream (ADR 0006 §3). The generator keeps its words as signed
 * 32-bit integers (`| 0`), while the key is unsigned (`>>> 0`).
 */
export const RngStateSchema = z.strictObject({
  words: z.tuple([int32, int32, int32, int32]),
  key: uint32,
});
export type RngStateSave = z.output<typeof RngStateSchema>;

/**
 * The four day phases (ADR 0018 §5), in the order a day passes through them. The simulation's
 * `DAY_PHASES` is this list, so the order is the phase order it uses.
 */
export const DayPhaseSchema = z.enum(["dawn", "day", "dusk", "night"]);

/**
 * Minutes a creature's own day moves a phase start by (issue #85). The simulation draws within
 * 30 minutes either way; anything under an hour keeps the phases in order.
 */
const dayShift = z.number().gt(-60).lt(60);

/** A creature's own day (`CreatureDay`, issue #85). */
export const CreatureDaySchema = z.strictObject({
  phase: DayPhaseSchema,
  morning: dayShift,
  evening: dayShift.optional(),
});

/** A cell of the coarse exploration grid, by integer index. */
const GridCellSchema = z.strictObject({ x: z.int(), z: z.int() });

/**
 * Failed attempts to reach a known place since the creature last reached it, and the tick until
 * which it is skipped (ADR 0018 amendments, §11).
 */
export const ReachFailuresSchema = z.strictObject({
  noRoute: z.int().nonnegative(),
  stuck: z.int().nonnegative(),
  retryTick: tick,
  cell: GridCellSchema,
});

/**
 * A prop or structure placement a creature has seen, the tick it was last seen, and its failures
 * to reach it.
 */
export const KnownPlaceSchema = z.strictObject({
  placementId: LocalIdSchema,
  lastSeenTick: tick,
  failures: ReachFailuresSchema.optional(),
});

/** A cell of the coarse exploration grid a creature visited, by integer index. */
export const VisitedCellSchema = z.strictObject({ ...GridCellSchema.shape, tick });

/** What a creature knows of the world (ADR 0018 §10, §16). */
export const CreatureKnowledgeSchema = z.strictObject({
  places: z.record(ContentIdSchema, z.array(KnownPlaceSchema)),
  recentCells: z.array(VisitedCellSchema),
});

/** One creature, as the simulation holds it (`CreatureState`, ADR 0006 §4, ADR 0018 §16). */
export const CreatureSaveSchema = z.strictObject({
  id: LocalIdSchema,
  speciesId: ContentIdSchema,
  /** Exact species version this individual was created from (ADR 0003 §5). */
  speciesVersion: SemverSchema,
  position: RegionPositionSchema,
  heading: z.number().gte(-Math.PI).lt(Math.PI, { error: "Heading must be normalised to [-π, π)" }),
  rng: RngStateSchema,
  action: z
    .strictObject({
      id: ContentIdSchema,
      behavior: ContentIdSchema,
      /** The action's own state, validated by the action. */
      state: z.unknown(),
      startTick: tick,
    })
    .optional(),
  lastResult: z
    .strictObject({
      action: ContentIdSchema,
      outcome: z.enum(["done", "failed", "interrupted"]),
      reason: z.string().optional(),
    })
    .optional(),
  decideAtTick: tick,
  /** Behavior ID → that behavior's memory, validated by the behavior. */
  memory: z.record(ContentIdSchema, z.record(z.string(), z.unknown())),
  usedStructures: z.array(LocalIdSchema),
  progress: z.strictObject({ x: z.number(), z: z.number(), stalledTicks: tick }),
  /** Need ID → value in [0, 1]. */
  needs: z.record(ContentIdSchema, z.number().gte(0).lte(1)),
  knowledge: CreatureKnowledgeSchema,
  /** Placement ID of its home, or null. */
  home: LocalIdSchema.nullable(),
  variation: z.strictObject({
    needs: z.record(ContentIdSchema, z.number().positive()),
    senses: z.record(ContentIdSchema, z.number().positive()),
  }),
  spotAngle: z.number(),
  day: CreatureDaySchema,
  asleep: z.boolean(),
  phaseReactionTick: tick.optional(),
  releasedAtTick: tick.optional(),
});
export type CreatureSave = z.output<typeof CreatureSaveSchema>;

/** A saved world: everything needed to carry on where it stopped (ADR 0019). */
export const WorldSaveSchema = z
  .strictObject({
    schemaVersion: z.literal(WORLD_SAVE_SCHEMA_VERSION),
    /** When it was saved, in milliseconds since the Unix epoch. */
    savedAt: z.int().nonnegative(),
    /** The world definition it was saved in. */
    world: z.strictObject({ id: ContentIdSchema, version: SemverSchema }),
    seed: z.int(),
    /** Ticks simulated so far. */
    tick,
    /** Time of day in minutes since local midnight, in [0, 1440). */
    minutes: z
      .number()
      .gte(0)
      .lt(24 * 60),
    /** The day phase as of the last tick; may lag `minutes` (ADR 0018, PRs 3a and 3b). */
    dayPhase: DayPhaseSchema,
    /** The world's own RNG stream. */
    rng: RngStateSchema,
    /** The number the next creature ID takes (`creature-<n>`). */
    nextCreature: z.int().positive(),
    /** Species that have had a creature in this world. */
    introducedSpecies: z.array(ContentIdSchema),
    /** Species ID → exact version, of every species the save depends on. */
    species: z.record(ContentIdSchema, SemverSchema),
    creatures: z.array(CreatureSaveSchema),
  })
  .superRefine((save, ctx) => {
    const unique = (ids: readonly string[], what: string, path: string) => {
      const seen = new Set<string>();
      ids.forEach((id, i) => {
        if (seen.has(id)) {
          ctx.addIssue({ code: "custom", message: `Duplicate ${what} "${id}"`, path: [path, i] });
        }
        seen.add(id);
      });
    };
    unique(save.introducedSpecies, "species", "introducedSpecies");
    unique(
      save.creatures.map((c) => c.id),
      "creature ID",
      "creatures",
    );
  });
export type WorldSave = z.output<typeof WorldSaveSchema>;
