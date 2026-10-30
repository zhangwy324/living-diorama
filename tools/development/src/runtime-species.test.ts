import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { formatDiagnostic, type SizeClass } from "@living-diorama/content-schema";
import type { SpeciesAppearanceKind } from "@living-diorama/extension-api";
import { describeContent, type Simulation, type SimulationEvent } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { registerRiverCrossing } from "./index";
import { createSimulation, runWithInvariants } from "./simulation-run";

// Species and creatures added while the world runs (roadmap M9, ADR 0012).

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

/** A drawn species as the app would send it: a `user` ID, walking and wandering. */
function drawnSpecies(name: string, sizeClass: SizeClass = "medium") {
  return {
    schemaVersion: 1,
    id: `user:${name}`,
    version: "1.0.0",
    name,
    appearance: `user:${name}/appearance.png`,
    sizeClass,
    capabilities: { "core:land": 1 },
    baseSpeed: 0.5,
    behaviors: ["core:wander"],
  };
}

const URL = "blob:http://localhost/drawing";

function expectOk(simulation: Simulation, input: unknown, kind: SpeciesAppearanceKind = "image") {
  const result = simulation.registerSpecies(input, URL, kind);
  expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([]);
}

const codes = (result: { ok: boolean; diagnostics?: { code: string }[] }) =>
  result.ok ? [] : (result.diagnostics ?? []).map((d) => d.code);

/** Registers a drawn species of this size mid-run in the Hollow, spawns some and runs on. */
function runSized(sizeClass: SizeClass, seed: number) {
  const limits: string[] = [];
  const events: SimulationEvent[] = [];
  const report = runWithInvariants({
    ...hollow,
    seed,
    ticks: 30_000,
    creatures: 1,
    onTick: (simulation, tickEvents) => {
      events.push(...tickEvents);
      if (simulation.tick !== 10) return;
      const result = simulation.registerSpecies(drawnSpecies(sizeClass, sizeClass), URL, "image");
      if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
      limits.push(...result.value.limits.map((d) => `${d.severity} ${d.code}`));
      for (let n = 0; n < 4; n++) expect(simulation.spawn(`user:${sizeClass}`).ok).toBe(true);
    },
  });
  const sized = new Set(
    events.flatMap((e) =>
      e.type === "creature_spawned" && e.speciesId !== hollow.speciesId ? [e.creatureId] : [],
    ),
  );
  const entered = new Set(
    events.flatMap((e) =>
      e.type === "entered_region" && sized.has(e.creatureId) ? [e.toRegionId] : [],
    ),
  );
  return { report, limits, entered };
}

describe("size limits (ADR 0013)", () => {
  it.each(["tiny", "small"] as const)(
    "%s creatures wander everywhere, with no limits for the edge slivers they can't reach",
    (sizeClass) => {
      const { report, limits, entered } = runSized(sizeClass, 3);
      // The river mouths leave cut-off islands of 2 to 4 cells (at most 1 m²): too small to count.
      expect(limits).toEqual([]);
      expect(report.violations).toEqual([]);
      expect(report.eventCounts.path_failed ?? 0).toBe(0);
      expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
      expect(entered.has("bridge-deck")).toBe(true);
    },
  );

  it("large creatures can't cross the bridge and never try", () => {
    const { report, limits, entered } = runSized("large", 4);
    expect(limits).toContain("warning portal_unusable");
    expect(limits).toContain("warning disconnected_region");
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(entered.has("bridge-deck")).toBe(false);
  });

  it("still reports cut-off areas larger than a square metre, and counts only those", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const result = simulation.registerSpecies(drawnSpecies("boulder", "large"), URL, "image");
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    const splits = result.value.limits.filter((d) => d.code === "disconnected_region");
    // West woods: an 18-cell (4.5 m²) island. East meadow: the 163 cells behind the rock; its
    // 3-, 1- and 1-cell slivers are left out.
    expect(splits.map((d) => d.message)).toEqual([
      expect.stringMatching(/"west-woods" splits into 2 walkable areas .*; 18 more,/),
      expect.stringMatching(/"east-meadow" splits into 2 walkable areas .*; 163 more,/),
    ]);
  });

  it("names the structure a creature can't use", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const result = simulation.registerSpecies(drawnSpecies("boulder", "large"), URL, "image");
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    const portals = result.value.limits.filter((d) => d.code === "portal_unusable");
    expect(portals.map((d) => d.message)).toEqual([
      expect.stringContaining('"bridge-west-end" of "bridge" is unusable for size class large'),
      expect.stringContaining('"bridge-east-end" of "bridge" is unusable for size class large'),
    ]);
  });

  it("reports no limits for a size that fits everywhere", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const result = simulation.registerSpecies(drawnSpecies("puddle"), URL, "image");
    expect(result.ok && result.value.limits).toEqual([]);
  });
});

