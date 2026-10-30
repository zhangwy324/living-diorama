import type { PartRole } from "@living-diorama/content-schema";
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
