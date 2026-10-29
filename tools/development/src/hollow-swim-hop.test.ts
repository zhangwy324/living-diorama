import { builtInDefinitions } from "@living-diorama/built-in-content";
import { formatDiagnostic, type RegionPosition } from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import {
  SWIM_SUBMERSION,
  type BehaviorProvider,
  type Proposal,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { carp, otter, registerHollowCreatures, toad } from "./index";
import { createSimulation, LIVING_BEHAVIOR_CHECKS, runWithInvariants } from "./simulation-run";

// Headless swim and hop scenarios in Woodland Hollow (ADR 0020, M16 PR 7), with the test species
// of `fixtures/hollow-creatures.ts`: a water-only swimmer appears at the river's spawn point and
// stays in the water; an amphibian crosses the river by its banks while a walker takes the
// bridge; a hopper's gait gives the `hop` profile. The pond fixture's tests (swimming.test.ts)
// cover the mechanics; these check them in the built-in world.

const hollow = { register: registerHollowCreatures, worldId: "hollow:woodland-hollow" };
const [mossling] = builtInDefinitions.species;

/** Long runs take a few seconds locally and several times that on the CI runner. */
const slow = { timeout: 60_000 };

describe("a water-only swimmer in Woodland Hollow", () => {
  it("appears at the river's spawn point, swimming half submerged", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const spawned = simulation.spawn(carp.id);
    if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
    expect(simulation.state.creatures.get(spawned.value.id)!.position).toEqual({
      regionId: "river",
      x: 4.25,
      z: 14.25,
    });
    expect(simulation.snapshot().creatures[0]).toMatchObject({
      animation: "swim",
      submersion: SWIM_SUBMERSION,
    });
  });

  it("stays in the water through a living day, swimming all the while", slow, () => {
    const seen = new Set<string>();
    const report = runWithInvariants({
      ...hollow,
      speciesId: carp.id,
      seed: 2,
      ticks: 24 * 3600 * 2,
      tickRateHz: 2,
      creatures: 2,
      ...LIVING_BEHAVIOR_CHECKS,
      onTick: (simulation) => {
        for (const c of simulation.snapshot().creatures) {
          seen.add(`${c.position.regionId}:${c.animation}:${c.submersion}`);
        }
      },
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    expect(report.eventCounts.entered_region ?? 0).toBe(0);
    expect(seen).toEqual(new Set([`river:swim:${SWIM_SUBMERSION}`]));
    // It sleeps where it is (ADR 0018 §13's fallback): water has no shelter yet.
    for (const c of Object.values(report.creatures))
      expect(c.asleepAtNightTicks).toBeGreaterThan(0);
  });
});

/** A behavior that walks to `destination` once, then idles. */
const goTo = (destination: RegionPosition): BehaviorProvider => ({
  id: "test:go_to",
  version: "1.0.0",
  dependencies: ["core:idle", "core:follow_path"].map((id) => ({
    registry: "actions" as const,
    id,
  })),
  evaluate(_observation, memory) {
    if (memory.sent) return null;
    memory.sent = true;
    return { action: "core:follow_path", params: { destination }, utility: 1 } satisfies Proposal;
  },
});

describe("crossing the river", () => {
  // From the woods' glade to the meadow by the river's south stretch, far from the bridge.
  const meadow: RegionPosition = { regionId: "east-meadow", x: 9, z: 14 };

  it("by the banks for an amphibian, while a walker takes the bridge", () => {
    const simulation = createSimulation({
      ...hollow,
      seed: 1,
      register: (r: Registries) => {
        registerHollowCreatures(r);
        r.behaviors.register(goTo(meadow));
        for (const [id, base] of [
          ["test:amphibian", otter],
          ["test:walker", mossling],
        ] as const) {
          r.species.register({ ...base, id, behaviors: ["test:go_to"] });
        }
      },
    });
    const spawn = (speciesId: string) => {
      const spawned = simulation.spawn(speciesId, "woods-glade");
      if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
      return spawned.value.id;
    };
    const amphibian = spawn("test:amphibian");
    const walker = spawn("test:walker");
    const events: SimulationEvent[] = [];
    const visited = { [amphibian]: new Set<string>(), [walker]: new Set<string>() };
    const done = () =>
      [amphibian, walker].every((id) => simulation.state.creatures.get(id)!.lastResult);
    for (let t = 0; t < 3_000 && !done(); t++) {
      events.push(...simulation.step());
      for (const c of simulation.snapshot().creatures) {
        visited[c.id]!.add(`${c.position.regionId}:${c.animation}`);
      }
    }
    for (const id of [amphibian, walker]) {
      const { position, lastResult } = simulation.state.creatures.get(id)!;
      expect(lastResult).toEqual({ action: "core:follow_path", outcome: "done" });
      expect(position).toEqual(meadow);
    }
    const moves = (id: string) =>
      events.flatMap((e) =>
        e.type === "entered_region" && e.creatureId === id
          ? [[e.fromRegionId, e.toRegionId, e.connectionId ?? "bank"]]
          : [],
      );
    expect(moves(amphibian)).toEqual([
      ["west-woods", "river", "bank"],
      ["river", "east-meadow", "bank"],
    ]);
    expect(moves(walker)).toEqual([
      ["west-woods", "bridge-deck", "bridge-west-end"],
      ["bridge-deck", "east-meadow", "bridge-east-end"],
    ]);
    const bridgeUsers = events.flatMap((e) =>
      e.type === "first_use_of_structure" ? [e.creatureId] : [],
    );
    expect(bridgeUsers).toEqual([walker]);
    expect(visited[amphibian]).toEqual(
      new Set(["west-woods:walk", "river:swim", "east-meadow:walk"]),
    );
    expect(visited[walker]).toEqual(
      new Set(["west-woods:walk", "bridge-deck:walk", "east-meadow:walk"]),
    );
  });

  it("keeps an amphibian's invariants, banks and all, through a living day", slow, () => {
    const jumps = new Set<string>();
    const report = runWithInvariants({
      ...hollow,
      speciesId: otter.id,
      seed: 1,
      ticks: 24 * 3600 * 2,
      tickRateHz: 2,
      creatures: 2,
      ...LIVING_BEHAVIOR_CHECKS,
      onTick: (_simulation, events) => {
        for (const e of events) {
          if (e.type === "entered_region" && e.connectionId === undefined) {
            jumps.add(`${e.fromRegionId} → ${e.toRegionId}`);
          }
        }
      },
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    expect(report.regionTicks.river).toBeGreaterThan(0);
    // In and out of the river by the banks, both ways.
    expect([...jumps].some((j) => j.endsWith("→ river"))).toBe(true);
    expect([...jumps].some((j) => j.startsWith("river →"))).toBe(true);
  });
});

describe("a hopper in Woodland Hollow", () => {
  it("hops everywhere it goes, bridge included, through a living day", slow, () => {
    const seen = new Set<string>();
    const report = runWithInvariants({
      ...hollow,
      speciesId: toad.id,
      seed: 3,
      ticks: 24 * 3600 * 2,
      tickRateHz: 2,
      creatures: 2,
      ...LIVING_BEHAVIOR_CHECKS,
      onTick: (simulation) => {
        for (const c of simulation.snapshot().creatures) {
          seen.add(`${c.animation}:${c.submersion}`);
        }
      },
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.firstStructureUse).toBeDefined();
    expect(seen).toEqual(new Set(["hop:0"]));
    expect(report.regionTicks.river).toBeUndefined();
  });

  it("shares a walker's navigation: a gait is a style, not a capability", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    expect(simulation.state.pathfinderFor(toad.id)).toBe(
      simulation.state.pathfinderFor(mossling.id),
    );
    simulation.spawn(toad.id);
    simulation.spawn(mossling.id);
    expect(simulation.snapshot().creatures.map((c) => c.animation)).toEqual(["hop", "walk"]);
  });
});
