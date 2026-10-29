import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { formatDiagnostic, type RegionPosition } from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import {
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
import { minnow, newt, pondWorld, registerPond, vole } from "./index";
import { createSimulation, loadContent, runWithInvariants } from "./simulation-run";

// Swimming and locomotion styles (ADR 0020, M16 PR 2), on the pond fixture: water walkability,
// the derived way into water, directed routes, the snapshot's profile and submersion, the
// integrity checks, and the smooth turn when setting off (#121).

const pond = { register: registerPond, worldId: "fixture:pond" };

function registries(register: (r: Registries) => unknown = registerPond): Registries {
  const content = loadContent(register);
  if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
  return content.value;
}

function navigationOf(simulation: Simulation, speciesId: string) {
  return simulation.state.pathfinderFor(speciesId)!;
}

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
      expect(water(id).isWalkableAt(0.25, 1.75)).toBe(true);
      expect(water(id).height(water(id).cellAt(0.25, 1.75))).toBe(0);
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

  it("lets a swimmer's land reach the waterline, but keeps a walker its radius away", () => {
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
    const bank = (caps: Record<string, number>) =>
      medium(caps).masks.get("south-bank")!.isWalkableAt(0.25, 2.25);
    expect(bank({ "core:land": 1, "core:swim": 1 })).toBe(true);
    expect(bank({ "core:land": 1 })).toBe(false);
  });
});

