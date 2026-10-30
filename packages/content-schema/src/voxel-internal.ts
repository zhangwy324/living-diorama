import { parseContentId } from "./primitives";
import type { VoxelPart } from "./voxel";

// Helpers shared by the assembler (voxel-assembly.ts) and the edit operations (voxel-edit.ts).
// Internal: `index.ts` doesn't export this file.

/** A deep copy of a part, with `source` when given: it shares no objects with `part`. */
export const copyVoxelPart = (part: VoxelPart, source?: string): VoxelPart => ({
  ...part,
  ...(source === undefined ? {} : { source }),
  size: { ...part.size },
  colors: [...part.colors],
  voxels: [...part.voxels],
  attach: { ...part.attach },
  sockets: part.sockets.map((socket) => ({ ...socket, position: { ...socket.position } })),
});

/**
 * The key an assembly holds a library part under, from its content ID's name:
 * `hollow:legs/short` becomes `legs-short` (`claimId` adds `-2`, `-3`… on a clash).
 */
export const partKeyOf = (id: string): string =>
  parseContentId(id)?.name.replace(/[./]/g, "-") ?? "part";

/** `base`, or `base-2`, `base-3`… when that is taken; marks the one it returns taken. */
export function claimId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}
