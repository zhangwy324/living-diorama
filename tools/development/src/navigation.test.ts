import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { formatDiagnostic, type RegionPosition } from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  hasLineOfSight,
  registerCoreEngine,
  WorldState,
  type Pathfinder,
  type Route,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { registerHollowCreatures, registerRiverCrossing, riverCrossingWorld } from "./index";

function load(register: (registries: Registries) => unknown): Registries {
  const registries = createRegistries();
  registerCoreEngine(registries);
  register(registries);
  const resolution = resolveReferences(registries);
  expect(resolution.diagnostics.map(formatDiagnostic)).toEqual([]);
  return registries;
}

function worldState(registries: Registries, worldId: string, seed = 1): WorldState {
  const created = WorldState.create(registries, { worldId, seed });
  if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
  return created.value;
}

/** Every waypoint and segment of every leg lies on walkable cells of that leg's region. */
function expectWalkable(pathfinder: Pathfinder, route: Route) {
  for (const leg of route.legs) {
    const mask = pathfinder.navigation.masks.get(leg.regionId)!;
    for (const p of leg.points) expect(mask.isWalkableAt(p.x, p.z)).toBe(true);
    for (let k = 1; k < leg.points.length; k++) {
      expect(hasLineOfSight(mask, leg.points[k - 1]!, leg.points[k]!)).toBe(true);
    }
  }
}

