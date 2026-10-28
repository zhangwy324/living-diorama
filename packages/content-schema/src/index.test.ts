import { describe, expect, it } from "vitest";
import {
  allConnections,
  BODY_THICKNESS,
  allRegions,
  formatDiagnostic,
  parseContentId,
  parseCreatureInstance,
  parseSpeciesDefinition,
  parseStructureDefinition,
  parseWorldDefinition,
  type Diagnostic,
  type Result,
} from "./index";

const rect = (x0: number, z0: number, x1: number, z1: number) => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
];

/** 4 × 2 m world: north bank, river, south bank, and a bridge deck over the river. */
function validWorld() {
  return {
    schemaVersion: 1,
    id: "test:tiny-world",
    version: "1.0.0",
    name: "Tiny world",
    bounds: { min: { x: -2, y: -1, z: -1 }, max: { x: 2, y: 3, z: 1 } },
    terrain: {
      heightfield: {
        source: "inline",
        columns: 5,
        rows: 3,
        cellSize: 1,
        heights: Array(15).fill(0),
      },
      materials: {
        palette: [{ name: "grass", color: "#7fae5a" }],
        indices: { source: "inline", values: Array(15).fill(0) },
      },
    },
    regions: [
      {
        id: "north",
        kind: "land",
        surface: { type: "core:heightfield" },
        footprint: rect(-2, -1, 2, -0.3),
      },
      {
        id: "river",
        kind: "water",
        surface: { type: "core:heightfield" },
        footprint: rect(-2, -0.3, 2, 0.3),
      },
      {
        id: "south",
        kind: "land",
        surface: { type: "core:heightfield" },
        footprint: rect(-2, 0.3, 2, 1),
      },
    ],
    structures: [
      {
        id: "bridge",
        structure: "core:wooden-bridge",
        transform: { position: { x: 0, y: 0.2, z: 0 } },
        regions: [
          {
            id: "deck",
            kind: "land",
            surface: {
              type: "core:deck",
              params: {
                centerline: [
                  { x: 0, y: 0.2, z: -0.4 },
                  { x: 0, y: 0.2, z: 0.4 },
                ],
                width: 0.5,
              },
            },
            footprint: rect(-0.25, -0.4, 0.25, 0.4),
          },
        ],
        connections: [
          {
            id: "deck-north",
            from: "north",
            to: "deck",
            portal: { a: { x: -0.25, z: -0.4 }, b: { x: 0.25, z: -0.4 } },
            requiredCapabilities: ["core:walk"],
          },
          {
            id: "deck-south",
            from: "deck",
            to: "south",
            portal: { a: { x: -0.25, z: 0.4 }, b: { x: 0.25, z: 0.4 } },
            requiredCapabilities: ["core:walk"],
          },
        ],
      },
    ],
    props: [
      {
        id: "pine-1",
        model: "core:models/pine.glb",
        transform: { position: { x: 1.5, y: 0, z: -0.8 } },
        blockRadius: 0.2,
      },
    ],
    spawnPoints: [{ id: "spawn-north", position: { regionId: "north", x: -1, z: -0.7 } }],
  };
}

function diagnostics<T>(result: Result<T>): Diagnostic[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.diagnostics;
}

function messages<T>(result: Result<T>): string[] {
  return diagnostics(result).map(formatDiagnostic);
}

describe("content IDs", () => {
  it("parses namespaced IDs, including dotted namespaces", () => {
    expect(parseContentId("core:wander")).toEqual({ namespace: "core", name: "wander" });
    expect(parseContentId("community.glow-frog:models/frog.glb")).toEqual({
      namespace: "community.glow-frog",
      name: "models/frog.glb",
    });
  });

  it("rejects malformed IDs", () => {
    for (const bad of ["wander", "Core:wander", ":wander", "core:", "core:a b", "core::x"]) {
      expect(parseContentId(bad)).toBeUndefined();
    }
  });
});

