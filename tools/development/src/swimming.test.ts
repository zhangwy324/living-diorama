import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  formatDiagnostic,
  WORLD_TOLERANCES,
  type RegionPosition,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import {
  BANK_CROSSING_COST,
  bankReach,
  distanceToPolygonEdge,
  isJumpClear,
  JUMP_DECK_DEPTH,
  JUMP_STRUCTURE_MARGIN,
  pointInPolygon,
  CellState,
  checkWorld,
  SWIM_SUBMERSION,
  TURN_RATE,
  WALK_TURN_LIMIT,
  type BehaviorProvider,
  type Proposal,
  type Simulation,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import {
  carp,
  minnow,
  newt,
  otter,
  pond as pondVariant,
  pondWorld,
  registerHollowCreatures,
  registerPond,
  vole,
} from "./index";
import { createSimulation, loadContent, runWithInvariants } from "./simulation-run";

// Swimming and locomotion styles (ADR 0020, M16 PR 2, with the owner's revision of §4), on the
// pond fixture: water walkability, the derived banks between land and water, routes across them,
// the snapshot's profile and submersion, the integrity checks, and the smooth turn when setting
// off (#121).

const pond = { register: registerPond, worldId: "fixture:pond" };

/** The pond variant `world`, registered with the pond's species. */
const variant = (world: ReturnType<typeof pondVariant>) => ({
  register: (r: Registries) => registerPond(r, world),
  worldId: world.id,
});

function registries(register: (r: Registries) => unknown = registerPond): Registries {
  const content = loadContent(register);
  if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
  return content.value;
}

function navigationOf(simulation: Simulation, speciesId: string) {
  return simulation.state.pathfinderFor(speciesId)!;
}

/** Long runs take a few seconds locally and several times that on the CI runner. */
const slow = { timeout: 60_000 };

const north: RegionPosition = { regionId: "north-bank", x: -3, z: -3.2 };
const south: RegionPosition = { regionId: "south-bank", x: 3, z: 3.2 };
const middle: RegionPosition = { regionId: "pond", x: 0, z: 0 };

describe("water walkability (ADR 0020 §3)", () => {
  const simulation = createSimulation({ ...pond, seed: 1 });
  const water = (id: string) => navigationOf(simulation, id).navigation.masks.get("pond")!;
  const state = (id: string, regionId: string, x: number, z: number) => {
    const mask = navigationOf(simulation, id).navigation.masks.get(regionId)!;
    return mask.state(mask.cellAt(x, z));
  };

  it("is walkable on its surface for a swimmer, only where the surface is above the ground", () => {
    for (const id of [newt.id, minnow.id]) {
      expect(water(id).isWalkableAt(0.25, 1.25)).toBe(true);
      expect(water(id).height(water(id).cellAt(0.25, 1.25))).toBe(0);
      // The footprint reaches over the bank, where the ground is above the water.
      expect(state(id, "pond", 0.25, 2.25)).toBe(CellState.dry);
      expect(state(id, "pond", 0.25, -2.25)).toBe(CellState.dry);
    }
    expect(state(vole.id, "pond", 0.25, 0.25)).toBe(CellState.noLocomotion);
  });

  it("keeps land under water submerged for every profile", () => {
    expect(state(vole.id, "south-bank", 0.25, 1.75)).toBe(CellState.submerged);
    expect(state(newt.id, "south-bank", 0.25, 1.75)).toBe(CellState.submerged);
    expect(state(minnow.id, "south-bank", 0.25, 1.75)).toBe(CellState.noLocomotion);
  });

  it("counts a cell as under water, or dry, if any part of it is", () => {
    // At y = 0.03 the waterline is at |z| = 2.15, inside the cells centred on ±2.25.
    const wading = createSimulation({
      ...variant(pondVariant({ id: "fixture:wade", water: 0.03 })),
      seed: 1,
    });
    for (const id of [vole.id, newt.id]) {
      const bank = navigationOf(wading, id).navigation.masks.get("south-bank")!;
      expect(bank.state(bank.cellAt(0.25, 2.25))).toBe(CellState.submerged);
    }
    const lake = navigationOf(wading, minnow.id).navigation.masks.get("pond")!;
    expect(lake.state(lake.cellAt(0.25, 1.75))).toBe(CellState.walkable);
    expect(lake.state(lake.cellAt(0.25, 2.25))).toBe(CellState.dry);
  });

  it("keeps a swimmer's body out of the bank, and lets its land reach the waterline", () => {
    const medium = (caps: Record<string, number>) => {
      const checked = simulation.checkLimits("medium", caps);
      if (!checked.ok) throw new Error(checked.diagnostics.map(formatDiagnostic).join("\n"));
      return simulation.state.navigations.find(
        (n) =>
          n.profile.sizeClass === "medium" &&
          n.profile.capabilities.size === Object.keys(caps).length &&
          Object.keys(caps).every((c) => n.profile.capabilities.has(c)),
      )!;
    };
    const both = medium({ "core:land": 1, "core:swim": 1 });
    // Water next to the dry cell at z = 2.25 is within its radius (0.4 m) of the bank.
    expect(both.masks.get("pond")!.isWalkableAt(0.25, 1.75)).toBe(false);
    expect(both.masks.get("pond")!.isWalkableAt(0.25, 1.25)).toBe(true);
    // Its land reaches the waterline; a walker's keeps its radius from the water.
    expect(both.masks.get("south-bank")!.isWalkableAt(0.25, 2.25)).toBe(true);
    expect(medium({ "core:land": 1 }).masks.get("south-bank")!.isWalkableAt(0.25, 2.25)).toBe(
      false,
    );
  });
});

describe("banks between land and water (ADR 0020 §4)", () => {
  const simulation = createSimulation({ ...pond, seed: 1 });

  it("pairs walkable land with the nearest walkable water in reach, low enough to jump", () => {
    const { navigation } = navigationOf(simulation, newt.id);
    expect(navigation.banks.map((b) => [b.landRegionId, b.waterRegionId])).toEqual([
      ["north-bank", "pond"],
      ["south-bank", "pond"],
    ]);
    const reach = bankReach(navigation.profile);
    for (const bank of navigation.banks) {
      const land = navigation.masks.get(bank.landRegionId)!;
      const water = navigation.masks.get(bank.waterRegionId)!;
      for (const pair of bank.pairs) {
        expect(
          Math.hypot(pair.water.x - pair.land.x, pair.water.z - pair.land.z),
        ).toBeLessThanOrEqual(reach + 1e-9);
        expect(
          Math.abs(land.height(pair.landCell) - water.height(pair.waterCell)),
        ).toBeLessThanOrEqual(WORLD_TOLERANCES.maxBankJumpHeight);
      }
    }
  });

  it("exists only for a profile that moves on land and in water", () => {
    expect(navigationOf(simulation, minnow.id).navigation.banks).toEqual([]);
    expect(navigationOf(simulation, vole.id).navigation.banks).toEqual([]);
  });

  it("joins land and water both ways", () => {
    const { navigation } = navigationOf(simulation, newt.id);
    for (const from of ["north-bank", "pond", "south-bank"]) {
      expect([...navigation.reachableRegions(from)].sort()).toEqual([
        "north-bank",
        "pond",
        "south-bank",
      ]);
    }
  });

  it("plans routes in and out of the water anywhere along a bank", () => {
    const pathfinder = navigationOf(simulation, newt.id);
    const across = pathfinder.findRoute(north, south);
    if (!across.ok) throw new Error(across.detail);
    expect(across.route.legs.map((l) => l.regionId)).toEqual(["north-bank", "pond", "south-bank"]);
    expect(across.route.legs[0]!.exit?.connectionId).toBeUndefined();
    const back = pathfinder.findRoute(middle, north);
    if (!back.ok) throw new Error(back.detail);
    expect(back.route.legs.map((l) => [l.regionId, l.exit?.connectionId])).toEqual([
      ["pond", undefined],
      ["north-bank", undefined],
    ]);
    expect([...pathfinder.reachableCells(south).keys()].sort()).toEqual([
      "north-bank",
      "pond",
      "south-bank",
    ]);
  });

  it("still lets an authored shore exit be used, though banks make it optional", () => {
    const pathfinder = navigationOf(simulation, newt.id);
    expect(pathfinder.navigation.portals.get("south-shore")).toEqual({ usable: true });
    const exit = pondWorld.connections[0]!;
    const along = pathfinder.findRoute(
      { regionId: "pond", x: 2.5, z: 1.25 },
      { regionId: "south-bank", x: 2.5, z: 2.75 },
    );
    if (!along.ok) throw new Error(along.detail);
    expect(along.route.legs[0]!.exit?.connectionId).toBe(exit.id);
  });

  it("keeps its crossings at least 2 m apart along a bank, one each way per pair", () => {
    const pathfinder = navigationOf(simulation, newt.id);
    const out = pathfinder.bankCrossings("north-bank");
    expect(out.length).toBeGreaterThan(1);
    for (const [k, a] of out.entries()) {
      expect(a.connectionId).toBeUndefined();
      for (const b of out.slice(k + 1)) {
        expect(Math.hypot(a.from.x - b.from.x, a.from.z - b.from.z)).toBeGreaterThanOrEqual(2);
      }
    }
    const back = pathfinder.bankCrossings("pond").filter((x) => x.toRegionId === "north-bank");
    expect(back.map((x) => x.to).sort((p, q) => p.x - q.x)).toEqual(
      out.map((x) => x.from).sort((p, q) => p.x - q.x),
    );
  });

  it("is not made over a bank too high to jump", () => {
    const cliff = createSimulation({
      ...variant(pondVariant({ id: "fixture:cliff", cliffs: ["north"] })),
      seed: 1,
    });
    const { navigation } = navigationOf(cliff, newt.id);
    expect(navigation.banks.map((b) => b.landRegionId)).toEqual(["south-bank"]);
    expect([...navigation.reachableRegions("north-bank")]).toEqual(["north-bank"]);
  });

  /** Every jump line of the newt's banks in `world`, as points 1/50 of the way apart. */
  const jumpLines = (
    world: { id: string },
    register: (r: Registries) => unknown = variant(world as ReturnType<typeof pondVariant>)
      .register,
  ) => {
    const sim = createSimulation({ register, worldId: world.id, seed: 1 });
    const { navigation } = navigationOf(sim, newt.id);
    return navigation.banks.flatMap((b) =>
      b.pairs.map((p) =>
        Array.from({ length: 51 }, (_, k) => ({
          x: p.land.x + ((p.water.x - p.land.x) * k) / 50,
          z: p.land.z + ((p.water.z - p.land.z) * k) / 50,
        })),
      ),
    );
  };

  it("is not made through a prop in the way", () => {
    // A boulder on the south slope, where the gentle bank meets the water.
    const rock = { x: 0, z: 2.6, blockRadius: 0.3 };
    const near = (p: { x: number; z: number }) =>
      Math.hypot(p.x - rock.x, p.z - rock.z) < rock.blockRadius + 0.2; // the newt's radius
    const plain = pondVariant({ id: "fixture:no-boulder" });
    expect(jumpLines(plain).some((line) => line.some(near))).toBe(true);
    const world = {
      ...pondVariant({ id: "fixture:boulder" }),
      props: [
        {
          id: "boulder",
          prop: "fixture:boulder",
          transform: { position: { x: rock.x, y: 0.1, z: rock.z } },
        },
      ],
    };
    const register = (r: Registries) => {
      r.assets.register({ id: "fixture:boulder.glb", version: "1.0.0", kind: "model", url: "-" });
      r.props.register({
        schemaVersion: 1,
        id: "fixture:boulder",
        version: "1.0.0",
        name: "Boulder",
        model: "fixture:boulder.glb",
        blockRadius: rock.blockRadius,
      });
      registerPond(r, world);
    };
    const lines = jumpLines(world, register);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.some(near))).toBe(false);
  });

  it("is not made under or through a deck in the way", () => {
    // A low jetty along the south waterline, 0.2 m above the water: less than the newt's height.
    const footprint = [
      { x: -1.5, z: 1.6 },
      { x: 1.5, z: 1.6 },
      { x: 1.5, z: 2 },
      { x: -1.5, z: 2 },
    ];
    const inside = (p: { x: number; z: number }) => p.x > -1.5 && p.x < 1.5 && p.z > 1.6 && p.z < 2;
    const plain = pondVariant({ id: "fixture:no-jetty" });
    expect(jumpLines(plain).some((line) => line.some(inside))).toBe(true);
    const world = pondVariant({ id: "fixture:jetty" });
    (world.regions as unknown[]).push({
      id: "jetty",
      kind: "land",
      surface: {
        type: "core:deck",
        params: {
          centerline: [
            { x: -1.5, y: 0.2, z: 1.8 },
            { x: 1.5, y: 0.2, z: 1.8 },
          ],
          width: 0.4,
        },
      },
      footprint,
    });
    const lines = jumpLines(world);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.some(inside))).toBe(false);
  });

  describe("near a raised surface (#132)", () => {
    // A footbridge 0.4 m wide along the pond's south waterline (z = 2), at height `y`.
    const footbridge = (y: number) => {
      const world = pondVariant({ id: `fixture:footbridge-${y}` });
      (world.regions as unknown[]).push({
        id: "footbridge",
        kind: "land",
        surface: {
          type: "core:deck",
          params: {
            centerline: [
              { x: -3, y, z: 2 },
              { x: 3, y, z: 2 },
            ],
            width: 0.4,
          },
        },
        footprint: [
          { x: -3, z: 1.8 },
          { x: 3, z: 1.8 },
          { x: 3, z: 2.2 },
          { x: -3, z: 2.2 },
        ],
      });
      const pathfinder = navigationOf(createSimulation({ ...variant(world), seed: 1 }), newt.id);
      const jump = (land: { x: number; z: number }, water = { x: 0, z: 1.25 }) =>
        isJumpClear(
          pathfinder.world,
          pathfinder.navigation.profile,
          { ...land, y: pathfinder.world.terrain.heightAt(land.x, land.z) },
          { ...water, y: 0 },
        );
      return Object.assign(jump, { navigation: pathfinder.navigation });
    };
    // The newt is small: radius 0.2 m, height 0.4 m. From 0.15 m up the bank its arc tops out
    // at most 0.15 + 0.2 + 0.4 = 0.75 m.
    const keep = 0.2 + JUMP_STRUCTURE_MARGIN;
    const low = footbridge(0.3);
    const high = footbridge(1.5);
    const bank = { x: 0, z: 2.75 };

    it("rejects a jump under a deck lower than the top of its arc, not under one above it", () => {
      expect(2.75 - 2.2).toBeGreaterThan(keep);
      expect(low(bank)).toBe(false);
      expect(high(bank)).toBe(true);
    });

    it("counts the deck's slab: rejects one whose underside, not its surface, is in the way", () => {
      // The arc tops out at 0.75 m; a slab JUMP_DECK_DEPTH (0.15 m) thick hangs below the surface.
      expect(footbridge(0.8)(bank)).toBe(false);
      expect(footbridge(0.75 + JUMP_DECK_DEPTH - 0.01)(bank)).toBe(false);
      expect(footbridge(0.75 + JUMP_DECK_DEPTH + 0.01)(bank)).toBe(true);
    });

    it("rejects a take-off or landing under a deck or beside it, however high it is", () => {
      for (const jump of [high, low]) {
        expect(jump({ x: 0, z: 2.1 })).toBe(false);
        expect(jump({ x: 0, z: 2.2 + keep - 0.05 })).toBe(false);
        // Beside the deck's end, just within and just out of reach.
        expect(jump({ x: 3 + keep - 0.05, z: 2.2 }, { x: 3 + keep - 0.05, z: 1.25 })).toBe(false);
        expect(jump({ x: 3 + keep + 0.05, z: 2.2 }, { x: 3 + keep + 0.05, z: 1.25 })).toBe(true);
      }
    });

    it("still jumps along the rest of the bank, past the deck's ends", () => {
      const south = low.navigation.banks.find((b) => b.landRegionId === "south-bank")!;
      expect(south.pairs.length).toBeGreaterThan(0);
      // Distance from the deck's footprint, which has no curve: 0 inside.
      const away = ({ x, z }: { x: number; z: number }) =>
        Math.hypot(Math.max(0, Math.abs(x) - 3), Math.max(0, Math.abs(z - 2) - 0.2));
      for (const pair of south.pairs) {
        expect(away(pair.land)).toBeGreaterThanOrEqual(keep);
        expect(away(pair.water)).toBeGreaterThanOrEqual(keep);
        for (let k = 0; k <= 50; k++) {
          const x = pair.land.x + ((pair.water.x - pair.land.x) * k) / 50;
          const z = pair.land.z + ((pair.water.z - pair.land.z) * k) / 50;
          expect(away({ x, z })).toBeGreaterThanOrEqual(keep - 1e-9);
        }
      }
    });
  });

  describe("by the Hollow's bridge, at every size (#132)", () => {
    const hollow = createSimulation({
      register: registerBuiltInContent,
      worldId: "hollow:woodland-hollow",
      seed: 1,
    });
    const deck = hollow.state.model.regions.get("bridge-deck")!;
    /** How far a point is from the deck's footprint: 0 inside it. */
    const near = ({ x, z }: { x: number; z: number }) =>
      pointInPolygon(x, z, deck.footprint) ? 0 : distanceToPolygonEdge(x, z, deck.footprint);

    for (const size of ["tiny", "small", "medium", "large"] as const) {
      it(`keeps a ${size} amphibian's jumps off and clear of the deck, with banks either side`, () => {
        expect(hollow.checkLimits(size, { "core:land": 1, "core:swim": 1 }).ok).toBe(true);
        const nav = hollow.state.navigations.find(
          (n) => n.profile.sizeClass === size && n.profile.capabilities.has("core:swim"),
        )!;
        const { radius, height } = nav.profile;
        const keep = radius + JUMP_STRUCTURE_MARGIN;
        let closest = Infinity;
        for (const bank of nav.banks) {
          const land = nav.masks.get(bank.landRegionId)!;
          for (const pair of bank.pairs) {
            // Both ends clear of the deck: never under it, on it or against its side.
            expect(near(pair.land)).toBeGreaterThanOrEqual(keep);
            expect(near(pair.water)).toBeGreaterThanOrEqual(keep);
            closest = Math.min(closest, near(pair.land), near(pair.water));
            // Along the line, the deck is out of reach or above the arc's top (0.5 m water).
            const top = land.height(pair.landCell) + radius + height;
            for (let k = 0; k <= 50; k++) {
              const x = pair.land.x + ((pair.water.x - pair.land.x) * k) / 50;
              const z = pair.land.z + ((pair.water.z - pair.land.z) * k) / 50;
              if (near({ x, z }) >= keep) continue;
              expect(
                (deck.surface.heightAt(x, z) ?? Infinity) - JUMP_DECK_DEPTH,
              ).toBeGreaterThanOrEqual(top);
            }
          }
        }
        // Jumps are still made close by the bridge, just not against it.
        expect(closest).toBeLessThan(keep + 1);
        // Into the river and out of it on either side: both media, and a way across besides the
        // bridge (which a large creature doesn't fit on).
        expect(nav.banks.map((b) => b.landRegionId).sort()).toEqual(["east-meadow", "west-woods"]);
        for (const from of ["west-woods", "river", "east-meadow"]) {
          expect([...nav.reachableRegions(from)]).toEqual(
            expect.arrayContaining(["west-woods", "river", "east-meadow"]),
          );
        }
      });
    }
  });

  it("leaves a walker's navigation in the Hollow as it was at medium and large size", () => {
    const hollow = createSimulation({
      register: registerBuiltInContent,
      worldId: "hollow:woodland-hollow",
      seed: 1,
    });
    const counts = (size: "medium" | "large") => {
      const checked = hollow.checkLimits(size, { "core:land": 1 });
      expect(checked.ok).toBe(true);
      const nav = hollow.state.navigations.find(
        (n) => n.profile.sizeClass === size && !n.profile.capabilities.has("core:swim"),
      )!;
      return Object.fromEntries([...nav.masks].map(([id, m]) => [id, m.walkableCount]));
    };
    // The counts before M16, unchanged by the whole-cell water rules.
    expect(counts("medium")).toEqual({
      "west-woods": 3712,
      "east-meadow": 2742,
      summit: 1024,
      river: 0,
      "bridge-deck": 32,
    });
    expect(counts("large")).toEqual({
      "west-woods": 2878,
      "east-meadow": 2247,
      summit: 736,
      river: 0,
      "bridge-deck": 0,
    });
  });
});

