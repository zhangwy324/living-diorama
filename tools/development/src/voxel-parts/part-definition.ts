import {
  ContentIdSchema,
  encodeVoxels,
  SemverSchema,
  validate,
  VOXEL_STEPS,
  VoxelPartSchema,
  VoxelPointSchema,
  VoxelSocketSchema,
  type Result,
} from "@living-diorama/content-schema";
import { z } from "zod";
import type { VoxCubes } from "./vox-parser";

// A starter part's definition (M20 decisions E1–E3): the cubes of its `.vox` file merged with its
// sidecar JSON, which holds what a `.vox` can't: the part's ID, version and name, its part type,
// its cube step, its attach point and its sockets.
//
// The definition's shape is defined here until content-schema has the part definition schema of
// M20 PR 1; then this module uses that schema and its parser instead.

/** The part definition's schema version (local until content-schema defines it). */
export const PART_DEFINITION_SCHEMA_VERSION = 1;

/** The sidecar JSON beside a `.vox` file. Points are in the part's cubes, as ADR 0022 §16 axes. */
export const PartSidecarSchema = z.strictObject({
  id: ContentIdSchema,
  version: SemverSchema,
  name: z.string().min(1),
  /** The part type, e.g. `hollow:leg`. */
  type: ContentIdSchema,
  /** Edge of one cube in metres, one of `VOXEL_STEPS`. */
  step: z.literal(VOXEL_STEPS, {
    error: `A part's step must be one of ${VOXEL_STEPS.join(", ")} m`,
  }),
  attach: VoxelPointSchema,
  sockets: z.array(VoxelSocketSchema).default([]),
});
export type PartSidecar = z.output<typeof PartSidecarSchema>;

/** A registered voxel part with the part inline: `{ schemaVersion, id, version, name, part }`. */
export const PartDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(PART_DEFINITION_SCHEMA_VERSION),
  id: ContentIdSchema,
  version: SemverSchema,
  name: z.string().min(1),
  part: VoxelPartSchema,
});
export type PartDefinition = z.output<typeof PartDefinitionSchema>;

/**
 * Merges a part's cubes with its sidecar and checks the result as a part definition. Sidecar
 * errors name `sidecarSource`; errors in the merged part (an attach point outside the cubes, a
 * socket that mirrors a socket of another type) name `source`.
 */
export function partDefinition(
  cubes: VoxCubes,
  sidecar: unknown,
  { source, sidecarSource }: { source?: string; sidecarSource?: string } = {},
): Result<PartDefinition> {
  const side = validate(PartSidecarSchema, sidecar, sidecarSource);
  if (!side.ok) return side;
  const { id, version, name, type, step, attach, sockets } = side.value;
  return validate(
    PartDefinitionSchema,
    {
      schemaVersion: PART_DEFINITION_SCHEMA_VERSION,
      id,
      version,
      name,
      part: {
        type,
        size: cubes.size,
        step,
        colors: cubes.colors,
        voxels: encodeVoxels(cubes.grid),
        attach,
        sockets,
      },
    },
    source,
  );
}

/**
 * A definition as committed JSON: two-space indents, with the run-length encoded cubes on one line
 * so a part doesn't take a line per number.
 */
export function formatPartDefinition(definition: PartDefinition): string {
  const json = JSON.stringify(
    definition,
    (key, value: unknown) => (key === "voxels" ? "@@voxels@@" : value),
    2,
  );
  return `${json.replace('"@@voxels@@"', JSON.stringify(definition.part.voxels))}\n`;
}
