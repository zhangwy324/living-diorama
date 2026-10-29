import { z } from "zod";
import type { Diagnostic } from "./diagnostics";
import {
  ContentIdSchema,
  LocalIdSchema,
  Vec2Schema,
  type RegionPosition,
  type Vec2,
} from "./primitives";

// World edits (ADR 0021): what the player, the dev console or `pnpm sim` asks to change in a
// world, and what the engine answers. An edit is pure data; applying it to a world definition is
// the simulation's job. For now only props can be edited. Terrain and region ops will join the
// union as `terrain.*` and `region.*`.
//
// Positions are horizontal only: the engine puts a prop on the ground where it stands, so a
// placement's height is never edited directly.

const scale = z.number().positive({ error: "A prop's scale must be greater than 0" });

/**
 * Adds a placement of a registered prop type. `id` is the new placement's ID; left out, the engine
 * picks one.
 */
export const PropAddOpSchema = z.strictObject({
  op: z.literal("prop.add"),
  prop: ContentIdSchema,
  position: Vec2Schema,
  rotationY: z.number().default(0),
  scale: scale.default(1),
  id: LocalIdSchema.optional(),
});
export type PropAddOp = z.output<typeof PropAddOpSchema>;

/** Removes a prop placement. */
export const PropRemoveOpSchema = z.strictObject({
  op: z.literal("prop.remove"),
  id: LocalIdSchema,
});
export type PropRemoveOp = z.output<typeof PropRemoveOpSchema>;

/** Moves a prop placement, turns it, or both. What is left out stays as it is. */
export const PropMoveOpSchema = z
  .strictObject({
    op: z.literal("prop.move"),
    id: LocalIdSchema,
    position: Vec2Schema.optional(),
    rotationY: z.number().optional(),
  })
  .refine((op) => op.position !== undefined || op.rotationY !== undefined, {
    error: "A move needs a position, a rotation or both",
  });
export type PropMoveOp = z.output<typeof PropMoveOpSchema>;

/** Sets a prop placement's uniform scale, which scales its block radius too. */
export const PropScaleOpSchema = z.strictObject({
  op: z.literal("prop.scale"),
  id: LocalIdSchema,
  scale,
});
export type PropScaleOp = z.output<typeof PropScaleOpSchema>;

const OPS = [PropAddOpSchema, PropRemoveOpSchema, PropMoveOpSchema, PropScaleOpSchema] as const;

/** The kinds of edit op, e.g. `prop.add`. */
export const EDIT_OP_KINDS: readonly (typeof OPS)[number]["shape"]["op"]["value"][] = OPS.map(
  (schema) => schema.shape.op.value,
);

/** One change to a world, told apart by `op`. */
export const WorldEditOpSchema = z.discriminatedUnion("op", OPS, {
  error: (issue) =>
    issue.code === "invalid_union"
      ? `Unknown edit op (expected one of ${EDIT_OP_KINDS.join(", ")})`
      : undefined,
});
export type WorldEditOp = z.output<typeof WorldEditOpSchema>;
/** An op as written, before defaults are filled in. */
export type WorldEditOpInput = z.input<typeof WorldEditOpSchema>;

/**
 * A world edit: one or more ops, applied in order and all or nothing. If any op fails, none is
 * applied. The world is rebuilt once per edit, and one edit is one undo step, so a change made of
 * several ops (removing a selection, say) is one edit, and its inverse undoes all of it.
 */
export const WorldEditSchema = z.strictObject({
  ops: z.array(WorldEditOpSchema).min(1, { error: "An edit needs at least one op" }),
});
export type WorldEdit = z.output<typeof WorldEditSchema>;
/** An edit as written, before defaults are filled in. */
export type WorldEditInput = z.input<typeof WorldEditSchema>;

// ---- What the engine answers --------------------------------------------------------------------

/**
 * A way between water and land: a connection, by its ID, or a bank, by the two regions it joins
 * (banks have no IDs).
 */
export type WaterExit =
  | { kind: "connection"; connectionId: string }
  | { kind: "bank"; waterRegion: string; landRegion: string };

/**
 * A way out of the water an edit blocks. The edit is still allowed (a creature in the water may
 * have fewer ways out); the engine warns.
 */
export interface BlockedWaterExit {
  exit: WaterExit;
  /** The navigation profiles that can no longer use it; smaller creatures may still fit. */
  profiles: readonly string[];
}

/** Where a prop placement blocks creatures after the edit: a circle on the ground. */
export interface PropFootprint {
  placementId: string;
  center: Vec2;
  /** The prop type's block radius times the placement's scale, in metres. */
  radius: number;
}

/** A creature the edit covered, moved to the nearest place it can stand. */
export interface RelocatedCreature {
  creatureId: string;
  from: RegionPosition;
  to: RegionPosition;
}

/**
 * What an edit does, or would do. Diagnostics' paths point into the edit, e.g.
 * `["ops", 1, "id"]`.
 */
export interface WorldEditOutcome {
  /** The footprint of every placement the edit adds, moves or scales, after the edit. */
  footprints: readonly PropFootprint[];
  /** Ways out of the water the edit blocks, also described in `warnings`. */
  blockedExits: readonly BlockedWaterExit[];
  warnings: readonly Diagnostic[];
  relocated: readonly RelocatedCreature[];
}

/** An edit that was refused, and why. Nothing changed. */
export interface WorldEditRejected {
  ok: false;
  diagnostics: readonly Diagnostic[];
}

/** The answer to validating an edit without applying it (a dry run). */
export type WorldEditCheck = ({ ok: true } & WorldEditOutcome) | WorldEditRejected;

/** The answer to applying an edit. */
export type WorldEditResult =
  | ({
      ok: true;
      /** The edit as applied, with every default filled in and every new placement's ID. */
      edit: WorldEdit;
      /** The edit that undoes it: each op's inverse, in reverse order. */
      inverse: WorldEdit;
    } & WorldEditOutcome)
  | WorldEditRejected;