describe("world checks for swimmers (ADR 0020 §4–§5)", () => {
  const diagnostics = (register: (r: Registries) => unknown, worldId = pondWorld.id) => {
    const r = registries(register);
    return checkWorld(r.worlds.get(worldId)!, r).diagnostics.map(formatDiagnostic);
  };

  it("passes the pond with walkers, swimmers and amphibians: banks are no seams", () => {
    expect(diagnostics(registerPond)).toEqual([]);
  });

  it("no longer warns about a connection no registered species can use", () => {
    // Only the vole: nothing can use the shore exit, and nothing swims to the middle spawn point.
    const onlyVole = (r: Registries) => {
      r.assets.register({ id: vole.appearance, version: "1.0.0", kind: "image", url: "-" });
      r.species.register(vole);
      r.worlds.register(pondWorld);
    };
    expect(diagnostics(onlyVole)).toEqual([]);
  });

  it("warns of a spawn point only in a region kind no capability moves in", () => {
    const sky = structuredClone(pondWorld);
    sky.id = "fixture:sky";
    sky.regions.push({
      id: "cloud",
      kind: "air",
      surface: { type: "core:flat", params: { y: 1.5 } },
      footprint: [
        { x: -5, z: -3.5 },
        { x: -4, z: -3.5 },
        { x: -4, z: -3 },
        { x: -5, z: -3 },
      ],
    });
    sky.spawnPoints.push({ id: "aloft", position: { regionId: "cloud", x: -4.5, z: -3.25 } });
    const found = diagnostics((r) => registerPond(r, sky), sky.id);
    expect(found.filter((d) => d.includes("spawn_unusable"))).toEqual([
      expect.stringContaining(`air region of spawn point "aloft"`),
    ]);
  });

  it("skips a shore exit for a profile that can't move on its land side", () => {
    const simulation = createSimulation({ ...pond, seed: 1 });
    const { navigation } = navigationOf(simulation, minnow.id);
    expect(navigation.portals.get("south-shore")).toMatchObject({
      usable: false,
      reason: "not_applicable",
    });
    expect(simulation.checkLimits("small", { "core:swim": 1 })).toEqual({ ok: true, value: [] });
  });

  it("limits a profile that can get into water but not out: every bank too high", () => {
    const closed = pondVariant({ id: "fixture:closed-pond", cliffs: ["north", "south"] });
    const simulation = createSimulation({ ...variant(closed), seed: 1 });
    // An amphibian appearing at the spawn point in the water can never climb out.
    const limits = simulation.checkLimits("small", { "core:land": 1, "core:swim": 1 });
    expect(limits.ok && limits.value.map((d) => [d.severity, d.code, d.path])).toEqual([
      ["warning", "no_water_exit", ["regions", 1]],
    ]);
    // Walkers and water-only swimmers don't move between the two, so it is no limit for them.
    expect(simulation.checkLimits("small", { "core:land": 1 })).toEqual({ ok: true, value: [] });
    expect(simulation.checkLimits("small", { "core:swim": 1 })).toEqual({ ok: true, value: [] });
    // With one bank low enough there is a way out.
    const open = createSimulation({
      ...variant(pondVariant({ id: "fixture:half-pond", cliffs: ["north"] })),
      seed: 1,
    });
    expect(open.checkLimits("small", { "core:land": 1, "core:swim": 1 })).toEqual({
      ok: true,
      value: [],
    });
  });

  it("lets amphibians of every size into and out of the Hollow's river as it is", () => {
    const simulation = createSimulation({
      register: registerBuiltInContent,
      worldId: "hollow:woodland-hollow",
      seed: 1,
    });
    for (const size of ["tiny", "small", "medium", "large"] as const) {
      const checked = simulation.checkLimits(size, { "core:land": 1, "core:swim": 1 });
      expect(checked.ok && checked.value.map((d) => d.code)).not.toContain("no_water_exit");
      const nav = simulation.state.navigations.find(
        (n) => n.profile.sizeClass === size && n.profile.capabilities.has("core:swim"),
      )!;
      expect(nav.banks.map((b) => b.landRegionId).sort()).toEqual(["east-meadow", "west-woods"]);
    }
  });
});

