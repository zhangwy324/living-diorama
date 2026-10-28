import type { Rng } from "../runtime/rng";
import type { CreatureObservation, ReachableRegion } from "./contracts";

// Helpers that core behaviors and actions share.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A region drawn with probability proportional to its walkable area. */
export function pickWeighted(regions: readonly ReachableRegion[], rng: Rng): string | undefined {
  const total = regions.reduce((sum, r) => sum + r.walkableArea, 0);
  let roll = rng.next() * total;
  for (const region of regions) {
    roll -= region.walkableArea;
    if (roll < 0) return region.regionId;
  }
  return regions.at(-1)?.regionId;
}

/** Known places are ranked by straight-line distance and only the nearest few get a route. */
export const PATHED_CANDIDATES = 3;

/** A known place and the length of the creature's route to its spot there. */
export interface PlaceChoice {
  placementId: string;
  /** Route length in metres. */
  length: number;
}

/**
 * The known place offering `affordanceId` with the shortest route to the creature's spot there
 * (ADR 0018 amendments, §10): only the `PATHED_CANDIDATES` nearest by straight line, leaving out
 * `skip`, get a route. Undefined if none can be reached.
 */
export function chooseNearestByRoute(
  observation: CreatureObservation,
  affordanceId: string,
  skip?: (placementId: string) => boolean,
): PlaceChoice | undefined {
  return routeNearest(observation, affordanceId, skip)[0];
}

/**
 * The `PATHED_CANDIDATES` known places offering `affordanceId` nearest by straight line, leaving
 * out `skip`, that the creature can reach, with their route lengths, shortest route first (the
 * first in straight-line order on a tie).
 */
export function routeNearest(
  { creature, knowledge, world }: CreatureObservation,
  affordanceId: string,
  skip: (placementId: string) => boolean = () => false,
): PlaceChoice[] {
  const here = creature.position;
  const nearest = (knowledge.places[affordanceId] ?? [])
    .flatMap(({ placementId }) => {
      const place = skip(placementId) ? undefined : world.place(placementId);
      return place && Object.hasOwn(place.affordances, affordanceId)
        ? [{ placementId, distance: Math.hypot(place.x - here.x, place.z - here.z) }]
        : [];
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, PATHED_CANDIDATES);
  const routed: PlaceChoice[] = [];
  for (const { placementId } of nearest) {
    const spot = world.spotAt(placementId);
    const length = spot && world.routeLength(spot);
    if (length !== undefined) routed.push({ placementId, length });
  }
  // Stable, so equal routes keep their straight-line order.
  return routed.sort((a, b) => a.length - b.length);
}
