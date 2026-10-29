import { builtInDefinitions, registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  formatDiagnostic,
  type SizeClass,
  type WorldDefinition,
} from "@living-diorama/content-schema";
import { createRegistries, resolveReferences } from "@living-diorama/extension-api";
import { checkWorld, registerCoreEngine, SWIM_SUBMERSION } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { createSimulation, runWithInvariants } from "../simulation-run";
import { generateWoodlandHollow } from "./woodland-hollow";

// Roadmap M2 exit criteria for the built-in world, and its spawn point for water-only creatures
// (ADR 0020 §6).

const hollow = { register: registerBuiltInContent, worldId: "hollow:woodland-hollow" };
const SIZES = ["tiny", "small", "medium", "large"] as const;
const LAND = { "core:land": 1 };
const SWIM = { "core:swim": 1 };

function load() {
  const registries = createRegistries();
  const results = [...registerCoreEngine(registries), ...registerBuiltInContent(registries)];
  const world = registries.worlds.get("hollow:woodland-hollow") as WorldDefinition;
  return { registries, results, world };
}

describe("Woodland Hollow", () => {
  it("matches its generator output (run `pnpm worldgen` after changing the layout)", () => {
    expect(generateWoodlandHollow()).toEqual(builtInDefinitions.worlds[0]);
  });

  it("validates and resolves through the registries", () => {
    const { registries, results } = load();
    expect(results.flatMap((r) => (r.ok ? [] : r.diagnostics)).map(formatDiagnostic)).toEqual([]);
    expect(resolveReferences(registries).diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it("passes every world check without warnings", () => {
    const { registries, world } = load();
    expect(checkWorld(world, registries).diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it("connects the two banks for walkers only through the bridge", () => {
    const { registries, world } = load();
    const [nav] = checkWorld(world, registries).navigations;
    expect([...nav!.reachableRegions("west-woods")].sort()).toEqual([
      "bridge-deck",
      "east-meadow",
      "summit",
      "west-woods",
    ]);
    expect(nav!.reachableRegions("summit").has("west-woods")).toBe(true);

    const [noBridge] = checkWorld({ ...world, structures: [] }, registries).navigations;
    expect([...noBridge!.reachableRegions("west-woods")]).toEqual(["west-woods"]);
    expect([...noBridge!.reachableRegions("east-meadow")].sort()).toEqual([
      "east-meadow",
      "summit",
    ]);
  });

  it("puts every spawn point on a walkable cell for every profile that moves in its region", () => {
    const { registries, world } = load();
    const [nav] = checkWorld(world, registries).navigations;
    for (const spawn of world.spawnPoints) {
      const mask = nav!.masks.get(spawn.position.regionId)!;
      const onLand = mask.region.kind !== "water";
      expect(mask.isWalkableAt(spawn.position.x, spawn.position.z), spawn.id).toBe(onLand);
    }
    // Walkers, water-only swimmers and amphibians of every size can stand on each spawn point
    // whose region they move in: no `spawn_not_walkable` limit and no `no_spawn_point` error.
    const simulation = createSimulation({ ...hollow, seed: 1 });
    for (const capabilities of [LAND, SWIM, { ...LAND, ...SWIM }]) {
      for (const size of SIZES) {
        const checked = simulation.checkLimits(size, capabilities);
        const found = checked.ok ? checked.value : checked.diagnostics;
        expect(found.map((d) => d.code).filter((c) => c.includes("spawn"))).toEqual([]);
      }
    }
  });
});

describe("water-only creatures in Woodland Hollow (ADR 0020 §6)", () => {
  /** A drawn swimmer as the app would send it: water only, wandering. */
  const swimmer = (name: string, sizeClass: SizeClass = "medium") => ({
    schemaVersion: 1,
    id: `user:${name}`,
    version: "1.0.0",
    name,
    appearance: `user:${name}/appearance.png`,
    sizeClass,
    capabilities: SWIM,
    baseSpeed: 0.5,
    behaviors: ["core:wander"],
    body: { template: "swimmer" },
  });
  const URL = "blob:http://localhost/drawing";
  const pool = { regionId: "river", x: 4.25, z: 14.25 };

  it("registers at every size, with no limit about leaving water it never needs to leave", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const limits = Object.fromEntries(
      SIZES.map((size) => {
        const result = simulation.registerSpecies(swimmer(size, size), URL);
        if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
        return [size, result.value.limits.map((d) => d.code)];
      }),
    );
    // `no_water_exit` is only for a profile that also moves on land. A large swimmer can't pass
    // under the bridge deck, so the river is two areas for it; the spawn point is in the south one.
    expect(limits).toEqual({ tiny: [], small: [], medium: [], large: ["disconnected_region"] });
  });

  it("appears only at the river spawn point, swimming; walkers never appear there", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    expect(simulation.registerSpecies(swimmer("minnow"), URL).ok).toBe(true);
    for (let n = 0; n < 3; n++) {
      const spawned = simulation.spawn("user:minnow");
      if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
      expect(spawned.value.position).toEqual(pool);
    }
    expect(simulation.snapshot().creatures[0]).toMatchObject({
      animation: "swim",
      submersion: SWIM_SUBMERSION,
    });
    const walker = simulation.spawn("hollow:mossling", "river-pool");
    expect(walker.ok ? [] : walker.diagnostics.map((d) => d.code)).toEqual(["no_spawn_point"]);
  });

  it("swims about the river with every invariant kept", { timeout: 60_000 }, () => {
    const regions = new Set<string>();
    let farthest = 0;
    const report = runWithInvariants({
      ...hollow,
      speciesId: "hollow:mossling",
      seed: 5,
      ticks: 12_000,
      creatures: 2,
      onTick: (simulation) => {
        if (simulation.tick === 10) {
          expect(simulation.registerSpecies(swimmer("minnow"), URL).ok).toBe(true);
          for (let n = 0; n < 3; n++) expect(simulation.spawn("user:minnow").ok).toBe(true);
        }
        for (const creature of simulation.state.creatures.values()) {
          if (creature.speciesId !== "user:minnow") continue;
          const { regionId, x, z } = creature.position;
          regions.add(regionId);
          farthest = Math.max(farthest, Math.hypot(x - pool.x, z - pool.z));
        }
      },
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    expect([...regions]).toEqual(["river"]);
    expect(farthest).toBeGreaterThan(3);
  });
});
