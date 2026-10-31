import {
  DEFAULT_PART_DRAWING_RECIPE,
  DRAWING_GRID,
  fitDrawnPart,
  PartDrawingSchema,
  PLAYER_PART_SCHEMA_VERSION,
  playerPartId,
  voxelizeDrawing,
  type PlayerPartEntry,
} from "@living-diorama/content-schema";
import type { StudioParts } from "../../studio-protocol";

/** Test only: what a drawn part looks like, a filled ellipse in the middle of the grid. */
export interface DrawnPartOptions {
  uuid: string;
  /** The part type, e.g. `hollow:leg`; its first pack part is the base part. */
  type: string;
  name: string;
  version?: number;
  createdAt?: string;
  /** The ellipse's width and height in pixels. */
  width?: number;
  height?: number;
  color?: string;
}

/**
 * Test only: a player part entry as Draw mode would save one (ADR 0025 §3, §8): an ellipse drawn
 * with the type's recipe, fitted to the type's first pack part in ID order (the starter for a root
 * type), which it names as its base.
 */
export function drawnPartEntry(
  studioParts: StudioParts,
  {
    uuid,
    type,
    name,
    version = 1,
    createdAt = "2026-10-30T12:00:00.000Z",
    width = 8,
    height = 12,
    color = "#c8643c",
  }: DrawnPartOptions,
): PlayerPartEntry {
  const ofType = studioParts.parts.filter(({ part }) => part.type === type);
  const base = ofType.find(({ starter }) => starter) ?? ofType[0];
  if (!base) throw new Error(`No pack part of type ${type}`);
  const recipe =
    studioParts.partTypes.find(({ id }) => id === type)?.drawing ?? DEFAULT_PART_DRAWING_RECIPE;
  const pixels = new Array<number>(DRAWING_GRID * DRAWING_GRID).fill(0);
  const centre = DRAWING_GRID / 2;
  for (let y = 0; y < DRAWING_GRID; y++) {
    for (let x = 0; x < DRAWING_GRID; x++) {
      const dx = (x + 0.5 - centre) / (width / 2);
      const dy = (y + 0.5 - centre) / (height / 2);
      if (dx * dx + dy * dy <= 1) pixels[y * DRAWING_GRID + x] = 1;
    }
  }
  const drawing = PartDrawingSchema.parse({
    pixels,
    palette: [color],
    view: recipe.view,
    rule: recipe.rule,
    step: base.part.step,
    baseId: base.id,
  });
  const drawn = voxelizeDrawing(drawing);
  if (!drawn) throw new Error("Nothing drawn");
  const { part } = fitDrawnPart(drawn, base.part);
  return {
    schemaVersion: PLAYER_PART_SCHEMA_VERSION,
    id: playerPartId(uuid),
    name,
    version,
    createdAt,
    updatedAt: createdAt,
    part,
    drawing,
  };
}