describe("WorldDefinition", () => {
  it("accepts a valid world and applies defaults", () => {
    const result = parseWorldDefinition(validWorld());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.connections).toEqual([]);
    expect(result.value.structures[0]?.transform).toMatchObject({ rotationY: 0, scale: 1 });
    expect(result.value.structures[0]?.connections[0]).toMatchObject({
      bidirectional: true,
      cost: 0,
    });
    expect(allRegions(result.value).map((r) => r.id)).toEqual(["north", "river", "south", "deck"]);
    expect(allConnections(result.value)).toHaveLength(2);
  });

  it("rejects an unsupported schema version with a single clear diagnostic", () => {
    const result = parseWorldDefinition(
      { ...validWorld(), schemaVersion: 2 },
      "worlds/test:tiny-world",
    );
    expect(messages(result)).toEqual([
      "error: worlds/test:tiny-world schemaVersion: world schema version 2 is not supported (supported: 1) (unsupported_schema_version)",
    ]);
  });

  it("reports wrong types and unknown keys with paths", () => {
    const world = validWorld();
    (world.regions[1] as Record<string, unknown>).kind = "lava";
    (world as Record<string, unknown>).colour = "blue";
    const found = diagnostics(parseWorldDefinition(world));
    expect(found.map((d) => d.path)).toEqual(expect.arrayContaining([["regions", 1, "kind"], []]));
    expect(found.find((d) => d.code === "unrecognized_keys")?.message).toContain("colour");
  });

  it("rejects malformed IDs with a readable message", () => {
    const world = validWorld();
    world.id = "tiny-world";
    world.regions[0]!.id = "North Bank";
    const text = messages(parseWorldDefinition(world));
    expect(text).toContain(
      'error: id: Expected a namespaced content ID like "core:bridge" (invalid_format)',
    );
    expect(text.some((m) => m.startsWith("error: regions[0].id: Expected a local ID"))).toBe(true);
  });

  it("rejects a heightfield whose size does not match the bounds", () => {
    const world = validWorld();
    world.terrain.heightfield.cellSize = 0.5;
    expect(messages(parseWorldDefinition(world))).toContain(
      "error: terrain.heightfield: Heightfield covers 2 × 1 m but the bounds are 4 × 2 m (custom)",
    );
  });

  it("rejects wrong sample counts and out-of-palette material indices", () => {
    const world = validWorld();
    world.terrain.heightfield.heights.pop();
    world.terrain.materials.indices.values[3] = 1;
    const found = diagnostics(parseWorldDefinition(world));
    expect(found.map((d) => d.path)).toEqual([
      ["terrain", "heightfield", "heights"],
      ["terrain", "materials", "indices", "values", 3],
    ]);
  });

  it("rejects duplicate local IDs across world and structure regions", () => {
    const world = validWorld();
    world.structures[0]!.regions[0]!.id = "river";
    // The bridge connections now point at "river" twice; keep them valid.
    world.structures[0]!.connections[0]!.to = "river";
    world.structures[0]!.connections[1]!.from = "river";
    const found = diagnostics(parseWorldDefinition(world));
    expect(found).toEqual([
      expect.objectContaining({
        message: 'Duplicate ID "river" (first used at regions.1.id)',
        path: ["structures", 0, "regions", 0, "id"],
      }),
    ]);
  });

  it("rejects dangling region references and self-connections", () => {
    const world = validWorld();
    world.structures[0]!.connections[0]!.from = "east";
    world.spawnPoints[0]!.position.regionId = "nowhere";
    world.structures[0]!.connections[1]!.to = "deck";
    expect(diagnostics(parseWorldDefinition(world))).toEqual([
      expect.objectContaining({
        message: "A connection must link two different regions",
        path: ["structures", 0, "connections", 1, "to"],
      }),
      expect.objectContaining({
        message: 'Unknown region "east"',
        path: ["structures", 0, "connections", 0, "from"],
      }),
      expect.objectContaining({
        message: 'Unknown region "nowhere"',
        path: ["spawnPoints", 0, "position", "regionId"],
      }),
    ]);
  });

  it("rejects positions outside the bounds", () => {
    const world = validWorld();
    world.spawnPoints[0]!.position.x = 5;
    expect(messages(parseWorldDefinition(world))).toEqual([
      "error: spawnPoints[0].position: Position (5, -0.7) is outside the world bounds (custom)",
    ]);
  });

  it("requires connections to name at least one capability", () => {
    const world = validWorld();
    world.structures[0]!.connections[0]!.requiredCapabilities = [];
    expect(messages(parseWorldDefinition(world))).toEqual([
      "error: structures[0].connections[0].requiredCapabilities: A connection must require at least one capability (too_small)",
    ]);
  });
});

