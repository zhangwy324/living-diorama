import type { BodyCheck } from "@living-diorama/renderer";
import type { Limit } from "@living-diorama/simulation";

// The Studio's gentle hints (roadmap M11): short lines in the player's words, never blocking.
// Diagnostic codes never reach the player.

/** What the drawing will look like as a body: empty, thin parts, shapes that aren't joined. */
export function drawingHints(check: BodyCheck): string[] {
  if (check.empty) return ["Nothing drawn yet."];
  const hints: string[] = [];
  if (check.thinParts === 1) {
    hints.push("This part is very thin (orange with Show warnings), so it may look flat.");
  } else if (check.thinParts > 1) {
    hints.push("Some parts are very thin (orange with Show warnings), so they may look flat.");
  }
  if (check.shapes > 1) {
    hints.push(
      "Parts aren't joined (blue with Show warnings): each separate shape becomes its own slab.",
    );
  }
  return hints;
}

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