describe("runtime species", () => {
  it("registers a species mid-run, spawns and despawns its creatures, and keeps every invariant", () => {
    const events: SimulationEvent[] = [];
    const report = runWithInvariants({
      ...hollow,
      seed: 11,
      ticks: 20_000,
      creatures: 3,
      onTick: (simulation, tickEvents) => {
        events.push(...tickEvents);
        if (simulation.tick === 1_000) {
          expectOk(simulation, drawnSpecies("puddle"));
          for (let n = 0; n < 3; n++) expect(simulation.spawn("user:puddle").ok).toBe(true);
        }
        if (simulation.tick === 5_000) {
          const [first] = [...simulation.state.creatures.values()].filter(
            (c) => c.speciesId === "user:puddle",
          );
          expect(simulation.despawn(first!.id).ok).toBe(true);
        }
      },
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
    expect(report.eventCounts.path_failed ?? 0).toBe(0);
    expect(report.eventCounts.creature_spawned).toBe(6);
    expect(report.eventCounts.species_introduced).toBe(2);
    expect(report.eventCounts.creature_despawned).toBe(1);
    // The drawn creatures wander like the mosslings: over the bridge too.
    const drawn = new Set(
      events.flatMap((e) =>
        e.type === "creature_spawned" && e.speciesId === "user:puddle" ? [e.creatureId] : [],
      ),
    );
    const crossed = events.filter(
      (e) => e.type === "first_use_of_structure" && drawn.has(e.creatureId),
    );
    expect(crossed.length).toBeGreaterThan(0);
  });

  it("builds and checks navigation for a new profile", () => {
    const simulation = createSimulation({ ...river, seed: 1 });
    expect(simulation.state.navigations).toHaveLength(1);
    expectOk(simulation, drawnSpecies("speck", "tiny"));
    expect(simulation.state.navigations).toHaveLength(2);
    expect(simulation.state.pathfinderFor("user:speck")).not.toBe(
      simulation.state.pathfinderFor(river.speciesId),
    );
    const report = runWithInvariants({
      ...river,
      seed: 2,
      ticks: 20_000,
      creatures: 1,
      // Short walks in a small world (see LongRunCheckOptions).
      maxDecisionsPer10Seconds: 2,
      onTick: (sim) => {
        if (sim.tick === 100) {
          expectOk(sim, drawnSpecies("speck", "tiny"));
          expect(sim.spawn("user:speck").ok).toBe(true);
        }
      },
    });
    expect(report.violations).toEqual([]);
    expect(report.eventCounts.first_use_of_structure).toBe(2);
  });

  it("rejects a species that can't stand on any spawn point", () => {
    const simulation = createSimulation({ ...river, seed: 1 });
    const result = simulation.registerSpecies(drawnSpecies("boulder", "large"), URL, "image");
    expect(codes(result)).toEqual(["no_spawn_point"]);
    expect(simulation.state.registries.species.has("user:boulder")).toBe(false);
    expect(simulation.state.registries.assets.has("user:boulder/appearance.png")).toBe(false);
    expect(simulation.state.navigations).toHaveLength(1);
  });

  it("rejects invalid species and registers nothing", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const before = simulation.state.registries.species.size;
    expect(
      codes(simulation.registerSpecies({ ...drawnSpecies("x"), baseSpeed: -1 }, URL, "image")),
    ).toEqual(["too_small"]);
    expect(
      codes(
        simulation.registerSpecies(
          { ...drawnSpecies("x"), behaviors: ["core:dance"] },
          URL,
          "image",
        ),
      ),
    ).toEqual(["unresolved_reference"]);
    expect(
      codes(
        simulation.registerSpecies(
          { ...drawnSpecies("x"), capabilities: { "core:fly": 1 } },
          URL,
          "image",
        ),
      ),
    ).toEqual(["unresolved_reference"]);
    expect(codes(simulation.registerSpecies(drawnSpecies("x"), "", "image"))).toEqual([
      "invalid_type",
    ]);
    expect(
      codes(
        simulation.registerSpecies({ ...drawnSpecies("x"), id: hollow.speciesId }, URL, "image"),
      ),
    ).toEqual(["duplicate_id"]);
    expect(simulation.state.registries.species.size).toBe(before);
    expect(simulation.state.registries.assets.has("user:x/appearance.png")).toBe(false);
    // The world keeps running.
    expect(simulation.spawn(hollow.speciesId).ok).toBe(true);
    simulation.step();
  });

  it("registers a voxel species' appearance as a voxel asset by URL, and its creatures move", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const species = { ...drawnSpecies("cubes"), appearance: "user:cubes/assembly.json" };
    const result = simulation.registerSpecies(species, "blob:http://localhost/assembly", "voxel");
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([]);
    // Only the kind and the URL are kept: the simulation never reads the assembly.
    expect(simulation.state.registries.assets.get("user:cubes/assembly.json")).toEqual({
      id: "user:cubes/assembly.json",
      version: "1.0.0",
      kind: "voxel",
      url: "blob:http://localhost/assembly",
    });
    expect(simulation.spawn("user:cubes").ok).toBe(true);
    for (let i = 0; i < 50; i++) simulation.step();
    // What `ready` sends the main thread: the asset's kind and URL, and only the locomotion of
    // the body plan. Thickness and anchors are drawn-only; the cubes stay in the asset.
    const content = describeContent(simulation);
    expect(content.assets["user:cubes/assembly.json"]).toEqual({
      kind: "voxel",
      url: "blob:http://localhost/assembly",
    });
    expect(content.species["user:cubes"]).toEqual({
      appearance: "user:cubes/assembly.json",
      sizeClass: "medium",
      body: { locomotion: { land: { gait: "walk" } } },
    });
    const drawn = { ...drawnSpecies("drawn"), body: { thickness: 0.6 } };
    expect(simulation.registerSpecies(drawn, URL, "image").ok).toBe(true);
    expect(describeContent(simulation).species["user:drawn"]?.body).toHaveProperty(
      "thickness",
      0.6,
    );
    // A voxel species can't set the drawn-only settings (ADR 0022, M20).
    const thick = { ...drawnSpecies("thick"), appearance: "user:thick/assembly.json" };
    const refused = simulation.registerSpecies(
      { ...thick, body: { thickness: 0.6 } },
      URL,
      "voxel",
    );
    expect(codes(refused)).toEqual(["drawn_only_setting"]);
    expect(simulation.state.registries.species.has("user:thick")).toBe(false);
  });

  it("refuses cubes in the species and appearance kinds a species can't have", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const before = simulation.state.registries.species.size;
    const assembly = { root: { part: { size: [1, 1, 1], voxels: [1, 1], colors: ["#fff"] } } };
    expect(
      codes(simulation.registerSpecies({ ...drawnSpecies("x"), assembly }, URL, "voxel")),
    ).toEqual(["unrecognized_keys"]);
    expect(
      codes(simulation.registerSpecies({ ...drawnSpecies("x"), body: { assembly } }, URL, "voxel")),
    ).toEqual(["unrecognized_keys"]);
    // The worker gets the kind from another thread, so it is checked like the rest.
    expect(codes(simulation.registerSpecies(drawnSpecies("x"), URL, "model" as never))).toEqual([
      "invalid_value",
    ]);
    expect(codes(simulation.registerSpecies(drawnSpecies("x"), URL, "sound" as never))).toEqual([
      "invalid_value",
    ]);
    expect(simulation.state.registries.species.size).toBe(before);
    expect(simulation.state.registries.assets.has("user:x/appearance.png")).toBe(false);
  });

  it("caps the creatures in the world", () => {
    const simulation = createSimulation({ ...hollow, seed: 1, maxCreatures: 2 });
    expect(simulation.spawn(hollow.speciesId).ok).toBe(true);
    const second = simulation.spawn(hollow.speciesId);
    expect(simulation.spawn(hollow.speciesId)).toEqual({
      ok: false,
      diagnostics: [expect.objectContaining({ code: "world_full", message: expect.any(String) })],
    });
    if (!second.ok) throw new Error("Expected a second creature");
    expect(simulation.despawn(second.value.id).ok).toBe(true);
    expect(simulation.spawn(hollow.speciesId).ok).toBe(true);
  });

  it("introduces a species once and reports despawns", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const a = simulation.spawn(hollow.speciesId);
    simulation.spawn(hollow.speciesId);
    if (!a.ok) throw new Error("Expected a creature");
    simulation.step();
    expect(codes(simulation.despawn("creature-99"))).toEqual(["unknown_creature"]);
    simulation.despawn(a.value.id);
    simulation.spawn(hollow.speciesId);
    const events = simulation.step();
    expect(events.map((e) => [e.type, "creatureId" in e && e.creatureId])).toEqual([
      ["creature_despawned", a.value.id],
      ["creature_spawned", "creature-3"],
    ]);
    expect(events[0]).toMatchObject({ speciesId: hollow.speciesId, regionId: expect.any(String) });
    expect(simulation.snapshot().creatures.map((c) => c.id)).toEqual(["creature-2", "creature-3"]);
  });
});

