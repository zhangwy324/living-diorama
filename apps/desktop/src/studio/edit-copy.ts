import type { VoxelAssembly } from "@living-diorama/content-schema";
import type { LoadRequest } from "./AssemblyEditor";

// Edit a copy (ADR 0023 §3): a released voxel creature's assembly, loaded into Build mode under a
// new name, so releasing it makes a new species and leaves the old one as it was.

/** The longest name the name field takes. */
const MAX_NAME_LENGTH = 40;
const SUFFIX = " copy";

/** The copy's name: "<name> copy", the name cut short to fit the name field. */
export function copyName(name: string): string {
  return `${name
    .trim()
    .slice(0, MAX_NAME_LENGTH - SUFFIX.length)
    .trimEnd()}${SUFFIX}`;
}

/**
 * Fetches a species' assembly and makes the load request for it, keyed by `key` (a new one for
 * each Edit a copy, so pressing it again on the same species loads it again).
 */
export async function copyRequest(
  fetch: (speciesId: string) => Promise<{ assembly: VoxelAssembly }>,
  species: { speciesId: string; name: string },
  key: number,
): Promise<LoadRequest> {
  const { assembly } = await fetch(species.speciesId);
  return { key, assembly, name: copyName(species.name) };
}
