import { describe, expect, it } from "vitest";
import { Rng } from "../runtime/rng";
import type { ReachableRegion } from "./contracts";
import { pickWeighted } from "./shared";
import { OTHER_MEDIUM_CHANCE, pickWanderRegion } from "./wander";

// Wander's region pick (#140): keep to the medium the creature is in, switch now and then.

const land = (regionId: string, walkableArea = 100): ReachableRegion => ({
  regionId,
  kind: "land",
  walkableArea,
});
const water = (regionId: string, walkableArea = 100): ReachableRegion => ({
  regionId,
  kind: "water",
  walkableArea,
});

/** How often each region is picked from `here` over many draws. */
function shares(here: string, regions: ReachableRegion[], draws = 20_000) {
  const rng = Rng.fromSeed(140);
  const counts = new Map<string, number>();
  for (let k = 0; k < draws; k++) {
    const picked = pickWanderRegion(here, regions, rng);
    counts.set(picked, (counts.get(picked) ?? 0) + 1);
  }
  return (regionId: string) => (counts.get(regionId) ?? 0) / draws;
}

describe("wander's region pick", () => {
  it("keeps an amphibian mostly in its medium, and switches now and then", () => {
    const regions = [land("west"), land("east"), water("river", 400)];
    const fromLand = shares("west", regions);
    expect(fromLand("river")).toBeGreaterThan(OTHER_MEDIUM_CHANCE * 0.8);
    expect(fromLand("river")).toBeLessThan(OTHER_MEDIUM_CHANCE * 1.2);
    // Another region of its own kind, as often as before medium mattered.
    expect(fromLand("east")).toBeCloseTo((1 - OTHER_MEDIUM_CHANCE) * 0.3, 1);
    const fromWater = shares("river", regions);
    expect(fromWater("river")).toBeCloseTo(1 - OTHER_MEDIUM_CHANCE, 2);
    expect(fromWater("west") + fromWater("east")).toBeGreaterThan(0);
  });

  it("draws for a creature of one medium exactly as before", () => {
    // The pick before #140: another region with 0.3, by walkable area, else its own.
    const before = (here: string, regions: ReachableRegion[], rng: Rng) => {
      const others = regions.filter((r) => r.regionId !== here);
      return others.length > 0 && rng.chance(0.3) ? (pickWeighted(others, rng) ?? here) : here;
    };
    const walker = [land("west", 50), land("deck", 5), land("east", 80)];
    const swimmer = [water("river"), water("pond", 30)];
    for (const [here, regions] of [
      ["west", walker],
      ["river", swimmer],
    ] as const) {
      const a = Rng.fromSeed(7);
      const b = Rng.fromSeed(7);
      for (let k = 0; k < 2_000; k++) {
        expect(pickWanderRegion(here, regions, a)).toBe(before(here, regions, b));
      }
      // Same draws used, so the creature's stream carries on as it did.
      expect(a.state).toEqual(b.state);
    }
  });

  it("stays where it is when nothing else is reachable", () => {
    const rng = Rng.fromSeed(1);
    for (let k = 0; k < 100; k++)
      expect(pickWanderRegion("pond", [water("pond")], rng)).toBe("pond");
  });
});