describe("limits query (ADR 0015 §8)", () => {
  const land = { "core:land": 1 };

  it("answers with the limits a species of that size would be registered with", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const checked = simulation.checkLimits("large", land);
    if (!checked.ok) throw new Error(checked.diagnostics.map(formatDiagnostic).join("\n"));
    const registered = createSimulation({ ...hollow, seed: 1 }).registerSpecies(
      drawnSpecies("boulder", "large"),
      URL,
      "image",
    );
    expect(registered.ok && registered.value.limits).toEqual(checked.value);
    expect(checked.value.filter((d) => d.code === "portal_unusable")).toMatchObject([
      { severity: "warning", structure: { id: "bridge", name: "Wooden bridge" } },
      { severity: "warning", structure: { id: "bridge", name: "Wooden bridge" } },
    ]);
    expect(simulation.checkLimits("medium", land)).toEqual({ ok: true, value: [] });
  });

  it("registers nothing, and keeps a new profile's navigation for later", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const species = simulation.state.registries.species.values().length;
    const navigations = simulation.state.navigations.length;
    const first = simulation.checkLimits("tiny", land);
    expect(simulation.state.navigations).toHaveLength(navigations + 1);
    expect(simulation.checkLimits("tiny", land)).toEqual(first);
    expect(simulation.state.navigations).toHaveLength(navigations + 1);
    expect(simulation.state.registries.species.values()).toHaveLength(species);
    expectOk(simulation, drawnSpecies("pip", "tiny"));
    expect(simulation.state.navigations).toHaveLength(navigations + 1);
  });

  it("returns the errors of a profile that can't appear as limits", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const checked = simulation.checkLimits("small", {});
    expect(checked.ok && checked.value.map((d) => `${d.severity} ${d.code}`)).toEqual([
      "error no_spawn_point",
    ]);
  });

  it("fails for a size class or capability that doesn't exist", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    expect(codes(simulation.checkLimits("huge" as SizeClass, { "core:fly": 1 }))).toEqual([
      "unknown_size_class",
      "unknown_capability",
    ]);
  });
});
