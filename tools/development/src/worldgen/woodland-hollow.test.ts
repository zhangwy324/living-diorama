import { builtInDefinitions, registerBuiltInContent } from "@living-diorama/built-in-content";
import { formatDiagnostic, type WorldDefinition } from "@living-diorama/content-schema";
import { createRegistries, resolveReferences } from "@living-diorama/extension-api";
import { checkWorld, registerCoreEngine } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { generateWoodlandHollow } from "./woodland-hollow";

// Roadmap M2 exit criteria for the built-in world.

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

  it("puts every spawn point on a walkable cell", () => {
    const { registries, world } = load();
    const [nav] = checkWorld(world, registries).navigations;
    for (const spawn of world.spawnPoints) {
      const mask = nav!.masks.get(spawn.position.regionId)!;
      expect(mask.isWalkableAt(spawn.position.x, spawn.position.z), spawn.id).toBe(true);
    }
  });
});
