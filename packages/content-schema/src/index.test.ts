import { describe, expect, it } from "vitest";
import {
  allConnections,
  ANCHOR_NAMES,
  BODY_THICKNESS,
  allRegions,
  defaultAnchor,
  defaultBody,
  DRAWING_SIZE,
  formatDiagnostic,
  parseContentId,
  parsePaletteDefinition,
  parsePartDefinition,
  parsePartTypeDefinition,
  parsePropCategoryDefinition,
  parsePropDefinition,
  parseSpeciesDefinition,
  parseStructureDefinition,
  parseWorldDefinition,
  PART_MOTIONS,
  drawnOnlySettings,
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
    schemaVersion: 2,
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
            requiredCapabilities: ["core:land"],
          },
          {
            id: "deck-south",
            from: "deck",
            to: "south",
            portal: { a: { x: -0.25, z: 0.4 }, b: { x: 0.25, z: 0.4 } },
            requiredCapabilities: ["core:land"],
          },
        ],
      },
    ],
    props: [
      {
        id: "pine-1",
        prop: "test:pine",
        transform: { position: { x: 1.5, y: 0, z: -0.8 } },
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
      { ...validWorld(), schemaVersion: 1 },
      "worlds/test:tiny-world",
    );
    expect(messages(result)).toEqual([
      "error: worlds/test:tiny-world schemaVersion: world schema version 1 is not supported (supported: 2) (unsupported_schema_version)",
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
    capabilities: { "core:land": 1 },
    baseSpeed: 0.6,
    behaviors: ["core:wander"],
  };

  it("accepts a minimal walker", () => {
    expect(parseSpeciesDefinition(species).ok).toBe(true);
  });

  it("leaves out the drawn-only settings a species doesn't write", () => {
    expect(BODY_THICKNESS.default).toBe(0.4);
    for (const input of [species, { ...species, body: {} }]) {
      const parsed = parseSpeciesDefinition(input);
      expect(parsed.ok && parsed.value.body).toEqual({ locomotion: { land: { gait: "walk" } } });
      expect(parsed.ok && drawnOnlySettings(parsed.value.body)).toEqual([]);
    }
    const drawn = parseSpeciesDefinition({ ...species, body: { thickness: 0.4, anchors: {} } });
    expect(drawn.ok && drawnOnlySettings(drawn.value.body)).toEqual(["thickness", "anchors"]);
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

  it("reads a species without a body plan with the walk gait alone", () => {
    const parsed = parseSpeciesDefinition(species);
    expect(parsed.ok && parsed.value.body).toEqual(defaultBody());
    expect(defaultBody()).toEqual({ locomotion: { land: { gait: "walk" } } });
    expect(
      parseSpeciesDefinition({ ...species, body: { locomotion: { land: {} } } }),
    ).toMatchObject({ ok: true, value: { body: { locomotion: { land: { gait: "walk" } } } } });
  });

  it("keeps a body plan's gait and anchors", () => {
    const body = {
      thickness: 0.3,
      locomotion: { land: { gait: "hop" } },
      anchors: { tail: { x: 0, y: 127.5 } },
    };
    expect(parseSpeciesDefinition({ ...species, body })).toMatchObject({
      ok: true,
      value: { body },
    });
    const corner = { ...body, anchors: { centerOfGravity: { x: 256, y: 256 } } };
    expect(parseSpeciesDefinition({ ...species, body: corner }).ok).toBe(true);
  });

  it("rejects an unknown gait or medium, and a template", () => {
    expect(
      messages(
        parseSpeciesDefinition({ ...species, body: { locomotion: { land: { gait: "run" } } } }),
      ),
    ).toEqual([
      "error: body.locomotion.land.gait: Unknown land gait (expected one of walk, hop) (invalid_value)",
    ]);
    // Templates are gone (ADR 0020, Follow-up: no body templates); the body plan is strict.
    expect(
      diagnostics(parseSpeciesDefinition({ ...species, body: { template: "walker" } })).map(
        (d) => d.code,
      ),
    ).toEqual(["unrecognized_keys"]);
    expect(
      diagnostics(parseSpeciesDefinition({ ...species, body: { locomotion: { air: {} } } })).map(
        (d) => d.code,
      ),
    ).toEqual(["unrecognized_keys"]);
  });

  it("rejects an anchor outside the drawing", () => {
    const at = (x: number, y: number) =>
      parseSpeciesDefinition({ ...species, body: { anchors: { centerOfGravity: { x, y } } } });
    expect(messages(at(-1, 10))).toEqual([
      `error: body.anchors.centerOfGravity.x: An anchor's x must be within the drawing, 0 to ${DRAWING_SIZE} (too_small)`,
    ]);
    expect(messages(at(10, DRAWING_SIZE + 0.5))).toEqual([
      `error: body.anchors.centerOfGravity.y: An anchor's y must be within the drawing, 0 to ${DRAWING_SIZE} (too_big)`,
    ]);
  });

  it("takes both anchors on any species, and no other", () => {
    const anchors = { centerOfGravity: { x: 128, y: 128 }, tail: { x: 10, y: 128 } };
    for (const capabilities of [{ "core:land": 1 }, { "core:swim": 1 }]) {
      expect(parseSpeciesDefinition({ ...species, capabilities, body: { anchors } })).toMatchObject(
        { ok: true, value: { body: { anchors } } },
      );
    }
    expect(
      diagnostics(
        parseSpeciesDefinition({ ...species, body: { anchors: { nose: { x: 1, y: 1 } } } }),
      ).map((d) => d.code),
    ).toEqual(["unrecognized_keys"]);
  });

  it("places default anchors on the drawn shape's bounds", () => {
    const bounds = { left: 40, top: 60, right: 200, bottom: 230 };
    expect(defaultAnchor("centerOfGravity", bounds)).toEqual({ x: 120, y: 145 });
    expect(defaultAnchor("tail", bounds)).toEqual({ x: 40, y: 145 });
    for (const name of ANCHOR_NAMES) {
      const body = { anchors: { [name]: defaultAnchor(name, bounds) } };
      expect(parseSpeciesDefinition({ ...species, body }).ok).toBe(true);
    }
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
      schemaVersion: 2,
      id: "test:plank-bridge",
      version: "1.0.0",
      name: "Plank bridge",
      affordances: { "core:crossable": {} },
    });
    expect(result).toMatchObject({ ok: true, value: { visualAssets: [] } });
  });

  it("rejects affordances given as a list", () => {
    const result = parseStructureDefinition({
      schemaVersion: 2,
      id: "test:plank-bridge",
      version: "1.0.0",
      name: "Plank bridge",
      affordances: ["core:crossable"],
    });
    expect(diagnostics(result).map((d) => d.path)).toEqual([["affordances"]]);
  });
});