describe("SpeciesDefinition", () => {
  const species = {
    schemaVersion: 1,
    id: "test:pebble",
    version: "0.1.0",
    name: "Pebble",
    appearance: "test:sprites/pebble.png",
    sizeClass: "small",
    capabilities: { "core:walk": 1 },
    baseSpeed: 0.6,
    behaviors: ["core:wander"],
  };

  it("accepts a minimal walker", () => {
    expect(parseSpeciesDefinition(species).ok).toBe(true);
  });

  it("gives a body the default thickness when it says none", () => {
    expect(BODY_THICKNESS.default).toBe(0.4);
    expect(parseSpeciesDefinition(species)).toMatchObject({
      ok: true,
      value: { body: { thickness: BODY_THICKNESS.default } },
    });
    expect(parseSpeciesDefinition({ ...species, body: {} })).toMatchObject({
      ok: true,
      value: { body: { thickness: BODY_THICKNESS.default } },
    });
  });

  it("keeps a thickness within its range and rejects one outside it", () => {
    for (const thickness of [BODY_THICKNESS.min, 0.25, BODY_THICKNESS.max]) {
      expect(parseSpeciesDefinition({ ...species, body: { thickness } })).toMatchObject({
        ok: true,
        value: { body: { thickness } },
      });
    }
    expect(messages(parseSpeciesDefinition({ ...species, body: { thickness: 0.05 } }))).toEqual([
      "error: body.thickness: Thickness must be at least 0.1 of the height (too_small)",
    ]);
    expect(messages(parseSpeciesDefinition({ ...species, body: { thickness: 0.9 } }))).toEqual([
      "error: body.thickness: Thickness must be at most 0.8 of the height (too_big)",
    ]);
    const odd = parseSpeciesDefinition({ ...species, body: { thickness: "thin", depth: 1 } });
    expect(diagnostics(odd).map((d) => d.path)).toEqual(
      expect.arrayContaining([["body", "thickness"], ["body"]]),
    );
  });

  it("rejects bad versions, sizes, capabilities and empty behaviors", () => {
    const found = diagnostics(
      parseSpeciesDefinition({
        ...species,
        version: "1.0",
        sizeClass: "huge",
        capabilities: { walk: 1, "core:swim": 0 },
        behaviors: [],
      }),
    );
    expect(found.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        ["version"],
        ["sizeClass"],
        ["capabilities", "walk"],
        ["capabilities", "core:swim"],
        ["behaviors"],
      ]),
    );
    expect(found.find((d) => d.path[0] === "version")?.message).toBe(
      'Expected a semantic version like "1.0.0"',
    );
  });

  it("defaults senses and traits to none and checks their keys", () => {
    expect(parseSpeciesDefinition(species)).toMatchObject({
      ok: true,
      value: { senses: {}, traits: {} },
    });
    expect(
      parseSpeciesDefinition({
        ...species,
        senses: { "core:vision": 8 },
        traits: { "core:nocturnal": 1 },
      }),
    ).toMatchObject({
      ok: true,
      value: { senses: { "core:vision": 8 }, traits: { "core:nocturnal": 1 } },
    });
    const found = diagnostics(
      parseSpeciesDefinition({
        ...species,
        senses: { vision: 8 },
        traits: { "core:nocturnal": "yes" },
      }),
    );
    expect(found.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        ["senses", "vision"],
        ["traits", "core:nocturnal"],
      ]),
    );
  });

  it("requires at least one capability", () => {
    expect(messages(parseSpeciesDefinition({ ...species, capabilities: {} }))).toEqual([
      "error: capabilities: A species needs at least one capability (custom)",
    ]);
  });
});

describe("StructureDefinition", () => {
  it("accepts a structure type with affordances", () => {
    const result = parseStructureDefinition({
      schemaVersion: 1,
      id: "test:plank-bridge",
      version: "1.0.0",
      name: "Plank bridge",
      affordances: ["core:crossable"],
    });
    expect(result).toMatchObject({ ok: true, value: { visualAssets: [] } });
  });
});

describe("CreatureInstance", () => {
  const creature = {
    id: "pebble-1",
    species: "test:pebble",
    speciesVersion: "0.1.0",
    position: { regionId: "deck", x: 0, z: 0.1 },
    heading: 0,
  };

  it("accepts a region-relative position", () => {
    expect(parseCreatureInstance(creature).ok).toBe(true);
  });

  it("rejects a heading outside [-π, π)", () => {
    expect(messages(parseCreatureInstance({ ...creature, heading: Math.PI }))).toEqual([
      "error: heading: Heading must be normalised to [-π, π) (too_big)",
    ]);
  });
});
