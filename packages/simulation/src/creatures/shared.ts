import type { Rng } from "../runtime/rng";
import type { CreatureObservation, PathState, ReachableRegion, SpotOptions } from "./contracts";

// Helpers that core behaviors and actions share.

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A whole number from `min` up. */
export const isIntFrom = (value: unknown, min: number): value is number =>
  Number.isInteger(value) && (value as number) >= min;

/** A path an action walks, e.g. from a save: waypoints with finite coordinates, `next` in range. */
export function isPathState(value: unknown): value is PathState {
  if (!isRecord(value) || !Array.isArray(value.points)) return false;
  const { points, next } = value;
  return (
    isIntFrom(next, 0) &&
    next <= points.length &&
    points.every(
      (p) =>
        isRecord(p) &&
        typeof p.regionId === "string" &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.z) &&
        (p.connectionId === undefined || typeof p.connectionId === "string"),
    )
  );
}

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
 * (ADR 0018 amendments, §10): only the `PATHED_CANDIDATES` nearest by straight line that have a
 * spot the creature can reach, leaving out `skip`, get a route, its spot found with `spotOptions`.
 * Undefined if none can be reached.
 */
export function chooseNearestByRoute(
  observation: CreatureObservation,
  affordanceId: string,
  skip?: (placementId: string) => boolean,
  spotOptions?: SpotOptions,
): PlaceChoice | undefined {
  return routeNearest(observation, affordanceId, skip, spotOptions)[0];
}

/**
 * The `PATHED_CANDIDATES` known places offering `affordanceId` nearest by straight line, leaving
 * out `skip`, that the creature can reach, with their route lengths, shortest route first (the
 * first in straight-line order on a tie). A place without a spot the creature can reach (#95),
 * e.g. across water from a walker, is passed over and doesn't count towards the few that get a
 * route, so it can't hide reachable places further away. Spots are found with `spotOptions`: with
 * `clearOfSleepers`, a full place has none (issue #158).
 */
export function routeNearest(
  { creature, knowledge, world }: CreatureObservation,
  affordanceId: string,
  skip: (placementId: string) => boolean = () => false,
  spotOptions?: SpotOptions,
): PlaceChoice[] {
  const here = creature.position;
  const nearest = (knowledge.places[affordanceId] ?? [])
    .flatMap(({ placementId }) => {
      const place = skip(placementId) ? undefined : world.place(placementId);
      return place && Object.hasOwn(place.affordances, affordanceId)
        ? [{ placementId, distance: Math.hypot(place.x - here.x, place.z - here.z) }]
        : [];
    })
    .sort((a, b) => a.distance - b.distance);
  const routed: PlaceChoice[] = [];
  let pathed = 0;
  for (const { placementId } of nearest) {
    if (pathed === PATHED_CANDIDATES) break;
    const spot = world.spotAt(placementId, spotOptions);
    if (!spot) continue;
    pathed++;
    const length = world.routeLength(spot);
    if (length !== undefined) routed.push({ placementId, length });
  }
  // Stable, so equal routes keep their straight-line order.
  return routed.sort((a, b) => a.length - b.length);
}
