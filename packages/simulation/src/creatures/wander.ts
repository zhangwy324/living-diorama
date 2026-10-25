import type { RegionPosition } from "@living-diorama/content-schema";
import type { Rng } from "../runtime/rng";
import type { BehaviorProvider, CreatureObservation, ReachableRegion } from "./contracts";

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

function pickWeighted(regions: readonly ReachableRegion[], rng: Rng): string | undefined {
  const total = regions.reduce((sum, r) => sum + r.walkableArea, 0);
  let roll = rng.next() * total;
  for (const region of regions) {
    roll -= region.walkableArea;
    if (roll < 0) return region.regionId;
  }
  return regions.at(-1)?.regionId;
}

function pickDestination(
  { creature, world }: CreatureObservation,
  rng: Rng,
): RegionPosition | undefined {
  const here = creature.position;
  const others = world.reachableRegions().filter((r) => r.regionId !== here.regionId);
  const regionId =
    others.length > 0 && rng.chance(OTHER_REGION_CHANCE)
      ? (pickWeighted(others, rng) ?? here.regionId)
      : here.regionId;
  for (let attempt = 0; attempt < DESTINATION_ATTEMPTS; attempt++) {
    const point = world.randomWalkablePoint(regionId, rng);
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
