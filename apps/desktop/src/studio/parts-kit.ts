import {
  assembleParts,
  type PartFitLookup,
  type PartMotion,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import type { PartSummary, PartTypeSummary } from "@living-diorama/simulation";
import { partFitLookup, partMotionLookup } from "../part-types";
import type { StudioParts } from "../studio-protocol";

// What Build mode builds with (ADR 0023 §4, §10, §18): the parts from the strip's `parts` answer,
// grouped for the tray, the part types a creature is built on, and the default torso a new
// creature starts from.

/** The parts to build with and what Build mode works out from them once. */
export interface PartsKit {
  /** Every part, by ID: the packs' and the player's own (`withPlayerParts`). */
  byId: ReadonlyMap<string, PartSummary>;
  /** The tray's sections, in order: one per part type that has parts. */
  sections: readonly TraySection[];
  lookup: PartFitLookup;
  /** Part types' motions (`partMotionLookup`), for the preview's moving parts (ADR 0024 §7). */
  motionOf: (partType: string) => PartMotion | undefined;
  /** The part types a creature is built on (`rootPartTypes`). */
  roots: ReadonlySet<string>;
  /** What a new creature starts from: the default torso alone. */
  start: VoxelAssembly;
  /**
   * Every pack part of a root type, by ID: what Randomize builds on (ADR 0023 §9). Never the
   * player's own parts, which are placed by hand (ADR 0025 §10).
   */
  rootParts: readonly PartSummary[];
  /** Every pack part, by ID: what Randomize and Fill empty fill sockets from. No player parts. */
  parts: readonly PartSummary[];
  /** The packs' suggested colours, lower-case `#rrggbb` (ADR 0023 §11). */
  suggestedColors: readonly string[];
}

export interface TraySection {
  /** The part type's ID. */
  type: string;
  /** Its name, the section's heading. */
  name: string;
  /** The packs' parts of this type. */
  parts: readonly PartSummary[];
  /** The player's own parts of this type (ADR 0025 §9), after the packs'. */
  mine: readonly PartSummary[];
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
    .map(({ id, name }) => ({
      type: id,
      name,
      parts: parts.filter((p) => p.part.type === id),
      mine: [],
    }))
    .filter((section) => section.parts.length > 0);
}

/**
 * The part a new creature starts from (ADR 0023 §10): the first part of a root type its pack marks
 * as the `starter`, else the first part of a root type. Parts come sorted by ID, so the choice is
 * the same however the packs load. Undefined when there is none.
 */
export function defaultRoot(
  parts: readonly PartSummary[],
  roots: ReadonlySet<string>,
): PartSummary | undefined {
  const rooted = parts.filter(({ part }) => roots.has(part.type));
  return rooted.find(({ starter }) => starter) ?? rooted[0];
}

/** An assembly of `root` alone, keyed as `assembleParts` keys it. */
export const assemblyOf = (root: PartSummary, lookup: PartFitLookup): VoxelAssembly =>
  assembleParts({ start: root, parts: [], lookup, seed: 0 });

/** The kit for the strip's parts, or undefined when no part can be a root. */
export function partsKit({
  parts,
  partTypes,
  socketTypes,
  suggestedColors,
}: StudioParts): PartsKit | undefined {
  const lookup = partFitLookup(partTypes, socketTypes);
  const roots = rootPartTypes(partTypes);
  const root = defaultRoot(parts, roots);
  if (!root) return undefined;
  return {
    byId: new Map(parts.map((part) => [part.id, part])),
    sections: traySections(partTypes, parts, roots),
    lookup,
    motionOf: partMotionLookup(partTypes),
    roots,
    start: assemblyOf(root, lookup),
    rootParts: parts.filter(({ part }) => roots.has(part.type)),
    parts,
    suggestedColors,
  };
}

/**
 * The kit with the player's own parts added (ADR 0025 §9): each in its type's tray section after
 * the packs' parts, and pickable like them. Randomize and Fill empty still use the packs' parts
 * only (§10), and the default torso stays a pack part. Takes the packs' kit, `partsKit`'s.
 *
 * A part of a type with no section (no pack part of that type) is left out altogether, from the
 * tray and from `byId`, so what can be picked is what the tray shows: there is no base part to
 * draw it from either.
 */
export function withPlayerParts(kit: PartsKit, mine: readonly PartSummary[]): PartsKit {
  const shown = new Set(kit.sections.map((section) => section.type));
  const kept = mine.filter(({ part }) => shown.has(part.type));
  if (kept.length === 0) return kit;
  return {
    ...kit,
    byId: new Map([...kit.byId, ...kept.map((part) => [part.id, part] as const)]),
    sections: kit.sections.map((section) => ({
      ...section,
      mine: kept.filter(({ part }) => part.type === section.type),
    })),
  };
}
