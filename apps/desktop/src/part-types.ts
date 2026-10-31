import {
  DEFAULT_PART_DRAWING,
  type PartDrawing,
  type PartFitLookup,
  type PartMotion,
  type PartRole,
} from "@living-diorama/content-schema";
import type { PartTypeSummary } from "@living-diorama/simulation";

/**
 * Looks up part types' roles from the worker's content summary, so the renderer finds a voxel
 * creature's tail part (ADR 0022, M19 decisions) without the registries. A type the summary
 * doesn't list has no role.
 */
export function partRoleLookup(
  partTypes: readonly PartTypeSummary[],
): (partType: string) => PartRole | undefined {
  const roles = new Map(partTypes.map(({ id, role }) => [id, role]));
  return (partType) => roles.get(partType);
}

/**
 * Looks up part types' motions from the worker's content summary, so the renderer can animate a
 * voxel creature's parts (M22) without the registries. A type the summary doesn't list, or one
 * without a motion, doesn't move.
 */
export function partMotionLookup(
  partTypes: readonly PartTypeSummary[],
): (partType: string) => PartMotion | undefined {
  const motions = new Map(partTypes.map(({ id, motion }) => [id, motion]));
  return (partType) => motions.get(partType);
}

/**
 * Looks up part types' drawing recipes from the worker's content summary, so Draw mode starts a
 * part's drawing in its type's view and depth rule (M23). A type the summary doesn't list, or one
 * without a recipe, is drawn flat from the side (`DEFAULT_PART_DRAWING`).
 */
export function partDrawingLookup(
  partTypes: readonly PartTypeSummary[],
): (partType: string) => Readonly<PartDrawing> {
  const drawings = new Map(partTypes.map(({ id, drawing }) => [id, drawing]));
  return (partType) => drawings.get(partType) ?? DEFAULT_PART_DRAWING;
}

/**
 * What `assembleParts` and the edit operations need of the registered types, from the worker's
 * content summary, so the main thread assembles parts (ADR 0022, M20 decisions) without the
 * registries. A part type the summary doesn't list has no fits and no role, and a socket type it
 * doesn't list isn't registered.
 */
export function partFitLookup(
  partTypes: readonly PartTypeSummary[],
  socketTypes: readonly string[],
): PartFitLookup {
  const fits = new Map(partTypes.map(({ id, fits }) => [id, fits]));
  const sockets = new Set(socketTypes);
  return {
    fitsOf: (partType) => fits.get(partType),
    isSocketType: (socketType) => sockets.has(socketType),
    roleOf: partRoleLookup(partTypes),
  };
}