/** A behavior that plays a script of proposals, one per decision. */
const scripted = (script: Proposal[]): BehaviorProvider => ({
  id: "test:scripted",
  version: "1.0.0",
  dependencies: ["core:idle", "core:follow_path"].map((id) => ({
    registry: "actions" as const,
    id,
  })),
  evaluate(_observation, memory) {
    const n = typeof memory.n === "number" ? memory.n : 0;
    memory.n = n + 1;
    return script[n] ?? null;
  },
});

const walkTo = ({ regionId, x, z }: RegionPosition): Proposal => ({
  action: "core:follow_path",
  params: { destination: { regionId, x, z } },
  utility: 1,
});

/** Registers the pond with a puppet species like `base` that plays `script`. */
const puppetContent = (script: Proposal[], base: object) => (r: Registries) => {
  registerPond(r);
  r.behaviors.register(scripted(script));
  r.species.register({ ...base, id: "fixture:puppet", behaviors: ["test:scripted"] });
};

/** A newt (or `base`) that plays `script`, spawned at `spawnPointId`. */
function puppet(script: Proposal[], spawnPointId: string, base: object = newt) {
  const simulation = createSimulation({ ...pond, seed: 1, register: puppetContent(script, base) });
  const spawned = simulation.spawn("fixture:puppet", spawnPointId);
  if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
  const creature = () => simulation.state.creatures.get(spawned.value.id)!;
  const snap = () => simulation.snapshot().creatures[0]!;
  return { simulation, creature, snap };
}

