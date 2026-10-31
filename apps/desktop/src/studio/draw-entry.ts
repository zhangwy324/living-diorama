import {
  PLAYER_PART_SCHEMA_VERSION,
  PlayerPartEntrySchema,
  playerPartId,
  type PartDrawing,
  type PartDrawingRule,
  type PartDrawingView,
  type PlayerPartEntry,
  type VoxelPart,
  type VoxelStep,
} from "@living-diorama/content-schema";
import type { PartSummary } from "@living-diorama/simulation";
import type { PartsStore } from "@living-diorama/desktop-integration";
import type { PlacedPoints } from "./drawn-points";
import { compactDrawing, type Grid } from "./grid-editor";

// Saving a drawn part to the player's parts (ADR 0025 §6–§8): the entry that goes into the parts
// store, and the choices Draw mode starts a drawing from. Pure, but for `savePart`.

/** What Draw mode is drawing: a new part, or a saved one being edited in place. */
export interface DrawnPartRecord {
  /** The lowercase UUID it is stored under; none until it is first saved. */
  uuid?: string;
  /** Its version as saved; 0 until it is first saved. */
  version: number;
  createdAt?: string;
}

export const NEW_PART: DrawnPartRecord = { version: 0 };

/** The record of a saved entry, to edit it. */
export function recordOf(entry: PlayerPartEntry): DrawnPartRecord {
  return {
    uuid: entry.id.slice("user-part:".length),
    version: entry.version,
    createdAt: entry.createdAt,
  };
}

/**
 * The entry to save for a drawn part: a new UUID and version 1 for a new part, the same UUID and
 * the next version for an edit (§7). Checked against `PlayerPartEntrySchema`, so a refused entry
 * throws before it reaches the store.
 */
export function partEntry(options: {
  record: DrawnPartRecord;
  name: string;
  part: VoxelPart;
  drawing: PartDrawing;
  /** Now, as an ISO date-time. */
  now: string;
  newUuid(): string;
}): PlayerPartEntry {
  const { record, now } = options;
  const uuid = record.uuid ?? options.newUuid();
  const result = PlayerPartEntrySchema.safeParse({
    schemaVersion: PLAYER_PART_SCHEMA_VERSION,
    id: playerPartId(uuid),
    name: options.name.trim(),
    version: record.version + 1,
    createdAt: record.createdAt ?? now,
    updatedAt: now,
    part: options.part,
    drawing: options.drawing,
  });
  if (!result.success) throw new Error(`The part can't be saved: ${result.error.message}`);
  return result.data;
}

/** Saves an entry in the parts store, under the UUID of its ID. */
export async function savePart(store: PartsStore, entry: PlayerPartEntry): Promise<void> {
  await store.save(entry.id.slice("user-part:".length), entry);
}

/** How a drawing is turned into a part, besides its pixels: what Draw mode's panel picks. */
export interface DrawSetup {
  partType: string;
  /** The base part's ID: a pack part's, or the edited part's own for its saved points. */
  baseId: string;
  step: VoxelStep;
  view: PartDrawingView;
  rule: PartDrawingRule;
  chubby: number;
  flatThickness: 1 | 2;
}

/** The drawing of a grid, keeping only the colours it uses (`compactDrawing`). */
export function drawingOf(grid: Grid, palette: readonly string[], setup: DrawSetup): PartDrawing {
  const { step, view, rule, chubby, flatThickness } = setup;
  return { ...compactDrawing(grid, palette), view, rule, chubby, flatThickness, step };
}

/**
 * What decides the saved part: its name, drawing, base part and the points the player placed. The
 * same key makes the same entry but for its dates and version, so a part whose key hasn't changed
 * since it was opened or saved has nothing to save.
 */
export const drawKey = (
  name: string,
  drawing: PartDrawing,
  baseId: string,
  placed: PlacedPoints,
): string => JSON.stringify({ name: name.trim(), drawing, baseId, placed });

/**
 * The base part a drawing of `type` starts from (ADR 0025 §3): for a root type the part its pack
 * marks `starter`, else the first part of the type, in the order the strip lists them.
 */
export function defaultBase(
  parts: readonly PartSummary[],
  type: string,
  roots: ReadonlySet<string>,
): PartSummary | undefined {
  const ofType = parts.filter(({ part }) => part.type === type);
  return (roots.has(type) ? ofType.find(({ starter }) => starter) : undefined) ?? ofType[0];
}

/** A new part's name: "My <type>", e.g. "My torso". */
export const defaultPartName = (typeName: string) => `My ${typeName.toLowerCase()}`;
