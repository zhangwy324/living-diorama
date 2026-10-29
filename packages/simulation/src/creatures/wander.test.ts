import type { RegionKind } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { Rng } from "../runtime/rng";
import type { ReachableRegion } from "./contracts";
import { pickWeighted } from "./shared";
import { OTHER_MEDIUM_CHANCE, pickWanderRegion } from "./wander";

// Wander's region pick (#140): keep to the medium the creature is in, and to what it reaches in
// it; switch now and then.

const region =
  (kind: RegionKind) =>
  (regionId: string, walkableArea = 100, sameMediumArea = walkableArea): ReachableRegion => ({
    regionId,
    kind,
    walkableArea,
    sameMediumArea,
  });
const land = region("land");
const water = region("water");

/** How often each region is picked from `here` over many draws, and with which `sameMedium`. */
function shares(here: string, regions: ReachableRegion[], draws = 20_000) {
  const rng = Rng.fromSeed(140);
  const counts = new Map<string, number>();
  for (let k = 0; k < draws; k++) {
    const { regionId, sameMedium } = pickWanderRegion(here, regions, rng);
    const key = `${regionId}${sameMedium ? "" : " (other medium)"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (key: string) => (counts.get(key) ?? 0) / draws;
}

describe("wander's region pick", () => {
  it("keeps an amphibian mostly in its medium, and switches now and then", () => {
    const regions = [land("west"), land("east"), water("river", 400, 0)];
    const fromLand = shares("west", regions);
    expect(fromLand("river (other medium)")).toBeGreaterThan(OTHER_MEDIUM_CHANCE * 0.8);
    expect(fromLand("river (other medium)")).toBeLessThan(OTHER_MEDIUM_CHANCE * 1.2);
    // Another region it reaches on land, as often as before medium mattered.
    expect(fromLand("east")).toBeCloseTo((1 - OTHER_MEDIUM_CHANCE) * 0.3, 1);
    expect(fromLand("west") + fromLand("east") + fromLand("river (other medium)")).toBe(1);
    const fromWater = shares("river", [land("west", 100, 0), water("river")]);
    expect(fromWater("river")).toBeCloseTo(1 - OTHER_MEDIUM_CHANCE, 2);
    expect(fromWater("west (other medium)")).toBeGreaterThan(0);
  });

  it("counts land reached only across the water as another medium", () => {
    // A large amphibian too big for the bridge: the far bank only by swimming.
    const regions = [land("west"), land("east", 100, 0), water("river", 400, 0)];
    const picks = shares("west", regions);
    expect(picks("east")).toBe(0);
    expect(picks("east (other medium)")).toBeCloseTo(OTHER_MEDIUM_CHANCE * (100 / 500), 2);
    expect(picks("west")).toBeCloseTo(1 - OTHER_MEDIUM_CHANCE, 2);
  });

  it("weighs another region by the area it reaches there in its medium", () => {
    const picks = shares("west", [land("west"), land("east", 300, 100), land("deck", 100, 100)]);
    expect(picks("east")).toBeCloseTo(picks("deck"), 1);
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
        expect(pickWanderRegion(here, regions, a)).toEqual({
          regionId: before(here, regions, b),
          sameMedium: true,
        });
      }
      // Same draws used, so the creature's stream carries on as it did.
      expect(a.state).toEqual(b.state);
    }
  });

  it("stays where it is when nothing else is reachable", () => {
    const rng = Rng.fromSeed(1);
    for (let k = 0; k < 100; k++) {
      expect(pickWanderRegion("pond", [water("pond")], rng)).toEqual({
        regionId: "pond",
        sameMedium: true,
      });
    }
  });
});