describe("swimming in the simulation", () => {
  it("jumps in from the bank, swims at its water speed, and climbs out on the far bank", () => {
    const { simulation, creature, snap } = puppet([walkTo(south)], "north");
    expect(snap()).toMatchObject({ animation: "hop", submersion: 0 });
    const events: SimulationEvent[] = [];
    const seen = new Set<string>();
    let previous = { ...creature().position };
    for (let t = 0; t < 2_000 && !creature().lastResult; t++) {
      const tick = simulation.step();
      events.push(...tick);
      const here = creature().position;
      const step = Math.hypot(here.x - previous.x, here.z - previous.z);
      const jumped = tick.some((e) => e.type === "entered_region");
      // 0.6 m/s on land, half that in water, at 10 Hz; a jump is made whole in one tick.
      if (jumped) {
        expect(step).toBeLessThanOrEqual(
          bankReach(navigationOf(simulation, "fixture:puppet").navigation.profile) + 1e-9,
        );
      } else if (here.regionId === "pond") {
        expect(step).toBeLessThanOrEqual(0.03 + 1e-9);
        expect(snap()).toMatchObject({ animation: "swim", submersion: SWIM_SUBMERSION });
        expect(snap().world.y).toBe(0);
      } else {
        expect(step).toBeLessThanOrEqual(0.06 + 1e-9);
      }
      // Always on a walkable cell, jumps included.
      const mask = navigationOf(simulation, "fixture:puppet").navigation.masks.get(here.regionId)!;
      expect(mask.isWalkableAt(here.x, here.z)).toBe(true);
      seen.add(`${here.regionId}:${snap().animation}`);
      previous = { ...here };
    }
    expect(creature().position).toEqual(south);
    expect(seen).toEqual(new Set(["north-bank:hop", "pond:swim", "south-bank:hop"]));
    const moves = events.filter((e) => e.type === "entered_region");
    expect(moves.map((e) => [e.fromRegionId, e.toRegionId])).toEqual([
      ["north-bank", "pond"],
      ["pond", "south-bank"],
    ]);
    expect(moves[0]).not.toHaveProperty("connectionId");
    expect(events.filter((e) => e.type === "first_use_of_structure")).toEqual([]);
  });

  it("climbs back out onto the bank it came from", () => {
    const { simulation, creature } = puppet([walkTo(north)], "middle");
    for (let t = 0; t < 1_000 && !creature().lastResult; t++) simulation.step();
    expect(creature().lastResult).toEqual({ action: "core:follow_path", outcome: "done" });
    expect(creature().position).toEqual(north);
  });

  it("makes the same jump from a save taken just before it", () => {
    const first = puppet([walkTo(south)], "north");
    let jumpTick = -1;
    for (let t = 0; t < 2_000 && jumpTick < 0; t++) {
      if (first.simulation.step().some((e) => e.type === "entered_region")) jumpTick = t;
    }
    expect(jumpTick).toBeGreaterThan(0);
    const { simulation } = puppet([walkTo(south)], "north");
    for (let t = 0; t < jumpTick; t++) simulation.step();
    const restored = createSimulation({
      ...pond,
      seed: 99,
      register: puppetContent([walkTo(south)], newt),
    });
    const result = restored.restore(JSON.parse(JSON.stringify(simulation.save(0))), {
      nowMs: 0,
      minutes: simulation.state.minutes,
    });
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    for (let t = 0; t < 40; t++) {
      expect(restored.step()).toEqual(simulation.step());
      expect(restored.state.creatures.get("creature-1")).toEqual(
        simulation.state.creatures.get("creature-1"),
      );
    }
  });

  it("shows a water-only creature swimming and a walker walking", () => {
    const fish = puppet([], "middle", minnow);
    expect(fish.snap()).toMatchObject({ animation: "swim", submersion: SWIM_SUBMERSION });
    const walker = puppet([], "north", vole);
    expect(walker.snap()).toMatchObject({ animation: "walk", submersion: 0 });
  });

  it("picks the capability in use by speed factor, then by ID, whatever the species' order", () => {
    const paddle = {
      id: "test:paddle",
      version: "1.0.0",
      locomotion: { regionKinds: ["water" as const], animation: "paddle", submersion: 0.1 },
    };
    const snapshotWith = (capabilities: Record<string, number>) => {
      const simulation = createSimulation({
        ...pond,
        seed: 1,
        register: (r: Registries) => {
          r.capabilities.register(paddle);
          registerPond(r);
          r.species.register({ ...minnow, id: "fixture:duck", capabilities });
        },
      });
      simulation.spawn("fixture:duck", "middle");
      return simulation.snapshot().creatures[0]!;
    };
    expect(snapshotWith({ "test:paddle": 1, "core:swim": 1 })).toMatchObject({
      animation: "swim",
      submersion: SWIM_SUBMERSION,
    });
    expect(snapshotWith({ "core:swim": 1, "test:paddle": 1 })).toMatchObject({ animation: "swim" });
    expect(snapshotWith({ "core:swim": 1, "test:paddle": 2 })).toMatchObject({
      animation: "paddle",
      submersion: 0.1,
    });
  });

  it("keeps every per-capability invariant over long runs", slow, () => {
    const wade = pondVariant({ id: "fixture:wade", water: 0.03 });
    for (const [world, speciesId, regions] of [
      [pondWorld, newt.id, ["north-bank", "pond", "south-bank"]],
      [pondWorld, minnow.id, ["pond"]],
      [pondWorld, vole.id, ["north-bank", "south-bank"]],
      [wade, newt.id, ["north-bank", "pond", "south-bank"]],
      [wade, vole.id, ["north-bank", "south-bank"]],
    ] as const) {
      for (const seed of [1, 2]) {
        const report = runWithInvariants({
          ...variant(world),
          speciesId,
          seed,
          ticks: 20_000,
          creatures: 3,
          maxDecisionsPer10Seconds: 2,
          saveRestore: { cycles: 2, compareTicks: 600, longGap: false },
        });
        expect(report.violations).toEqual([]);
        expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
        expect(report.eventCounts.path_failed ?? 0).toBe(0);
        for (const regionId of Object.keys(report.regionTicks)) {
          expect(regions).toContain(regionId);
        }
        if (speciesId === newt.id) expect(report.regionTicks.pond).toBeGreaterThan(0);
      }
    }
  });
});