describe("the derived way into water (ADR 0020 §4)", () => {
  const simulation = createSimulation({ ...pond, seed: 1 });

  it("joins every walkable bank cell next to walkable water, land into water only", () => {
    const { navigation } = navigationOf(simulation, newt.id);
    expect(navigation.entries.map((e) => [e.fromRegionId, e.toRegionId])).toEqual([
      ["north-bank", "pond"],
      ["south-bank", "pond"],
    ]);
    for (const entry of navigation.entries) {
      for (const pair of entry.pairs) {
        expect(Math.hypot(pair.to.x - pair.from.x, pair.to.z - pair.from.z)).toBeCloseTo(0.5);
        expect(Math.abs(pair.to.z)).toBeLessThan(Math.abs(pair.from.z));
      }
    }
  });

  it("exists only for a profile that moves on land and in water", () => {
    expect(navigationOf(simulation, minnow.id).navigation.entries).toEqual([]);
    expect(navigationOf(simulation, vole.id).navigation.entries).toEqual([]);
  });

  it("makes the region graph directed: out of the water only by the shore exit", () => {
    const { navigation } = navigationOf(simulation, newt.id);
    expect([...navigation.reachableRegions("north-bank")].sort()).toEqual([
      "north-bank",
      "pond",
      "south-bank",
    ]);
    expect([...navigation.reachableRegions("pond")].sort()).toEqual(["pond", "south-bank"]);
    expect([...navigation.reachableRegions("south-bank")].sort()).toEqual(["pond", "south-bank"]);
  });

  it("plans routes into the water from the bank and out only through the exit", () => {
    const pathfinder = navigationOf(simulation, newt.id);
    const across = pathfinder.findRoute(north, south);
    if (!across.ok) throw new Error(across.detail);
    expect(across.route.legs.map((l) => [l.regionId, l.exit?.connectionId])).toEqual([
      ["north-bank", undefined],
      ["pond", "south-shore"],
      ["south-bank", undefined],
    ]);
    expect(across.route.legs[0]!.exit).toMatchObject({ fromRegionId: "north-bank" });
    expect(pathfinder.findRoute(south, north)).toMatchObject({ ok: false, reason: "unreachable" });
    expect(pathfinder.findRoute(middle, north)).toMatchObject({ ok: false, reason: "unreachable" });
    // What a creature can reach is exactly what it can route to.
    expect([...pathfinder.reachableCells(south).keys()].sort()).toEqual(["pond", "south-bank"]);
    expect([...pathfinder.reachableCells(north).keys()].sort()).toEqual([
      "north-bank",
      "pond",
      "south-bank",
    ]);
  });

  it("keeps its crossings at least 2 m apart along a bank", () => {
    const crossings = navigationOf(simulation, newt.id).entryCrossings("north-bank");
    expect(crossings.length).toBeGreaterThan(1);
    for (const [k, a] of crossings.entries()) {
      expect(a.connectionId).toBeUndefined();
      for (const b of crossings.slice(k + 1)) {
        expect(Math.hypot(a.from.x - b.from.x, a.from.z - b.from.z)).toBeGreaterThanOrEqual(2);
      }
    }
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
    const found = diagnostics((r) => {
      registerPond(r);
      r.worlds.register(sky);
    }, sky.id);
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

  it("limits a profile that can get into water but not out", () => {
    const closed = { ...structuredClone(pondWorld), id: "fixture:closed-pond", connections: [] };
    const simulation = createSimulation({
      register: (r) => {
        registerPond(r);
        r.worlds.register(closed);
      },
      worldId: closed.id,
      seed: 1,
    });
    const limits = simulation.checkLimits("small", { "core:land": 1, "core:swim": 1 });
    expect(limits.ok && limits.value.map((d) => [d.severity, d.code, d.path])).toEqual([
      ["warning", "no_water_exit", ["regions", 1]],
    ]);
    // Walkers and water-only swimmers can't get in from the bank, so it is no limit for them.
    expect(simulation.checkLimits("small", { "core:land": 1 })).toEqual({ ok: true, value: [] });
    expect(simulation.checkLimits("small", { "core:swim": 1 })).toEqual({ ok: true, value: [] });
  });

  it("starts the Hollow cleanly; a water-only species has nowhere to appear there yet", () => {
    const simulation = createSimulation({
      register: registerBuiltInContent,
      worldId: "hollow:woodland-hollow",
      seed: 1,
    });
    const swimOnly = simulation.checkLimits("medium", { "core:swim": 1 });
    expect(swimOnly.ok && swimOnly.value.map((d) => d.code)).toEqual(["no_spawn_point"]);
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

/** A newt (or `base`) that plays `script`, spawned at `spawnPointId`. */
function puppet(script: Proposal[], spawnPointId: string, base: object = newt) {
  const simulation = createSimulation({
    ...pond,
    seed: 1,
    register: (r: Registries) => {
      registerPond(r);
      r.behaviors.register(scripted(script));
      r.species.register({ ...base, id: "fixture:puppet", behaviors: ["test:scripted"] });
    },
  });
  const spawned = simulation.spawn("fixture:puppet", spawnPointId);
  if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
  const creature = () => simulation.state.creatures.get(spawned.value.id)!;
  const snap = () => simulation.snapshot().creatures[0]!;
  return { simulation, creature, snap };
}

describe("swimming in the simulation", () => {
  it("jumps in from the bank, swims at its water speed, and leaves by the exit", () => {
    const { simulation, creature, snap } = puppet([walkTo(south)], "north");
    expect(snap()).toMatchObject({ animation: "hop", submersion: 0 });
    const events: SimulationEvent[] = [];
    const seen = new Set<string>();
    let previous = { ...creature().position };
    for (let t = 0; t < 2_000 && !creature().lastResult; t++) {
      events.push(...simulation.step());
      const here = creature().position;
      const step = Math.hypot(here.x - previous.x, here.z - previous.z);
      // 0.6 m/s on land, half that in water, at 10 Hz.
      if (here.regionId === "pond" && previous.regionId === "pond") {
        expect(step).toBeLessThanOrEqual(0.03 + 1e-9);
        expect(snap()).toMatchObject({ animation: "swim", submersion: SWIM_SUBMERSION });
        expect(snap().world.y).toBe(0);
      } else {
        expect(step).toBeLessThanOrEqual(0.06 + 1e-9);
      }
      seen.add(`${here.regionId}:${snap().animation}`);
      previous = { ...here };
    }
    expect(creature().position).toEqual(south);
    expect(seen).toEqual(new Set(["north-bank:hop", "pond:swim", "south-bank:hop"]));
    const moves = events.filter((e) => e.type === "entered_region");
    expect(moves.map((e) => [e.fromRegionId, e.toRegionId, e.connectionId])).toEqual([
      ["north-bank", "pond", undefined],
      ["pond", "south-bank", "south-shore"],
    ]);
    expect(moves[0]).not.toHaveProperty("connectionId");
    expect(events.filter((e) => e.type === "first_use_of_structure")).toEqual([]);
  });

  it("can't plan a way back out of the water to the bank it came from", () => {
    const { simulation, creature } = puppet([walkTo(north)], "middle");
    simulation.step();
    expect(creature().lastResult).toMatchObject({ outcome: "failed", reason: "unreachable" });
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

  it("keeps every per-capability invariant over long runs", () => {
    for (const [speciesId, regions] of [
      [newt.id, ["north-bank", "pond", "south-bank"]],
      [minnow.id, ["pond"]],
      [vole.id, ["north-bank", "south-bank"]],
    ] as const) {
      for (const seed of [1, 2]) {
        const report = runWithInvariants({
          ...pond,
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
  it("turns towards its way at the turn rate before walking off, and never snaps", () => {
    // The vole faces +Z (heading 0); the destination lies due west, a quarter turn to its right.
    const west = { regionId: "north-bank", x: -5, z: -3.2 };
    const { simulation, creature } = puppet([walkTo(west)], "north", vole);
    const maxTurn = TURN_RATE * simulation.tickSeconds + 1e-9;
    let heading = creature().heading;
    let { x } = creature().position;
    let turningTicks = 0;
    for (let t = 0; t < 400 && !creature().lastResult; t++) {
      simulation.step();
      const now = creature();
      const turn = Math.abs(
        Math.atan2(Math.sin(now.heading - heading), Math.cos(now.heading - heading)),
      );
      expect(turn).toBeLessThanOrEqual(maxTurn);
      const wanted = -Math.PI / 2;
      const off = Math.abs(
        Math.atan2(Math.sin(wanted - now.heading), Math.cos(wanted - now.heading)),
      );
      if (off > WALK_TURN_LIMIT + 1e-9) {
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

  it("never turns faster than the turn rate over a living day in the Hollow", () => {
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
