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
});

/** A behavior that walks to each of `destinations` in turn, then idles. */
const goTo = (...destinations: RegionPosition[]): BehaviorProvider => ({
  id: "test:go_to",
  version: "1.0.0",
  dependencies: ["core:idle", "core:follow_path"].map((id) => ({
    registry: "actions" as const,
    id,
  })),
  evaluate(_observation, memory) {
    const n = typeof memory.n === "number" ? memory.n : 0;
    const destination = destinations[n];
    if (!destination) return null;
    memory.n = n + 1;
    return { action: "core:follow_path", params: { destination }, utility: 1 } satisfies Proposal;
  },
});

describe("crossing the river", () => {
  // From the woods' glade down to the west bank's south stretch, far from the bridge, then over
  // to the meadow, where swimming saves about 24 m: more than the two bank jumps cost (#140).
  const southBank: RegionPosition = { regionId: "west-woods", x: -3, z: 14 };
  const meadow: RegionPosition = { regionId: "east-meadow", x: 9, z: 14 };

  it("by the banks for an amphibian, while a walker takes the bridge", () => {
    const simulation = createSimulation({
      ...hollow,
      seed: 1,
      register: (r: Registries) => {
        registerHollowCreatures(r);
        r.behaviors.register(goTo(southBank, meadow));
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
      [amphibian, walker].every((id) => {
        const { position, action } = simulation.state.creatures.get(id)!;
        return !action && position.x === meadow.x && position.z === meadow.z;
      });
    for (let t = 0; t < 6_000 && !done(); t++) {
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
});

describe("a living evening with an amphibian, a swimmer and a hopper", () => {
  it("keeps each to its own ways of moving, with every invariant held", slow, () => {
    /** Per species: region, animation and submersion seen; per creature: moves made. */
    const seen = new Map<string, Set<string>>();
    const moves = new Map<string, string[]>();
    const bridgeUsers = new Set<string>();
    const speciesOf = new Map<string, string>();
    const report = runWithInvariants({
      ...hollow,
      speciesId: otter.id,
      alsoSpawn: { [carp.id]: 1, [toad.id]: 1 },
      seed: 1,
      // From an hour before nightfall into the night: time to cross and settle, then sleep.
      startMinutes: 19 * 60,
      ticks: 3 * 3600 * 2,
      tickRateHz: 2,
      creatures: 1,
      ...LIVING_BEHAVIOR_CHECKS,
      onTick: (simulation, events) => {
        for (const c of simulation.snapshot().creatures) {
          speciesOf.set(c.id, c.speciesId);
          let set = seen.get(c.speciesId);
          if (!set) seen.set(c.speciesId, (set = new Set()));
          set.add(`${c.position.regionId}:${c.animation}:${c.submersion}`);
        }
        for (const e of events) {
          if (e.type === "first_use_of_structure") bridgeUsers.add(e.creatureId);
          if (e.type !== "entered_region") continue;
          const list = moves.get(e.creatureId) ?? [];
          list.push(`${e.fromRegionId} → ${e.toRegionId} via ${e.connectionId ?? "bank"}`);
          moves.set(e.creatureId, list);
        }
      },
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    const ofSpecies = (id: string) =>
      [...speciesOf].flatMap(([creature, species]) => (species === id ? [creature] : []));
    const [amphibian] = ofSpecies(otter.id);
    const [swimmer] = ofSpecies(carp.id);
    const [hopper] = ofSpecies(toad.id);

    // The swimmer never leaves the river, swimming half submerged all the while, and sleeps
    // where it is (ADR 0018 §13's fallback): water has no shelter yet.
    expect(seen.get(carp.id)).toEqual(new Set([`river:swim:${SWIM_SUBMERSION}`]));
    expect(moves.get(swimmer!)).toBeUndefined();
    expect(report.creatures[swimmer!]!.asleepAtNightTicks).toBeGreaterThan(0);

    // The hopper hops everywhere on land, crosses the bridge and never enters the river.
    expect([...seen.get(toad.id)!].every((s) => s.endsWith(":hop:0"))).toBe(true);
    expect([...seen.get(toad.id)!].some((s) => s.startsWith("river:"))).toBe(false);
    expect(bridgeUsers).toContain(hopper);

    // The amphibian jumps in and out of the river across the banks, both ways.
    const jumps = moves.get(amphibian!)!.filter((m) => m.endsWith("via bank"));
    expect(jumps.some((j) => j.includes("→ river"))).toBe(true);
    expect(jumps.some((j) => j.startsWith("river →"))).toBe(true);
    expect(report.regionTicks.river).toBeGreaterThan(0);
  });
});

describe("a hopper in Woodland Hollow", () => {
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
