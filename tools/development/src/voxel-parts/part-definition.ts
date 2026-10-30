import {
  ContentIdSchema,
  encodeVoxels,
  parsePartDefinition,
  SCHEMA_VERSIONS,
  SemverSchema,
  validate,
  VOXEL_STEPS,
  VoxelPointSchema,
  VoxelSocketSchema,
  type PartDefinition,
  type Result,
} from "@living-diorama/content-schema";
import { z } from "zod";
import type { VoxCubes } from "./vox-parser";

// A starter part's definition (ADR 0022, M20 decisions "A sidecar per `.vox`" and "The importer
// is a development tool"): the cubes of its `.vox` file merged with its sidecar JSON, which holds
// what a `.vox` can't: the part's ID, version and name, its part type, its cube step, its attach
// point and its sockets. The result is checked as content-schema's part definition.

/** The sidecar JSON beside a `.vox` file. Points are in the part's cubes, as ADR 0022 §16 axes. */
export const PartSidecarSchema = z.strictObject({
  id: ContentIdSchema,
  version: SemverSchema,
  name: z.string().min(1),
  /** Whether the Studio starts a new creature from this part (ADR 0023 §10). */
  starter: z.boolean().optional(),
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
  const { id, version, name, starter, type, step, attach, sockets } = side.value;
  return parsePartDefinition(
    {
      schemaVersion: SCHEMA_VERSIONS.part,
      id,
      version,
      name,
      ...(starter ? { starter: true } : {}),
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