describe("PropDefinition", () => {
  const mushroom = {
    schemaVersion: 2,
    id: "test:mushroom",
    version: "1.0.0",
    name: "Mushroom",
    model: "test:models/mushroom.glb",
    blockRadius: 0,
    affordances: { "core:food": { eatSeconds: 5 } },
  };

  it("accepts a prop type with affordance params, which resolving checks", () => {
    expect(parsePropDefinition(mushroom)).toMatchObject({ ok: true, value: mushroom });
  });

  it("defaults to offering nothing", () => {
    const pine = { ...mushroom, id: "test:pine", affordances: undefined };
    expect(parsePropDefinition(pine)).toMatchObject({ ok: true, value: { affordances: {} } });
  });

  it("rejects a negative block radius and a bad affordance ID", () => {
    const found = diagnostics(
      parsePropDefinition({ ...mushroom, blockRadius: -1, affordances: { food: {} } }),
    );
    expect(found.map((d) => d.path)).toEqual([["blockRadius"], ["affordances", "food"]]);
  });

  it("may name a category, which must be a content ID", () => {
    const listed = { ...mushroom, category: "test:mushrooms" };
    expect(parsePropDefinition(listed)).toMatchObject({ ok: true, value: listed });
    const loose = parsePropDefinition(mushroom);
    expect(loose.ok && "category" in loose.value).toBe(false);
    const found = diagnostics(parsePropDefinition({ ...mushroom, category: "mushrooms" }));
    expect(found.map((d) => d.path)).toEqual([["category"]]);
  });

  it("rejects a prop type of schema version 1", () => {
    expect(
      diagnostics(parsePropDefinition({ ...mushroom, schemaVersion: 1 })).map((d) => d.code),
    ).toEqual(["unsupported_schema_version"]);
  });
});

describe("PropCategoryDefinition", () => {
  const trees = {
    schemaVersion: 1,
    id: "test:trees",
    version: "1.0.0",
    name: "Trees",
    order: 10,
  };

  it("accepts a category with a display name and an order", () => {
    expect(parsePropCategoryDefinition(trees)).toEqual({ ok: true, value: trees });
    expect(parsePropCategoryDefinition({ ...trees, order: -2.5 }).ok).toBe(true);
  });

  it("requires a name and a finite order, and allows nothing else", () => {
    const found = diagnostics(
      parsePropCategoryDefinition({ ...trees, name: "", order: Infinity, icon: "tree.png" }),
    );
    expect(found.map((d) => d.path.join("."))).toEqual(["name", "order", ""]);
  });
});