describe("turning when setting off (#121, ADR 0020 §7)", () => {
  // The vole faces +Z (heading 0); the destination lies due west, a quarter turn to its right.
  const west = { regionId: "north-bank", x: -5, z: -3.2 };

  it("turns towards its way at the turn rate before walking off, and never snaps", () => {
    const { simulation, creature } = puppet([walkTo(west)], "north", vole);
    const maxTurn = TURN_RATE * simulation.tickSeconds + 1e-9;
    const angle = (d: number) => Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
    let heading = creature().heading;
    let { x } = creature().position;
    let turningTicks = 0;
    for (let t = 0; t < 400 && !creature().lastResult; t++) {
      simulation.step();
      const now = creature();
      expect(angle(now.heading - heading)).toBeLessThanOrEqual(maxTurn);
      if (angle(-Math.PI / 2 - now.heading) > WALK_TURN_LIMIT + 1e-9) {
        // Still turning in place.
        expect(now.position.x).toBe(x);
        turningTicks++;
      }
      heading = now.heading;
      x = now.position.x;
    }
    expect(creature().position).toMatchObject({ x: -5, z: -3.2 });
    expect(creature().heading).toBeCloseTo(-Math.PI / 2);
    // A quarter turn less the limit at half a turn a second: 0.25 s, the first 3 ticks or so.
    expect(turningTicks).toBeGreaterThan(0);
    expect(turningTicks).toBeLessThanOrEqual(4);
  });

  it("resumes the same turn from a save taken mid-turn", () => {
    const { simulation } = puppet([walkTo(west)], "north", vole);
    simulation.step(); // decides, starts walking and turns a first step
    simulation.step();
    const saved = simulation.save(0);
    const restored = createSimulation({
      ...pond,
      seed: 99,
      register: puppetContent([walkTo(west)], vole),
    });
    const result = restored.restore(JSON.parse(JSON.stringify(saved)), {
      nowMs: 0,
      minutes: simulation.state.minutes,
    });
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    for (let t = 0; t < 60; t++) {
      simulation.step();
      restored.step();
      expect(restored.state.creatures.get("creature-1")).toEqual(
        simulation.state.creatures.get("creature-1"),
      );
    }
  });

  it("never turns faster than the turn rate over a living day in the Hollow", slow, () => {
    let last = new Map<string, number>();
    let worst = 0;
    const report = runWithInvariants({
      register: registerBuiltInContent,
      worldId: "hollow:woodland-hollow",
      speciesId: "hollow:mossling",
      seed: 3,
      ticks: 24 * 3600 * 2,
      tickRateHz: 2,
      creatures: 3,
      onTick: (simulation) => {
        const now = new Map<string, number>();
        for (const c of simulation.state.creatures.values()) {
          const before = last.get(c.id);
          if (before !== undefined) {
            const d = c.heading - before;
            worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(d), Math.cos(d))));
          }
          now.set(c.id, c.heading);
        }
        last = now;
      },
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(worst).toBeLessThanOrEqual(TURN_RATE / 2 + 1e-9);
  });
});

