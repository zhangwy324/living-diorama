import type { Limit } from "@living-diorama/simulation";

// The Studio's gentle hints (roadmap M11): short lines in the player's words, never blocking.
// Diagnostic codes never reach the player.

/**
 * Where a creature of the chosen size and ways of moving won't fit in the world (ADR 0013, ADR 0020
 * §12), each said once.
 */
export function limitHints(limits: readonly Limit[]): string[] {
  return [...new Set(limits.map(describeLimit))];
}

function describeLimit(limit: Limit): string {
  switch (limit.code) {
    case "portal_unusable":
      return limit.structure
        ? `Too big to cross the ${lowerFirst(limit.structure.name)}.`
        : "Too big for one of the ways between places.";
    case "disconnected_region":
      return "Can't reach a few spots in the world.";
    case "no_walkable_area":
      return "Can't go into some places at all.";
    case "spawn_not_walkable":
      return "Won't appear at some of the world's starting spots.";
    case "no_spawn_point":
      return "Has nowhere to appear in this world at this size, moving this way.";
    case "no_water_exit":
      return "Could get stuck in the water: some banks are too high to climb out.";
    default:
      return limit.severity === "error"
        ? "Something in this world doesn't work at this size."
        : "Can't go everywhere at this size.";
  }
}

/** "Wooden bridge" → "wooden bridge", to read inside a sentence. Names in capitals stay. */
const lowerFirst = (name: string) =>
  /^\p{Lu}\p{Ll}/u.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name;