describe("PartTypeDefinition", () => {
  const torso = { schemaVersion: 2, id: "test:torso", version: "1.0.0", name: "Torso" };

  it("has the tail and root roles, and fits nothing by default", () => {
    expect(parsePartTypeDefinition({ ...torso, role: "root" })).toEqual({
      ok: true,
      value: { ...torso, fits: [], role: "root" },
    });
    expect(parsePartTypeDefinition({ ...torso, role: "tail" }).ok).toBe(true);
    const found = diagnostics(parsePartTypeDefinition({ ...torso, role: "torso" }));
    expect(found.map((d) => [d.path.join("."), d.message])).toEqual([
      ["role", "Unknown part role (expected tail, root)"],
    ]);
  });

  it("takes a motion from the closed list, and none by default", () => {
    expect(parsePartTypeDefinition({ ...torso, motion: "swing" })).toEqual({
      ok: true,
      value: { ...torso, fits: [], motion: "swing" },
    });
    for (const motion of PART_MOTIONS) {
      expect(parsePartTypeDefinition({ ...torso, motion }).ok).toBe(true);
    }
    const parsed = parsePartTypeDefinition(torso);
    if (!parsed.ok) throw new Error("The torso doesn't parse");
    expect("motion" in parsed.value).toBe(false);
    const found = diagnostics(parsePartTypeDefinition({ ...torso, motion: "wiggle" }));
    expect(found.map((d) => [d.path.join("."), d.message])).toEqual([
      ["motion", "Unknown part motion (expected swing, wag, bob, paddle, flop, blink)"],
    ]);
  });
});

describe("PaletteDefinition", () => {
  const woods = {
    schemaVersion: 1,
    id: "test:woods",
    version: "1.0.0",
    name: "Woods",
    colors: ["#479571", "#BF7E45"],
  };

  it("accepts plain sRGB colours in either case", () => {
    expect(parsePaletteDefinition(woods)).toEqual({ ok: true, value: woods });
  });

  it("needs a colour, takes each once ignoring case, and allows nothing else", () => {
    const paths = (input: unknown) =>
      diagnostics(parsePaletteDefinition(input)).map((d) => d.path.join("."));
    expect(paths({ ...woods, colors: [] })).toEqual(["colors"]);
    expect(paths({ ...woods, colors: ["#479571", "rgb(1,2,3)"] })).toEqual(["colors.1"]);
    expect(paths({ ...woods, colors: ["#bf7e45", "#BF7E45"] })).toEqual(["colors.1"]);
    expect(paths({ ...woods, theme: "woodland" })).toEqual([""]);
    expect(diagnostics(parsePaletteDefinition({ ...woods, schemaVersion: 2 }))[0]?.code).toBe(
      "unsupported_schema_version",
    );
  });
});

describe("PartDefinition", () => {
  const leg = {
    schemaVersion: 1,
    id: "test:stubby-leg",
    version: "1.0.0",
    name: "Stubby leg",
    part: {
      type: "test:leg",
      size: { x: 1, y: 2, z: 1 },
      step: 0.05,
      colors: ["#7fae5a"],
      voxels: [2, 1],
      attach: { x: 0.5, y: 2, z: 0.5 },
      sockets: [{ id: "foot", type: "test:foot", position: { x: 0.5, y: 0, z: 0.5 } }],
    },
  };

  it("accepts a part inline under a header", () => {
    expect(parsePartDefinition(leg)).toEqual({ ok: true, value: leg });
  });

  it("checks the part as a voxel part: its step on the ladder and its cubes", () => {
    const step = diagnostics(parsePartDefinition({ ...leg, part: { ...leg.part, step: 0.03 } }));
    expect(step.map((d) => d.path.join("."))).toEqual(["part.step"]);
    const runs = diagnostics(
      parsePartDefinition({ ...leg, part: { ...leg.part, voxels: [1, 1] } }),
    );
    expect(runs.map((d) => d.path.join("."))).toEqual(["part.voxels"]);
  });

  it("refuses a source: a registered part is where copies come from", () => {
    const found = diagnostics(
      parsePartDefinition({ ...leg, part: { ...leg.part, source: "test:other-leg" } }),
    );
    expect(found.map((d) => d.path.join("."))).toEqual(["part.source"]);
  });

  it("may be marked as the part the Studio starts from", () => {
    expect(parsePartDefinition({ ...leg, starter: true })).toEqual({
      ok: true,
      value: { ...leg, starter: true },
    });
    const found = diagnostics(parsePartDefinition({ ...leg, starter: "yes" }));
    expect(found.map((d) => d.path.join("."))).toEqual(["starter"]);
  });

  it("needs a name and allows nothing else", () => {
    const found = diagnostics(parsePartDefinition({ ...leg, name: "", mirrored: true }));
    expect(found.map((d) => d.path.join("."))).toEqual(["name", ""]);
  });

  it("names an unsupported schema version", () => {
    const found = diagnostics(parsePartDefinition({ ...leg, schemaVersion: 2 }, "parts/x"));
    expect(found.map((d) => [d.code, d.source])).toEqual([
      ["unsupported_schema_version", "parts/x"],
    ]);
  });
});