describe("keeping to one medium (#140)", () => {
  const simulation = createSimulation({
    register: registerHollowCreatures,
    worldId: "hollow:woodland-hollow",
    seed: 1,
  });
  const amphibian = navigationOf(simulation, otter.id);
  const walker = navigationOf(simulation, "hollow:mossling");

  it("costs a bank jump its length plus BANK_CROSSING_COST", () => {
    const out = amphibian.bankCrossings("west-woods");
    expect(out.length).toBeGreaterThan(0);
    for (const c of [...out, ...amphibian.bankCrossings("river")]) {
      const length = Math.hypot(c.to.x - c.from.x, c.to.z - c.from.z);
      expect(c.cost).toBeCloseTo(length + BANK_CROSSING_COST, 9);
    }
  });

  it("takes the bridge between the banks unless the river is clearly shorter", () => {
    const cells = (regionId: string) => {
      const mask = walker.navigation.masks.get(regionId)!;
      const walkable: RegionPosition[] = [];
      for (let cell = 0; cell < mask.states.length; cell++) {
        const { x, z } = mask.center(cell);
        if (mask.isWalkableAt(x, z)) walkable.push({ regionId, x, z });
      }
      return walkable;
    };
    const west = cells("west-woods");
    const east = cells("east-meadow");
    let bridged = 0;
    for (let k = 0; k < 60; k++) {
      // Spread over both banks, the same pairs on every run.
      const from = west[(k * 7919) % west.length]!;
      const to = east[(k * 104_729) % east.length]!;
      const swum = amphibian.findRoute(from, to);
      const walked = walker.findRoute(from, to);
      if (!swum.ok || !walked.ok) throw new Error("no route between the banks");
      const jumps = swum.route.legs.filter((l) => l.exit && !l.exit.connectionId).length;
      if (jumps === 0) {
        bridged++;
        // The cost only steers the search: a route's length is still the distance walked.
        expect(swum.route.length).toBeCloseTo(walked.route.length, 6);
      } else {
        // Crossing doors are spaced, so the search is within a metre or two of the best.
        expect(walked.route.length - swum.route.length).toBeGreaterThan(
          jumps * BANK_CROSSING_COST - 2,
        );
      }
    }
    expect(bridged).toBeGreaterThan(30);
  });

  it("reaches in one medium what a walker or a swimmer reaches at all", () => {
    for (const [speciesId, from] of [
      ["hollow:mossling", { regionId: "west-woods", x: -15, z: 7 }],
      [carp.id, { regionId: "river", x: 4.25, z: 14.25 }],
    ] as const) {
      const pathfinder = navigationOf(simulation, speciesId);
      expect(pathfinder.reachableCells(from, { sameMedium: true })).toEqual(
        pathfinder.reachableCells(from),
      );
    }
    // An amphibian reaches the river and the far bank only by changing medium.
    const fromWoods = amphibian.reachableCells({ regionId: "west-woods", x: -15, z: 7 });
    const inMedium = amphibian.reachableCells(
      { regionId: "west-woods", x: -15, z: 7 },
      { sameMedium: true },
    );
    expect([...fromWoods.keys()]).toContain("river");
    expect(inMedium.has("river")).toBe(false);
    expect(inMedium.get("west-woods")).toEqual(fromWoods.get("west-woods"));
    // A large one doesn't fit the bridge, so the far bank is across the water only.
    const large = createSimulation({
      register: (r: Registries) => {
        registerHollowCreatures(r);
        r.species.register({ ...otter, id: "test:large-otter", sizeClass: "large" });
      },
      worldId: "hollow:woodland-hollow",
      seed: 1,
    });
    const big = navigationOf(large, "test:large-otter");
    const west = { regionId: "west-woods", x: -15, z: 7 };
    expect(big.reachableCells(west).has("east-meadow")).toBe(true);
    expect(big.reachableCells(west, { sameMedium: true }).has("east-meadow")).toBe(false);
  });

  // Per amphibian and day: a few dozen jumps, not hundreds (#140 measured 509–717 for medium and
  // 365–778 for large before), and time in the water too.
  it.each([
    ["medium", 50, 0.02],
    ["large", 75, 0],
  ] as const)(
    "keeps a %s amphibian mostly to one medium over a living day, still in both",
    slow,
    (sizeClass, maxJumps, minWaterShare) => {
      const ticks = { water: 0, land: 0 };
      let jumps = 0;
      const speciesId = `test:otter-${sizeClass}`;
      const report = runWithInvariants({
        register: (r: Registries) => {
          registerHollowCreatures(r);
          r.species.register({ ...otter, id: speciesId, sizeClass });
        },
        worldId: "hollow:woodland-hollow",
        speciesId,
        seed: 1,
        ticks: 24 * 3600 * 2,
        tickRateHz: 2,
        creatures: 2,
        onTick: (sim, events) => {
          jumps += events.filter((e) => e.type === "entered_region" && !e.connectionId).length;
          for (const c of sim.state.creatures.values()) {
            const kind = sim.state.model.regions.get(c.position.regionId)?.kind;
            ticks[kind === "water" ? "water" : "land"]++;
          }
        },
      });
      expect(report.violations).toEqual([]);
      expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
      expect(jumps / 2).toBeLessThan(maxJumps);
      expect(ticks.water).toBeGreaterThan(0);
      expect(ticks.water / (ticks.water + ticks.land)).toBeGreaterThanOrEqual(minWaterShare);
      expect(ticks.land / (ticks.water + ticks.land)).toBeGreaterThan(0.5);
    },
  );
});
