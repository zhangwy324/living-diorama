import {
  assembleParts,
  type PartFitLookup,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import type { PartSummary, PartTypeSummary } from "@living-diorama/simulation";
import { partFitLookup } from "../part-types";
import type { StudioParts } from "../studio-protocol";

// What Build mode builds with (ADR 0023 §4, §10, §18): the parts from the strip's `parts` answer,
// grouped for the tray, the part types a creature is built on, and the default torso a new
// creature starts from.

/** The parts to build with and what Build mode works out from them once. */
export interface PartsKit {
  /** Every part, by ID. */
  byId: ReadonlyMap<string, PartSummary>;
  /** The tray's sections, in order: one per part type that has parts. */
  sections: readonly TraySection[];
  lookup: PartFitLookup;
  /** The part types a creature is built on (`rootPartTypes`). */
  roots: ReadonlySet<string>;
  /** What a new creature starts from: the default torso alone. */
  start: VoxelAssembly;
}

export interface TraySection {
  /** The part type's ID. */
  type: string;
  /** Its name, the section's heading. */
  name: string;
  parts: readonly PartSummary[];
}

/** The part types a creature is built on, such as torsos: those with the `root` role (ADR 0023 §10). */
export function rootPartTypes(partTypes: readonly PartTypeSummary[]): Set<string> {
  return new Set(partTypes.filter(({ role }) => role === "root").map(({ id }) => id));
}

/**
 * How many sockets away from a root each part type can hang at the nearest: 0 for the root types,
 * 1 for what fits a root part's sockets (heads, legs), 2 for what fits those parts' sockets (eyes,
 * ears). Types nothing can reach are left out.
 */
function depthOfTypes(
  partTypes: readonly PartTypeSummary[],
  parts: readonly PartSummary[],
  roots: ReadonlySet<string>,
): Map<string, number> {
  const depth = new Map<string, number>([...roots].map((type) => [type, 0]));
  for (let d = 0; d < partTypes.length; d++) {
    const offered = new Set(
      parts
        .filter(({ part }) => depth.get(part.type) === d)
        .flatMap(({ part }) => part.sockets.map((socket) => socket.type)),
    );
    for (const { id, fits } of partTypes) {
      if (!depth.has(id) && fits.some((type) => offered.has(type))) depth.set(id, d + 1);
    }
  }
  return depth;
}

/**
 * The tray's sections: torsos first, then the types that hang from them, then theirs, each kind
 * by name; a type with no parts has no section.
 */
export function traySections(
  partTypes: readonly PartTypeSummary[],
  parts: readonly PartSummary[],
  roots: ReadonlySet<string>,
): TraySection[] {
  const depth = depthOfTypes(partTypes, parts, roots);
  const order = (type: PartTypeSummary) => depth.get(type.id) ?? Infinity;
  return [...partTypes]
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map(({ id, name }) => ({ type: id, name, parts: parts.filter((p) => p.part.type === id) }))
    .filter((section) => section.parts.length > 0);
}

/** The part a new creature starts from: the first part of a root type. Undefined when there is none. */
export const defaultRoot = (
  parts: readonly PartSummary[],
  roots: ReadonlySet<string>,
): PartSummary | undefined => parts.find(({ part }) => roots.has(part.type));

/** An assembly of `root` alone, keyed as `assembleParts` keys it. */
export const assemblyOf = (root: PartSummary, lookup: PartFitLookup): VoxelAssembly =>
  assembleParts({ start: root, parts: [], lookup, seed: 0 });

/** The kit for the strip's parts, or undefined when no part can be a root. */
export function partsKit({ parts, partTypes, socketTypes }: StudioParts): PartsKit | undefined {
  const lookup = partFitLookup(partTypes, socketTypes);
  const roots = rootPartTypes(partTypes);
  const root = defaultRoot(parts, roots);
  if (!root) return undefined;
  return {
    byId: new Map(parts.map((part) => [part.id, part])),
    sections: traySections(partTypes, parts, roots),
    lookup,
    roots,
    start: assemblyOf(root, lookup),
  };
}
