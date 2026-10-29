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
import { createSimulation, LIVING_BEHAVIOR_CHECKS, runWithInvariants } from "./simulation-run";

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

/**
 * Wander alternates rests of 3–12 s with walks to points at least 2 m away. Only wander's own
 * decisions count: meals (PR 4a) come in between.
 */
function expectWanderShape(traces: DecisionTrace[]) {
  const lastStarted = new Map<string, string>();
  for (const trace of traces) {
    if (trace.chosen?.behavior !== "core:wander") continue;
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

/** `pnpm check`'s short set runs a simulated day at 2 Hz; `pnpm soak` runs more at 10 Hz. */
const CHECK_HZ = 2;
const DAY_TICKS = 24 * 3600 * CHECK_HZ;

describe("long randomized runs keep every invariant", () => {
  // A day takes about 2 s locally and 7 s on the CI runner.
  const slow = { timeout: 30_000 };
  it.each([1, 2, 3])("Woodland Hollow, seed %i, a day at 2 Hz", slow, (seed) => {
    const traces: DecisionTrace[] = [];
    const report = runWithInvariants({
      ...hollow,
      seed,
      ticks: DAY_TICKS,
      tickRateHz: CHECK_HZ,
      creatures: 3,
      ...LIVING_BEHAVIOR_CHECKS,
      onTrace: (t) => traces.push(t),
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    // Wander really explores: every creature crosses the bridge, the first within minutes.
    expect(report.eventCounts.first_use_of_structure).toBe(3);
    expect((report.firstStructureUse ?? Infinity) / CHECK_HZ).toBeLessThan(500);
    expect(report.regionTicks["bridge-deck"]).toBeGreaterThan(0);
    expectWanderShape(traces);
  });

  // Nothing may assume a single creature (roadmap M6 task 4, ADR 0009 §4).
  it("Woodland Hollow with 20 creatures, 20k ticks", slow, () => {
    const report = runWithInvariants({
      ...hollow,
      seed: 5,
      ticks: 20_000,
      creatures: 20,
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    expect(report.eventCounts.first_use_of_structure).toBe(20);
  });

  it.each([1, 2])("river-crossing fixture, seed %i, 50k ticks", (seed) => {
    // Short walks in a small world: wander decides about 1.3 times per 10 s here.
    const report = runWithInvariants({
      ...river,
      seed,
      ticks: 50_000,
      creatures: 2,
      maxDecisionsPer10Seconds: 2,
    });
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
      const events = simulation
        .step()
        .filter((e) => "creatureId" in e && e.creatureId === "creature-1");
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

// A test pack: an action that walks but never gets anywhere, and a behavior that plays a script.

const frozen: ActionProvider = {
  id: "test:frozen",
  version: "1.0.0",
  start: () => ({ ok: true, state: {} }),
  step: (_state, context) => {
    context.walk({ points: [], next: 0 });
    return { status: "running" };
  },
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
    expect(c!.route).toBeUndefined();
  });

  it("adds the remaining route per region to snapshots on request", () => {
    const { simulation, run, creature } = puppet([
      walkTo("south-bank", 1.5, 2.2),
      { action: "core:idle", params: { seconds: 60 }, utility: 1 },
    ]);
    run(2);
    const route = simulation.snapshot({ debug: true }).creatures[0]!.route!;
    expect(route.map((leg) => leg.regionId)).toEqual(["north-bank", "bridge-deck", "south-bank"]);
    const { model } = simulation.state;
    for (const leg of route) {
      const surface = model.regions.get(leg.regionId)!.surface;
      for (const p of leg.points) expect(p.y).toBe(surface.heightAt(p.x, p.z));
    }
    expect(route.at(-1)!.points.at(-1)).toMatchObject({ x: 1.5, z: 2.2 });

    // Reached waypoints drop off; the route goes once the walk ends.
    const count = (r: typeof route) => r.flatMap((leg) => leg.points).length;
    run(40);
    expect(count(simulation.snapshot({ debug: true }).creatures[0]!.route!)).toBeLessThan(
      count(route),
    );
    for (let t = 0; t < 1_000 && !creature().lastResult; t++) run(1);
    run(1);
    expect(simulation.snapshot({ debug: true }).creatures[0]!.route).toBeUndefined();
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

describe("time of day", () => {
  it("derives the time of day in headless runs from simulation time and a start", () => {
    const changes: SimulationEvent[] = [];
    const times: number[] = [];
    const report = runWithInvariants({
      ...hollow,
      seed: 1,
      // 19:59 plus 90 s at 10 Hz.
      startMinutes: 19 * 60 + 59,
      ticks: 900,
      creatures: 1,
      onTick: (simulation, events) => {
        changes.push(...events.filter((e) => e.type === "day_phase_changed"));
        times.push(simulation.snapshot().timeOfDay);
      },
    });
    expect(report.violations).toEqual([]);
    expect(times[0]).toBe(19 * 60 + 59);
    expect(times.at(-1)).toBeCloseTo(19 * 60 + 59 + 899 / 600);
    // Not at the start; once, on the tick that reaches 20:00.
    expect(changes).toEqual([{ type: "day_phase_changed", tick: 600, from: "dusk", to: "night" }]);
  });

  it("announces a jump across several phases once, from the old phase to the new", () => {
    const simulation = createSimulation({ ...hollow, seed: 1, startMinutes: 12 * 60 });
    simulation.step();
    // Forward from noon past dusk and night into dawn.
    simulation.setTimeOfDay(24 * 60 + 7 * 60);
    expect(simulation.step()).toEqual([
      { type: "day_phase_changed", tick: 1, from: "day", to: "dawn" },
    ]);
    expect(simulation.state.dayPhase).toBe("dawn");
    // Two changes before one tick count as one jump, and a round trip as none.
    simulation.setTimeOfDay(21 * 60);
    simulation.setTimeOfDay(7 * 60 + 30);
    expect(simulation.step()).toEqual([]);
    expect(() => simulation.setTimeOfDay(Number.NaN)).toThrow(RangeError);
  });
});
