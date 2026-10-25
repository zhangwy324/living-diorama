import { formatDiagnostic, type Result } from "@living-diorama/content-schema";
import { createRegistries, resolveReferences } from "@living-diorama/extension-api";
import { checkWorld, registerCoreEngine } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { plankBridge, registerRiverCrossing, riverCrossingWorld } from "./index";

const failures = (results: Result<unknown>[]): string[] =>
  results.flatMap((r) => (r.ok ? [] : r.diagnostics.map(formatDiagnostic)));

function load() {
  const registries = createRegistries();
  const registered = [...registerCoreEngine(registries), ...registerRiverCrossing(registries)];
  return { registries, registered };
}

describe("river-crossing fixture", () => {
  it("registers and resolves every reference", () => {
    const { registries, registered } = load();
    expect(failures(registered)).toEqual([]);

    const resolution = resolveReferences(registries);
    expect(resolution.diagnostics.map(formatDiagnostic)).toEqual([]);
    const order = resolution.loadOrder.map((k) => `${k.registry}/${k.id}`);
    const before = (a: string, b: string) =>
      expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    before("surfaces/core:deck", "worlds/fixture:river-crossing");
    before("structures/fixture:plank-bridge", "worlds/fixture:river-crossing");
    before("behaviors/core:wander", "species/fixture:pebble");
  });

  it("stacks the deck region above the water region", () => {
    const world = load().registries.worlds.get("fixture:river-crossing")!;
    const deck = world.structures[0]!.regions[0]!;
    const river = world.regions.find((r) => r.kind === "water")!;
    const zs = (r: typeof deck) => r.footprint.map((p) => p.z);
    expect(Math.min(...zs(deck))).toBeLessThan(Math.min(...zs(river)));
    expect(Math.max(...zs(deck))).toBeGreaterThan(Math.max(...zs(river)));
  });

  it("reports bad surface params and unknown structure types at their paths", () => {
    const world = structuredClone(riverCrossingWorld);
    world.id = "fixture:broken-crossing";
    const bridge = world.structures[0]!;
    bridge.structure = "fixture:rope-bridge";
    (bridge.regions[0]!.surface.params as { width: number }).width = 0;

    const registries = createRegistries();
    registerCoreEngine(registries);
    expect(
      failures([registries.structures.register(plankBridge), registries.worlds.register(world)]),
    ).toEqual([]);
    const messages = resolveReferences(registries).diagnostics.map(formatDiagnostic);
    expect(messages).toEqual([
      'error: worlds/fixture:broken-crossing structures[0].structure: "fixture:rope-bridge" is not registered in structures (unresolved_reference)',
      "error: worlds/fixture:broken-crossing structures[0].regions[0].surface.params.width: Too small: expected number to be >0 (too_small)",
    ]);
  });
});

describe("river-crossing world check", () => {
  it("passes the semantic checks and joins the banks only through the deck", () => {
    const { registries } = load();
    const world = registries.worlds.get("fixture:river-crossing")!;
    const check = checkWorld(world, registries);
    expect(check.diagnostics.map(formatDiagnostic)).toEqual([]);
    const [nav] = check.navigations;
    expect([...nav!.reachableRegions("north-bank")].sort()).toEqual([
      "bridge-deck",
      "north-bank",
      "south-bank",
    ]);

    const withoutBridge = { ...world, structures: [] };
    const [bare] = checkWorld(withoutBridge, registries).navigations;
    expect([...bare!.reachableRegions("north-bank")]).toEqual(["north-bank"]);
  });

  it("resolves deck positions above the river it overlaps", () => {
    const { registries } = load();
    const model = checkWorld(registries.worlds.get("fixture:river-crossing")!, registries).model!;
    const deck = model.regions.get("bridge-deck")!.surface;
    const river = model.regions.get("river")!.surface;
    expect(deck.heightAt(0, 0)).toBeCloseTo(0.7);
    expect(river.heightAt(0, 0)).toBeCloseTo(0.2);
    expect(deck.heightAt(0.6, 0)).toBeUndefined();
    expect(deck.heightAt(0, 1.1)).toBeUndefined();
  });
});