describe("river-crossing routes (stacked deck over water)", () => {
  const registries = load(registerRiverCrossing);
  const state = worldState(registries, "fixture:river-crossing");
  const pathfinder = state.pathfinderFor("fixture:pebble")!;
  const north: RegionPosition = { regionId: "north-bank", x: -2, z: -1.8 };
  const south: RegionPosition = { regionId: "south-bank", x: 1.5, z: 2.2 };

  it("crosses the river only over the deck", () => {
    const result = pathfinder.findRoute(north, south);
    if (!result.ok) throw new Error(result.detail);
    const { route } = result;
    expect(route.legs.map((l) => l.regionId)).toEqual(["north-bank", "bridge-deck", "south-bank"]);
    expect(route.legs.map((l) => l.exit?.connectionId)).toEqual([
      "bridge-north-end",
      "bridge-south-end",
      undefined,
    ]);
    expectWalkable(pathfinder, route);
    expect(route.legs.at(-1)!.points.at(-1)).toEqual({ x: 1.5, z: 2.2 });
    // Straight-line distance is about 5.3 m; the detour to the bridge adds a little.
    expect(route.length).toBeGreaterThan(5.3);
    expect(route.length).toBeLessThan(7.5);
  });

  it("resolves deck positions to the deck, not the water under it", () => {
    const deck = pathfinder.navigation.masks.get("bridge-deck")!;
    const river = state.model.regions.get("river")!;
    const cell = deck.cellAt(0.25, 0.25);
    expect(deck.isWalkableAt(0.25, 0.25)).toBe(true);
    expect(deck.height(cell)).toBeGreaterThan(river.surface.heightAt(0.25, 0.25)! + 0.4);
  });

  it("switches region on a cell edge that lies on the portal, within the step height", () => {
    const north = state.model.connections.find((c) => c.id === "bridge-north-end")!;
    const crossings = pathfinder.crossings(north);
    expect(crossings.length).toBeGreaterThan(0);
    for (const x of crossings) {
      expect(Math.hypot(x.to.x - x.from.x, x.to.z - x.from.z)).toBeCloseTo(0.5);
      expect((x.from.z + x.to.z) / 2).toBeCloseTo(-1);
    }
    // Both directions of a bidirectional connection.
    expect(new Set(crossings.map((x) => x.fromRegionId))).toEqual(
      new Set(["north-bank", "bridge-deck"]),
    );
  });

  it("reports unwalkable endpoints and unreachable goals", () => {
    expect(pathfinder.findRoute({ regionId: "river", x: 0, z: 0 }, north)).toMatchObject({
      ok: false,
      reason: "start_not_walkable",
    });
    expect(pathfinder.findRoute(north, { regionId: "north-bank", x: -3, z: -2 })).toMatchObject({
      ok: false,
      reason: "goal_not_walkable", // inside the pine's footprint
    });

    const bare = load((r) => {
      registerRiverCrossing(r);
      r.worlds.register({ ...riverCrossingWorld, id: "fixture:no-bridge", structures: [] });
    });
    const nobridge = worldState(bare, "fixture:no-bridge").pathfinderFor("fixture:pebble")!;
    expect(nobridge.findRoute(north, south)).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("spreads crossings at least 1 m apart over a wide portal", () => {
    const wide = structuredClone(riverCrossingWorld);
    wide.id = "fixture:wide-bridge";
    const bridge = wide.structures[0]!;
    const deck = bridge.regions[0]!;
    (deck.surface.params as { width: number }).width = 3;
    deck.footprint = deck.footprint.map((p) => ({ ...p, x: Math.sign(p.x) * 1.5 }));
    for (const c of bridge.connections) {
      c.portal.a.x = -1.5;
      c.portal.b.x = 1.5;
    }
    const registries = load((r) => {
      registerRiverCrossing(r);
      r.worlds.register(wide);
    });
    const state = worldState(registries, "fixture:wide-bridge");
    const connection = state.model.connections.find((c) => c.id === "bridge-north-end")!;
    const xs = state
      .pathfinderFor("fixture:pebble")!
      .crossings(connection)
      .filter((x) => x.fromRegionId === "north-bank")
      .map((x) => x.from.x);
    expect(xs).toEqual([-1.25, -0.25, 0.75]);
  });

  it("plans the same route after its cached data is invalidated", () => {
    const before = pathfinder.findRoute(north, south);
    pathfinder.invalidateRegions(["bridge-deck"]);
    expect(pathfinder.findRoute(north, south)).toEqual(before);
  });
});

/** A small deterministic random stream (mulberry32), so samples are the same on every run. */
function sampler(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
}

/**
 * For sampled walkable starts, `findRoute` reaches every sampled cell `reachableCells` lists, with
 * walkable legs, and fails on sampled walkable cells it doesn't list.
 */
function expectReachabilityAgrees(pathfinder: Pathfinder, starts: number, goals: number) {
  const pick = sampler(131);
  const walkable: RegionPosition[] = [];
  for (const [regionId, mask] of pathfinder.navigation.masks) {
    for (let cell = 0; cell < mask.states.length; cell++) {
      if (mask.isWalkableAt(mask.center(cell).x, mask.center(cell).z)) {
        walkable.push({ regionId, ...mask.center(cell) });
      }
    }
  }
  expect(walkable.length).toBeGreaterThan(0);
  for (let k = 0; k < starts; k++) {
    const from = pick(walkable);
    const reachable = pathfinder.reachableCells(from);
    const listed: RegionPosition[] = [...reachable].flatMap(([regionId, cells]) => {
      const mask = pathfinder.navigation.masks.get(regionId)!;
      return cells.map((cell) => ({ regionId, ...mask.center(cell) }));
    });
    const isListed = (p: RegionPosition) => {
      const mask = pathfinder.navigation.masks.get(p.regionId)!;
      return reachable.get(p.regionId)?.includes(mask.cellAt(p.x, p.z)) ?? false;
    };
    for (let g = 0; g < goals; g++) {
      const to = pick(listed);
      const result = pathfinder.findRoute(from, to);
      if (!result.ok) throw new Error(`listed as reachable, but ${result.detail}`);
      expectWalkable(pathfinder, result.route);
      const other = pick(walkable);
      expect(pathfinder.findRoute(from, other).ok).toBe(isListed(other));
    }
  }
}

describe("routes between separate areas of one region", () => {
  // The north bank is cut in two by a row of rocks; two bridges lead from each half to the south
  // bank, so the halves meet only through other regions.
  const split = structuredClone(riverCrossingWorld);
  split.id = "fixture:split-bank";
  const bridge = split.structures[0]!;
  split.structures = [-2, 2].map((dx) => {
    const copy = structuredClone(bridge);
    const side = dx < 0 ? "west" : "east";
    copy.id = `bridge-${side}`;
    copy.transform.position.x += dx;
    const deck = copy.regions[0]!;
    deck.id = `deck-${side}`;
    const params = deck.surface.params as { centerline: { x: number }[] };
    for (const p of params.centerline) p.x += dx;
    deck.footprint = deck.footprint.map((p) => ({ ...p, x: p.x + dx }));
    for (const c of copy.connections) {
      c.id = `${c.id}-${side}`;
      if (c.from === "bridge-deck") c.from = deck.id;
      if (c.to === "bridge-deck") c.to = deck.id;
      c.portal.a.x += dx;
      c.portal.b.x += dx;
    }
    return copy;
  });
  split.props = [-3, -2.6, -2.2, -1.8, -1.4, -1, -0.6].map((z, k) => ({
    id: `wall-${k}`,
    prop: "fixture:rock",
    transform: { position: { x: 0, y: 0.5, z } },
  }));
  const registries = load((r) => {
    registerRiverCrossing(r);
    r.worlds.register(split);
  });
  const pathfinder = worldState(registries, "fixture:split-bank").pathfinderFor("fixture:pebble")!;
  const west: RegionPosition = { regionId: "north-bank", x: -2.5, z: -2 };
  const east: RegionPosition = { regionId: "north-bank", x: 2.5, z: -2 };

  it("splits the north bank into two areas", () => {
    expect(pathfinder.navigation.masks.get("north-bank")!.components()).toHaveLength(2);
  });

  it("routes between the halves through the other regions", () => {
    const result = pathfinder.findRoute(west, east);
    if (!result.ok) throw new Error(result.detail);
    expect(result.route.legs.map((l) => l.regionId)).toEqual([
      "north-bank",
      "deck-west",
      "south-bank",
      "deck-east",
      "north-bank",
    ]);
    expectWalkable(pathfinder, result.route);
    expect(result.route.legs.at(-1)!.points.at(-1)).toEqual({ x: 2.5, z: -2 });
  });

  it("keeps a route inside one area of the region", () => {
    const result = pathfinder.findRoute(west, { regionId: "north-bank", x: -1, z: -2.5 });
    if (!result.ok) throw new Error(result.detail);
    expect(result.route.legs.map((l) => l.regionId)).toEqual(["north-bank"]);
  });

  it("agrees with reachability", () => {
    expect(pathfinder.reachableCells(west).get("north-bank")).toEqual(
      pathfinder.reachableCells(east).get("north-bank"),
    );
    expectReachabilityAgrees(pathfinder, 20, 10);
  });

  it("fails when the halves meet through nothing", () => {
    const registries = load((r) => {
      registerRiverCrossing(r);
      r.worlds.register({
        ...split,
        id: "fixture:split-one-bridge",
        structures: [split.structures[0]!],
      });
    });
    const state = worldState(registries, "fixture:split-one-bridge");
    const lonely = state.pathfinderFor("fixture:pebble")!;
    expect(lonely.findRoute(west, east)).toMatchObject({ ok: false, reason: "unreachable" });
    expect(lonely.reachableCells(west).get("north-bank")).not.toContain(
      lonely.navigation.masks.get("north-bank")!.cellAt(east.x, east.z),
    );
  });
});

describe("Woodland Hollow routes", () => {
  const registries = load(registerBuiltInContent);
  const state = worldState(registries, "hollow:woodland-hollow");
  const pathfinder = state.pathfinderFor("hollow:mossling")!;
  // The mossling walks, so the river spawn point for water-only creatures isn't one of its own.
  const spawns = state.model.definition.spawnPoints.filter(
    (s) => state.model.regions.get(s.position.regionId)?.kind !== "water",
  );

  it("routes between every pair of land spawn points, west to east only over the bridge", () => {
    expect(spawns).toHaveLength(4);
    for (const a of spawns) {
      for (const b of spawns) {
        const result = pathfinder.findRoute(a.position, b.position);
        if (!result.ok) throw new Error(`${a.id} → ${b.id}: ${result.detail}`);
        expectWalkable(pathfinder, result.route);
        const regions = result.route.legs.map((l) => l.regionId);
        const west = (r: string) => r === "west-woods";
        for (let k = 1; k < regions.length; k++) {
          // The banks never meet directly; the deck is always between them.
          expect(west(regions[k - 1]!) && !west(regions[k]!) && regions[k] !== "bridge-deck").toBe(
            false,
          );
        }
        if (west(a.position.regionId) !== west(b.position.regionId)) {
          expect(regions).toContain("bridge-deck");
        }
      }
    }
  });

  it("agrees with reachability for walkers, swimmers and amphibians", () => {
    const registries = load(registerHollowCreatures);
    const state = worldState(registries, "hollow:woodland-hollow");
    const species = registries.species.values();
    expect(species.length).toBeGreaterThan(3);
    for (const { id } of species) {
      expectReachabilityAgrees(state.pathfinderFor(id)!, 8, 6);
    }
  });
});

describe("WorldState", () => {
  const registries = load(registerBuiltInContent);

  it("spawns creatures deterministically with their own random streams", () => {
    const spawnAll = () => {
      const state = worldState(registries, "hollow:woodland-hollow", 99);
      return [1, 2, 3].map(() => {
        const result = state.spawn("hollow:mossling");
        if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join());
        return result.value;
      });
    };
    const first = spawnAll();
    expect(first.map((c) => c.id)).toEqual(["creature-1", "creature-2", "creature-3"]);
    expect(spawnAll()).toEqual(first);
    expect(new Set(first.map((c) => c.rng.key)).size).toBe(3);
    for (const c of first) {
      expect(c.heading).toBeGreaterThanOrEqual(-Math.PI);
      expect(c.heading).toBeLessThan(Math.PI);
      expect(c.speciesVersion).toBe(registries.species.get("hollow:mossling")!.version);
    }
  });

  it("spawns at a requested point and rejects unknown species, points and worlds", () => {
    const state = worldState(registries, "hollow:woodland-hollow");
    const meadow = state.spawn("hollow:mossling", "meadow");
    expect(meadow.ok && meadow.value.position).toEqual({ regionId: "east-meadow", x: 13, z: 6 });
    expect(state.creatures.size).toBe(1);
    const codes = (r: { ok: boolean; diagnostics?: { code: string }[] }) =>
      r.diagnostics?.map((d) => d.code);
    expect(codes(state.spawn("hollow:nobody"))).toEqual(["unknown_species"]);
    expect(codes(state.spawn("hollow:mossling", "nowhere"))).toEqual(["no_spawn_point"]);
    expect(codes(WorldState.create(registries, { worldId: "hollow:atlantis", seed: 1 }))).toEqual([
      "unknown_world",
    ]);
  });
});
