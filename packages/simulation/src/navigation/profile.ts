import {
  SIZE_CLASSES,
  type RegionKind,
  type SizeClass,
  type SpeciesDefinition,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";

/** What navigation needs to know about a creature: its size and how it can move. */
export interface NavProfile {
  /** Equal for profiles that produce identical walkability. */
  key: string;
  sizeClass: SizeClass;
  radius: number;
  height: number;
  capabilities: ReadonlySet<string>;
  /** Steepest walkable slope in radians, per region kind the creature can move in. */
  maxSlopeByKind: ReadonlyMap<RegionKind, number>;
}

/**
 * How messages name a profile: its size class and the region kinds it moves in, so profiles that
 * share a size class but move differently (land and amphibious, say) are told apart (#194).
 */
export function profileLabel(profile: NavProfile): string {
  const kinds = [...profile.maxSlopeByKind.keys()].sort();
  return `size class ${profile.sizeClass}${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}`;
}

/** Derives the profile from the species' capabilities and their locomotion rules (ADR 0005 §3). */
export function profileForSpecies(species: SpeciesDefinition, registries: Registries): NavProfile {
  return navProfile(species.sizeClass, Object.keys(species.capabilities), registries);
}

/** The profile of creatures of `sizeClass` with these capabilities, whether a species has it or not. */
export function navProfile(
  sizeClass: SizeClass,
  capabilities: readonly string[],
  registries: Registries,
): NavProfile {
  const maxSlopeByKind = new Map<RegionKind, number>();
  for (const id of capabilities) {
    const rule = registries.capabilities.get(id)?.locomotion;
    if (!rule) continue;
    const slope = rule.maxSlopeDeg === undefined ? Infinity : (rule.maxSlopeDeg * Math.PI) / 180;
    // A creature with several ways of moving uses the most permissive one.
    for (const kind of rule.regionKinds) {
      maxSlopeByKind.set(kind, Math.max(maxSlopeByKind.get(kind) ?? 0, slope));
    }
  }
  const { radius, height } = SIZE_CLASSES[sizeClass];
  const kinds = [...maxSlopeByKind].sort(([a], [b]) => a.localeCompare(b));
  return {
    key: `${sizeClass}|${[...capabilities].sort().join(",")}|${kinds.map(([k, s]) => `${k}:${s}`).join(",")}`,
    sizeClass,
    radius,
    height,
    capabilities: new Set(capabilities),
    maxSlopeByKind,
  };
}
