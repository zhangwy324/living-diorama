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
 * into the water from a bank, when there is one (#140), for a creature with no preference
 * between land and water. Wander otherwise keeps to its medium and to what it can reach in it,
 * so a creature that walks and swims switches only now and then instead of splashing back and
 * forth. Tuned on `pnpm soak:quick`: an amphibian makes a few dozen bank jumps a day, not
 * hundreds, and still spends part of the day in the water.
 */
export const OTHER_MEDIUM_CHANCE = 0.015;

/** 0 keeps to land, 1 to water, 0.5 (the default) has no preference (#163). */
const WATER_PREFERENCE = "core:water_preference";
const NO_PREFERENCE = 0.5;

/**
 * Chance that a walk changes medium for a creature with water preference `w`:
 * 2·w·`OTHER_MEDIUM_CHANCE` out of land (or any medium but water), 2·(1 − w)·`OTHER_MEDIUM_CHANCE`
 * out of water, so exactly `OTHER_MEDIUM_CHANCE` both ways at 0.5 (#163).
 */
export function otherMediumChance(inWater: boolean, waterPreference: number): number {
  return 2 * (inWater ? 1 - waterPreference : waterPreference) * OTHER_MEDIUM_CHANCE;
}

/** Where a walk heads: a region, and whether its point must be reachable without a medium change. */
export interface WanderRegion {
  regionId: string;
  sameMedium: boolean;
}

/**
 * The region a walk heads for. Now and then, with `otherMediumChance`, one the creature can
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
  waterPreference = NO_PREFERENCE,
): WanderRegion {
  const others = regions.filter((r) => r.regionId !== hereRegionId);
  const otherMedium = others.filter((r) => r.sameMediumArea === 0);
  const inWater = regions.find((r) => r.regionId === hereRegionId)?.kind === "water";
  if (otherMedium.length > 0 && rng.chance(otherMediumChance(inWater, waterPreference))) {
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
  { creature, traits, world }: CreatureObservation,
  rng: Rng,
): RegionPosition | undefined {
  const here = creature.position;
  const { regionId, sameMedium } = pickWanderRegion(
    here.regionId,
    world.reachableRegions(),
    rng,
    traits[WATER_PREFERENCE] ?? NO_PREFERENCE,
  );
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
    { registry: "traits", id: WATER_PREFERENCE, version: "^1.0.0" },
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
