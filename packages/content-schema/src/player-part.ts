import { z } from "zod";
import type { Result } from "./diagnostics";
import { validate } from "./parse";
import { VoxelPartSchema } from "./voxel";
import { PartDrawingSchema } from "./voxel-draw";

// A part the player drew, in their own parts library (ADR 0025): the voxel part and the drawing it
// was made from, so it reopens as a drawing. One file per part.

/** Current data-format version of a player part entry. */
export const PLAYER_PART_SCHEMA_VERSION = 2;

// Version 2 adds the drawing's base part (`PartDrawing.baseId`). Older entries are not migrated:
// no backward compatibility is required yet (AGENTS.md).

const PLAYER_PART_ID = /^user-part:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The longest name a player part may have, as long as the Studio's name fields take. */
export const MAX_PLAYER_PART_NAME_LENGTH = 40;

/** The ID of the player part stored as `<uuid>.json`, `uuid` a lowercase UUID. */
export const playerPartId = (uuid: string): string => `user-part:${uuid}`;

export const PlayerPartEntrySchema = z
  .strictObject({
    schemaVersion: z.literal(PLAYER_PART_SCHEMA_VERSION),
    /** `user-part:<uuid>`, the UUID in lowercase. */
    id: z.string().regex(PLAYER_PART_ID, {
      error: 'Expected a player part ID like "user-part:<lowercase uuid>"',
    }),
    name: z.string().min(1).max(MAX_PLAYER_PART_NAME_LENGTH),
    /** 1 when the part is made, one more each time it is saved after an edit. */
    version: z.int().min(1),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
    part: VoxelPartSchema,
    drawing: PartDrawingSchema,
  })
  .superRefine(({ part, drawing }, ctx) => {
    if (part.source !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "A player part has no source: it is the source of the copies made from it",
        path: ["part", "source"],
      });
    }
    if (part.step !== drawing.step) {
      ctx.addIssue({
        code: "custom",
        message: `The part's step is ${part.step} m, the drawing's ${drawing.step} m`,
        path: ["part", "step"],
      });
    }
  });
export type PlayerPartEntry = z.output<typeof PlayerPartEntrySchema>;
export type PlayerPartEntryInput = z.input<typeof PlayerPartEntrySchema>;

export const parsePlayerPartEntry = (input: unknown, source?: string): Result<PlayerPartEntry> =>
  validate(PlayerPartEntrySchema, input, source);
