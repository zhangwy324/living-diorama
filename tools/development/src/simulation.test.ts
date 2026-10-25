import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { createRegistries, type Registries } from "@living-diorama/extension-api";
import {
  registerCoreEngine,
  Simulation,
  type ActionProvider,
  type BehaviorProvider,
  type DecisionTrace,
  type Proposal,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { pebble, registerRiverCrossing } from "./index";
import { createSimulation, runWithInvariants } from "./simulation-run";

const hollow = {
  register: registerBuiltInContent,
  worldId: "hollow:woodland-hollow",
  speciesId: "hollow:mossling",
};
const river = {
  register: registerRiverCrossing,
  worldId: "fixture:river-crossing",
  speciesId: "fixture:pebble",
};

/** Wander alternates rests of 3–12 s with walks to points at least 2 m away. */
function expectWanderShape(traces: DecisionTrace[]) {
  const lastStarted = new Map<string, string>();
  for (const trace of traces) {
    expect(trace.result).toBe("started");
    const { action, params } = trace.chosen!;
    expect(lastStarted.get(trace.creatureId) ?? "core:follow_path").not.toBe(action);
    lastStarted.set(trace.creatureId, action);
    if (action === "core:idle") {
      const { seconds } = params as { seconds: number };
      expect(seconds).toBeGreaterThanOrEqual(3);
      expect(seconds).toBeLessThan(12);
    } else {
      const { destination } = params as { destination: { x: number; z: number } };
      const { x, z } = trace.position;
      expect(Math.hypot(destination.x - x, destination.z - z)).toBeGreaterThanOrEqual(2);
      expect(trace.detail).toMatchObject({
        length: expect.any(Number),
        regions: expect.any(Array),
      });
    }
  }
}

describe("long randomized runs keep every invariant", () => {
  it.each([1, 2, 3, 4])("Woodland Hollow, seed %i, 100k ticks", (seed) => {
    const traces: DecisionTrace[] = [];
    const report = runWithInvariants({
      ...hollow,
      seed,
      ticks: 100_000,
      creatures: 3,
      onTrace: (t) => traces.push(t),
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    // Wander really explores: every creature crosses the bridge, the first within minutes.
    expect(report.eventCounts.first_use_of_structure).toBe(3);
    expect(report.firstStructureUse).toBeLessThan(5_000);
    expect(report.regionTicks["bridge-deck"]).toBeGreaterThan(0);
    expectWanderShape(traces);
  });

  it.each([1, 2])("river-crossing fixture, seed %i, 50k ticks", (seed) => {
    const report = runWithInvariants({ ...river, seed, ticks: 50_000, creatures: 2 });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.first_use_of_structure).toBe(2);
    expect(report.regionTicks.river).toBeUndefined();
  });
});

describe("determinism", () => {
  /** Creature 1's trajectory and events, one line per tick. */
  function trajectory(seed: number, ticks: number, withNeighbour = false): string[] {
    const simulation = createSimulation({ ...hollow, seed });
    simulation.spawn(hollow.speciesId, "meadow");
    if (withNeighbour) simulation.spawn(hollow.speciesId, "meadow");
    const lines: string[] = [];
    for (let t = 0; t < ticks; t++) {
      const events = simulation.step().filter((e) => e.creatureId === "creature-1");
      const { position, heading } = simulation.state.creatures.get("creature-1")!;
      lines.push(`${position.regionId} ${position.x} ${position.z} ${heading}`);
      lines.push(...events.map((e) => JSON.stringify(e)));
    }
    return lines;
  }

  it("repeats the same trajectory for the same seed, and not for another", () => {
    const first = trajectory(7, 20_000);
    expect(trajectory(7, 20_000)).toEqual(first);
    expect(trajectory(8, 20_000)).not.toEqual(first);
  });

  it("keeps a creature's trajectory when another creature is spawned", () => {
    expect(trajectory(7, 20_000, true)).toEqual(trajectory(7, 20_000));
  });

  it("keeps creature state plain data", () => {
    const simulation = createSimulation({ ...hollow, seed: 3 });
    simulation.spawn(hollow.speciesId);
    for (let t = 0; t < 2_000; t++) simulation.step();
    const creature = simulation.state.creatures.get("creature-1")!;
    expect(JSON.parse(JSON.stringify(creature))).toEqual(creature);
  });
});

// A test pack: an action that claims to move but never does, and a behavior that plays a script.

const frozen: ActionProvider = {
  id: "test:frozen",
  version: "1.0.0",
  moves: true,
  start: () => ({ ok: true, state: {} }),
  step: () => ({ status: "running" }),
};
const undeclared: ActionProvider = { ...frozen, id: "test:undeclared" };

const scripted = (script: Proposal[]): BehaviorProvider => ({
  id: "test:scripted",
  version: "1.0.0",
  dependencies: ["core:idle", "core:follow_path", "test:frozen"].map((id) => ({
    registry: "actions" as const,
    id,
  })),
  evaluate(_observation, memory) {
    const n = typeof memory.n === "number" ? memory.n : 0;
    memory.n = n + 1;
    return script[n] ?? null;
  },
});

function puppet(script: Proposal[], spawnPointId = "north-meadow") {
  const traces: DecisionTrace[] = [];
  const simulation = createSimulation({
    ...river,
    seed: 1,
    register: (r: Registries) => {
      registerRiverCrossing(r);
      r.actions.register(frozen);
      r.actions.register(undeclared);
      r.behaviors.register(scripted(script));
      r.species.register({ ...pebble, id: "fixture:puppet", behaviors: ["test:scripted"] });
    },
    onTrace: (t) => traces.push(t),
  });
  simulation.spawn("fixture:puppet", spawnPointId);
  const events: SimulationEvent[] = [];
  const run = (ticks: number) => {
    for (let t = 0; t < ticks; t++) events.push(...simulation.step());
  };
  return {
    simulation,
    traces,
    events,
    run,
    creature: () => simulation.state.creatures.get("creature-1")!,
  };
}

const walkTo = (regionId: string, x: number, z: number): Proposal => ({
  action: "core:follow_path",
  params: { destination: { regionId, x, z } },
  utility: 1,
});

describe("actions, locomotion and events", () => {
  it("walks over the bridge at species speed, facing where it goes", () => {
    const { simulation, creature, traces } = puppet([
      walkTo("south-bank", 1.5, 2.2),
      walkTo("north-bank", -2, -1.8),
    ]);
    const all = simulation.step(); // decides and starts walking
    let previous = { ...creature().position };
    for (let t = 0; !creature().lastResult && t < 1_000; t++) {
      all.push(...simulation.step());
      const { x, z } = creature().position;
      // 0.6 m/s at 10 Hz.
      expect(Math.hypot(x - previous.x, z - previous.z)).toBeLessThanOrEqual(0.06 + 1e-9);
      if (creature().position.regionId === "bridge-deck" && z > -0.5 && z < 0.5) {
        expect(Math.abs(creature().heading)).toBeLessThan(0.3); // heading 0 faces +Z (south)
      }
      previous = { ...creature().position };
    }
    expect(traces[0]!.detail).toMatchObject({
      regions: ["north-bank", "bridge-deck", "south-bank"],
    });
    expect(creature().position).toEqual({ regionId: "south-bank", x: 1.5, z: 2.2 });
    expect(creature().lastResult).toEqual({ action: "core:follow_path", outcome: "done" });

    // The second walk goes back; the structure counts as used once only.
    for (let t = 0; t < 1_000; t++) all.push(...simulation.step());
    expect(creature().position).toEqual({ regionId: "north-bank", x: -2, z: -1.8 });
    const moves = all.filter((e) => e.type === "entered_region");
    expect(moves.map((e) => [e.fromRegionId, e.toRegionId, e.connectionId])).toEqual([
      ["north-bank", "bridge-deck", "bridge-north-end"],
      ["bridge-deck", "south-bank", "bridge-south-end"],
      ["south-bank", "bridge-deck", "bridge-south-end"],
      ["bridge-deck", "north-bank", "bridge-north-end"],
    ]);
    expect(all.filter((e) => e.type === "first_use_of_structure")).toEqual([
      expect.objectContaining({ structureId: "bridge", connectionId: "bridge-north-end" }),
    ]);
  });

  it("interrupts a moving action that makes no progress and decides again", () => {
    const { events, traces, run } = puppet([
      { action: "test:frozen", utility: 1 },
      { action: "core:idle", params: { seconds: 1 }, utility: 1 },
    ]);
    run(60);
    expect(events.filter((e) => e.type === "creature_stuck")).toEqual([
      expect.objectContaining({ tick: 50, ticksStuck: 50 }),
    ]);
    expect(traces[1]).toMatchObject({
      tick: 50,
      lastResult: { action: "test:frozen", outcome: "interrupted", reason: "stuck" },
      chosen: { action: "core:idle" },
      result: "started",
    });
  });

  it("rejects proposals it cannot start and retries a second later", () => {
    const { events, traces, run, creature } = puppet([
      walkTo("river", 0, 0),
      { action: "test:undeclared", utility: 1 },
      { action: "test:nothing", utility: 1 },
      { action: "core:idle", params: { seconds: -1 }, utility: 1 },
    ]);
    run(35);
    expect(traces.map((t) => [t.tick, t.result, t.reason])).toEqual([
      [0, "rejected", "goal_not_walkable"],
      [10, "rejected", "undeclared_action"],
      [20, "rejected", "unknown_action"],
      [30, "rejected", "invalid_params"],
    ]);
    expect(events.filter((e) => e.type === "path_failed")).toEqual([
      expect.objectContaining({
        reason: "goal_not_walkable",
        to: { regionId: "river", x: 0, z: 0 },
      }),
    ]);
    expect(creature().lastResult).toEqual({
      action: "core:idle",
      outcome: "failed",
      reason: "invalid_params",
    });
  });

  it("snapshots world positions on the region's surface", () => {
    const { simulation, run } = puppet([walkTo("south-bank", 1.5, 2.2)]);
    run(25);
    const snapshot = simulation.snapshot();
    expect(snapshot).toMatchObject({ tick: 25, timeMs: 2_500, paused: false });
    const [c] = snapshot.creatures;
    const surface = simulation.state.model.regions.get(c!.position.regionId)!.surface;
    expect(c!.world.y).toBe(surface.heightAt(c!.position.x, c!.position.z));
    expect(c!.currentAction).toBe("core:follow_path");
  });
});

it("refuses actions and behaviors registered without an implementation", () => {
  const registries = createRegistries();
  registerCoreEngine(registries);
  registerRiverCrossing(registries);
  registries.actions.register({ id: "test:empty", version: "1.0.0" });
  registries.behaviors.register({ id: "test:empty", version: "1.0.0" });
  const created = Simulation.create(registries, { worldId: "fixture:river-crossing", seed: 1 });
  expect(created.ok ? [] : created.diagnostics.map((d) => d.code)).toEqual([
    "no_action_implementation",
    "no_behavior_implementation",
  ]);
});
