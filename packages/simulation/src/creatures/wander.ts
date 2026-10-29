import type { RegionPosition } from "@living-diorama/content-schema";
import type { Rng } from "../runtime/rng";
import type { BehaviorProvider, CreatureObservation, ReachableRegion } from "./contracts";
import { pickWeighted } from "./shared";

// `core:wander` (roadmap M3 task 7, ADR 0006 §9): alternate idling with walking to a random
// reachable point, sometimes in another region so that structures like bridges get used.
// Starting values, to tune.

const OTHER_REGION_CHANCE = 0.3;
const IDLE_SECONDS = { min: 3, max: 12 };
/** A destination closer than this is not worth walking to. */
const MIN_DESTINATION_DISTANCE = 2;
const DESTINATION_ATTEMPTS = 8;
const UTILITY = 0.1;

interface WanderMemory {
  /** Alternates, so a walk is always followed by a rest and the creature doesn't jitter. */
  walkNext?: boolean;
}

/**
 * Chance that a walk heads for a region the creature can reach only by changing medium, e.g.
 * into the water from a bank, when there is one (#140). Wander otherwise keeps to its medium and
 * to what it can reach in it, so a creature that walks and swims switches only now and then
 * instead of splashing back and forth. Tuned on `pnpm soak:quick`: an amphibian makes a few dozen
 * bank jumps a day, not hundreds, and still spends part of the day in the water.
 */
export const OTHER_MEDIUM_CHANCE = 0.015;

/** Where a walk heads: a region, and whether its point must be reachable without a medium change. */
export interface WanderRegion {
  regionId: string;
  sameMedium: boolean;
}

/**
 * The region a walk heads for. Now and then, with `OTHER_MEDIUM_CHANCE`, one the creature can
 * reach only by changing medium (water from land, or land across the water from its own), by
 * walkable area. Otherwise its own region or, with `OTHER_REGION_CHANCE`, another it can reach
 * in its medium, by the area it reaches there, with the point then drawn from that area too. A
 * creature that never changes medium, such as a walker or a water-only swimmer, draws exactly
 * as it did before medium mattered.
 */
export function pickWanderRegion(
  hereRegionId: string,
  regions: readonly ReachableRegion[],
  rng: Rng,
): WanderRegion {
  const others = regions.filter((r) => r.regionId !== hereRegionId);
  const otherMedium = others.filter((r) => r.sameMediumArea === 0);
  if (otherMedium.length > 0 && rng.chance(OTHER_MEDIUM_CHANCE)) {
    return { regionId: pickWeighted(otherMedium, rng) ?? hereRegionId, sameMedium: false };
  }
  const sameMedium = others
    .filter((r) => r.sameMediumArea > 0)
    .map((r) => ({ ...r, walkableArea: r.sameMediumArea }));
  const regionId =
    sameMedium.length > 0 && rng.chance(OTHER_REGION_CHANCE)
      ? (pickWeighted(sameMedium, rng) ?? hereRegionId)
      : hereRegionId;
  return { regionId, sameMedium: true };
}

function pickDestination(
  { creature, world }: CreatureObservation,
  rng: Rng,
): RegionPosition | undefined {
  const here = creature.position;
  const { regionId, sameMedium } = pickWanderRegion(here.regionId, world.reachableRegions(), rng);
  for (let attempt = 0; attempt < DESTINATION_ATTEMPTS; attempt++) {
    const point = world.randomWalkablePoint(regionId, rng, { sameMedium });
    if (!point) return undefined;
    if (Math.hypot(point.x - here.x, point.z - here.z) >= MIN_DESTINATION_DISTANCE) return point;
  }
  return undefined;
}

export const wanderBehavior: BehaviorProvider = {
  id: "core:wander",
  version: "1.0.0",
  dependencies: [
    { registry: "actions", id: "core:idle", version: "^1.0.0" },
    { registry: "actions", id: "core:follow_path", version: "^1.0.0" },
  ],
  evaluate(observation, memory, rng) {
    const state = memory as WanderMemory;
    if (state.walkNext) {
      state.walkNext = false;
      const destination = pickDestination(observation, rng);
      if (destination) {
        return { action: "core:follow_path", params: { destination }, utility: UTILITY };
      }
    }
    state.walkNext = true;
    return {
      action: "core:idle",
      params: { seconds: rng.range(IDLE_SECONDS.min, IDLE_SECONDS.max) },
      utility: UTILITY,
    };
  },
};

export const coreBehaviors: readonly BehaviorProvider[] = [wanderBehavior];
