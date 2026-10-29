import {
  defaultBody,
  FoodAffordanceParamsSchema,
  formatDiagnostic,
  type Result,
} from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import {
  addEntries,
  animationProfile,
  createRegistries,
  resolveReferences,
  type Registries,
} from "./index";

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

function expectOk<T>(result: Result<T>) {
  expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([]);
}

/** 2 × 2 m flat world with one land region. */
const world = {
  schemaVersion: 2,
  id: "test:flat",
  version: "1.0.0",
  name: "Flat",
  bounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
  terrain: {
    heightfield: { source: "inline", columns: 3, rows: 3, cellSize: 1, heights: Array(9).fill(0) },
    materials: {
      palette: [{ name: "grass", color: "#7fae5a" }],
      indices: { source: "inline", values: Array(9).fill(0) },
    },
  },
  spawnPoints: [{ id: "middle", position: { regionId: "ground", x: 0, z: 0 } }],
  regions: [
    {
      id: "ground",
      kind: "land",
      surface: { type: "core:heightfield" },
      footprint: [
        { x: -1, z: -1 },
        { x: 1, z: -1 },
        { x: 1, z: 1 },
        { x: -1, z: 1 },
      ],
    },
  ],
};

const sprite = {
  id: species.appearance,
  version: "1.0.0",
  kind: "image",
  url: "https://example.test/pebble.png",
};

function withActions(registries: Registries) {
  expectOk(registries.assets.register(sprite));
  expectOk(registries.actions.register({ id: "core:idle", version: "1.0.0" }));
  expectOk(registries.actions.register({ id: "core:follow_path", version: "1.2.0" }));
  expectOk(
    registries.capabilities.register({
      id: "core:walk",
      version: "1.0.0",
      locomotion: { regionKinds: ["land"], maxSlopeDeg: 35 },
    }),
  );
}

describe("Registry", () => {
  it("validates content on registration and looks entries up by ID", () => {
    const registries = createRegistries();
    expectOk(registries.species.register(species));
    expect(registries.species.get("test:pebble")?.baseSpeed).toBe(0.6);
    expect(registries.species.has("test:other")).toBe(false);
    expect(registries.species.size).toBe(1);
  });

  it("returns diagnostics labelled with the registry and ID for invalid content", () => {
    const result = createRegistries().species.register({ ...species, baseSpeed: -1 });
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      "error: species/test:pebble baseSpeed: Too small: expected number to be >0 (too_small)",
    ]);
  });

  it("validates without registering", () => {
    const registries = createRegistries();
    expectOk(registries.species.validate(species));
    expect(registries.species.size).toBe(0);
  });

  it("rejects duplicate IDs regardless of version", () => {
    const registries = createRegistries();
    expectOk(registries.species.register(species));
    const result = registries.species.register({ ...species, version: "0.2.0" });
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      'error: species/test:pebble id: "test:pebble" is already registered in species (version 0.1.0; this one is 0.2.0) (duplicate_id)',
    ]);
    expect(registries.species.get("test:pebble")?.version).toBe("0.1.0");
  });

  it("validates code entries: ID, version, dependencies and surface schemas", () => {
    const registries = createRegistries();
    const result = registries.behaviors.register({
      id: "wander",
      version: "1",
      dependencies: [{ registry: "moves", id: "core:idle", version: "not a range" }],
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => d.path.join("."))).toEqual([
      "id",
      "version",
      "dependencies.0.registry",
      "dependencies.0.version",
    ]);

    const surface = registries.surfaces.register({ id: "core:deck", version: "1.0.0" });
    expect(surface.ok ? [] : surface.diagnostics.map((d) => d.message)).toEqual([
      "Expected a params schema",
    ]);
  });

  it("validates affordances: a params schema and a positive whole remember cap", () => {
    const registries = createRegistries();
    expectOk(
      registries.affordances.register({
        id: "core:food",
        version: "1.0.0",
        paramsSchema: FoodAffordanceParamsSchema,
        remember: 8,
      }),
    );
    const result = registries.affordances.register({
      id: "core:shelter",
      version: "1.0.0",
      remember: 2.5,
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => d.path.join("."))).toEqual([
      "paramsSchema",
      "remember",
    ]);
  });

  it("validates needs: rates, actAt, ascending triggers including actAt, cue and atMax", () => {
    const registries = createRegistries();
    const hunger = {
      id: "core:hunger",
      version: "1.0.0",
      perHour: { awake: 0.6, asleep: 0.06 },
      actAt: 0.4,
      triggers: [0.4, 0.9, 1],
      cue: { cue: "hungry", from: 0.8 },
      atMax: { speedFactor: 0.8 },
      rateTrait: "core:appetite",
      variation: 0.15,
    };
    expectOk(registries.needs.validate(hunger));
    expectOk(registries.needs.validate({ ...hunger, cue: undefined }));
    expectOk(registries.needs.validate({ ...hunger, startBelow: 0.1 }));
    expectOk(registries.needs.validate({ ...hunger, startBelow: 0.4 }));
    const above = registries.needs.validate({ ...hunger, startBelow: 0.5 });
    expect(
      above.ok ? [] : above.diagnostics.map((d) => `${d.path.join(".")}: ${d.message}`),
    ).toEqual(["startBelow: startBelow must be at most actAt"]);
    expectOk(
      registries.needs.validate({
        id: "core:tiredness",
        version: "1.0.0",
        perHour: { awake: 0.05, asleep: -0.125 },
        actAt: 0.9,
        triggers: [0.9],
      }),
    );
    const bad = registries.needs.validate({
      ...hunger,
      perHour: { awake: "fast" },
      startBelow: 0,
      triggers: [0.9, 0.5, 1.5],
      cue: { cue: "eating", from: 0 },
      atMax: { speedFactor: 2 },
      rateTrait: "appetite",
      variation: 1,
    });
    expect(bad.ok ? [] : bad.diagnostics.map((d) => `${d.path.join(".")}: ${d.message}`)).toEqual([
      "perHour.awake: Expected the change per hour awake",
      "perHour.asleep: Expected the change per hour asleep",
      "startBelow: startBelow must be a number in (0, 1]",
      "triggers.1: Triggers must be in ascending order",
      "triggers.2: A trigger must be a number in (0, 1]",
      "triggers: Triggers must include actAt",
      'cue.cue: Unknown need cue "eating" (expected one of hungry)',
      "cue.from: A cue's from must be a number in (0, 1]",
      "atMax.speedFactor: speedFactor must be a number in (0, 1]",
      'rateTrait: Expected a namespaced content ID like "core:appetite"',
      "variation: variation must be a number in [0, 1)",
    ]);
    // A null cue is reported, not thrown on.
    const nullCue = registries.needs.validate({ ...hunger, cue: null });
    expect(nullCue.ok ? [] : nullCue.diagnostics.map((d) => d.path.join("."))).toEqual(["cue"]);
  });

  it("validates action cues against the action cue list", () => {
    const registries = createRegistries();
    expectOk(registries.actions.validate({ id: "core:eat", version: "1.0.0", cue: "eating" }));
    const result = registries.actions.validate({ id: "core:eat", version: "1.0.0", cue: "hungry" });
    expect(result.ok ? [] : result.diagnostics.map((d) => d.message)).toEqual([
      'Unknown action cue "hungry" (expected one of eating, sleeping)',
    ]);
  });

  it("resolves a need's rate trait", () => {
    const registries = createRegistries();
    expectOk(
      registries.needs.register({
        id: "core:hunger",
        version: "1.0.0",
        perHour: { awake: 0.6, asleep: 0.06 },
        actAt: 0.4,
        triggers: [0.4],
        rateTrait: "core:appetite",
      }),
    );
    expect(resolveReferences(registries).diagnostics.map(formatDiagnostic)).toEqual([
      'error: needs/core:hunger rateTrait: "core:appetite" is not registered in traits (unresolved_reference)',
    ]);
    expectOk(
      registries.traits.register({
        id: "core:appetite",
        version: "1.0.0",
        default: 1,
        min: 0.5,
        max: 2,
      }),
    );
    expect(resolveReferences(registries).diagnostics).toEqual([]);
  });

  it("validates senses and traits: a default within [min, max]", () => {
    const registries = createRegistries();
    expectOk(
      registries.traits.validate({
        id: "core:nocturnal",
        version: "1.0.0",
        default: 0,
        min: 0,
        max: 1,
      }),
    );
    const outside = registries.senses.validate({
      id: "core:vision",
      version: "1.0.0",
      default: 40,
      min: 1,
      max: 30,
    });
    expect(outside.ok ? [] : outside.diagnostics.map((d) => d.path.join("."))).toEqual(["default"]);
    const missing = registries.senses.validate({ id: "core:vision", version: "1.0.0", min: 1 });
    expect(missing.ok ? [] : missing.diagnostics.map((d) => d.path.join("."))).toEqual([
      "default",
      "max",
    ]);
    const odd = registries.traits.validate({
      id: "core:nocturnal",
      version: "1.0.0",
      default: 0.5,
      min: 0,
      max: 1,
      integer: true,
    });
    expect(odd.ok ? [] : odd.diagnostics.map((d) => d.message)).toEqual([
      "default must be a whole number",
    ]);
    const varied = registries.senses.validate({
      id: "core:vision",
      version: "1.0.0",
      default: 8,
      min: 1,
      max: 30,
      variation: -0.1,
      integer: "yes",
    });
    expect(varied.ok ? [] : varied.diagnostics.map((d) => d.path.join("."))).toEqual([
      "integer",
      "variation",
    ]);
  });

  it("checks that an integer trait's species value is a whole number", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(registries.behaviors.register({ id: "core:wander", version: "1.0.0" }));
    expectOk(
      registries.traits.register({
        id: "core:nocturnal",
        version: "1.0.0",
        default: 0,
        min: 0,
        max: 1,
        integer: true,
      }),
    );
    expectOk(registries.species.register({ ...species, traits: { "core:nocturnal": 0.5 } }));
    expect(resolveReferences(registries).diagnostics.map(formatDiagnostic)).toEqual([
      'error: species/test:pebble traits.core:nocturnal: "core:nocturnal" is 0.5, expected a whole number (invalid_value)',
    ]);
  });
});

describe("resolveReferences", () => {
  it("resolves references and orders dependencies first", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(
      registries.behaviors.register({
        id: "core:wander",
        version: "1.0.0",
        dependencies: [
          { registry: "actions", id: "core:idle" },
          { registry: "actions", id: "core:follow_path", version: "^1.0.0" },
        ],
      }),
    );
    expectOk(registries.species.register(species));

    const resolution = resolveReferences(registries);
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.ok).toBe(true);
    const order = resolution.loadOrder.map((k) => `${k.registry}/${k.id}`);
    expect(order).toHaveLength(6);
    const before = (a: string, b: string) =>
      expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    before("actions/core:idle", "behaviors/core:wander");
    before("actions/core:follow_path", "behaviors/core:wander");
    before("behaviors/core:wander", "species/test:pebble");
    before("capabilities/core:walk", "species/test:pebble");
    before(`assets/${sprite.id}`, "species/test:pebble");
  });

  it("validates assets and checks that a prop type refers to a model", () => {
    const registries = createRegistries();
    const bad = registries.assets.register({ ...sprite, kind: "sound", url: "", scale: 0 });
    expect(bad.ok ? [] : bad.diagnostics.map((d) => d.path.join("."))).toEqual([
      "kind",
      "url",
      "scale",
    ]);

    expectOk(registries.assets.register(sprite));
    const prop = (id: string, model: string) => ({
      schemaVersion: 1,
      id,
      version: "1.0.0",
      name: id,
      model,
      blockRadius: 0,
    });
    expectOk(registries.props.register(prop("test:flat-thing", sprite.id)));
    expectOk(registries.props.register(prop("test:lost-thing", "test:models/gone.glb")));
    expect(resolveReferences(registries).diagnostics.map(formatDiagnostic)).toEqual([
      'error: props/test:flat-thing model: "test:sprites/pebble.png" is an asset of kind image, expected model (invalid_value)',
      'error: props/test:lost-thing model: "test:models/gone.glb" is not registered in assets (unresolved_reference)',
    ]);
  });

  it("checks that every prop placement names a registered prop type", () => {
    const registries = createRegistries();
    const at = { position: { x: 0, y: 0, z: 0 } };
    expectOk(
      registries.worlds.register({
        ...world,
        props: [
          { id: "a", prop: "test:pine", transform: at },
          { id: "b", prop: "test:gone", transform: at },
        ],
      }),
    );
    expectOk(registries.assets.register({ ...sprite, id: "test:pine.glb", kind: "model" }));
    expectOk(
      registries.props.register({
        schemaVersion: 1,
        id: "test:pine",
        version: "1.0.0",
        name: "Pine",
        model: "test:pine.glb",
        blockRadius: 0.3,
      }),
    );
    expect(
      resolveReferences(registries)
        .diagnostics.filter((d) => d.path[0] === "props")
        .map(formatDiagnostic),
    ).toEqual([
      'error: worlds/test:flat props[1].prop: "test:gone" is not registered in props (unresolved_reference)',
    ]);
  });

  it("checks affordance params of structures and prop types against the affordance's schema", () => {
    const registries = createRegistries();
    expectOk(
      registries.affordances.register({
        id: "core:food",
        version: "1.0.0",
        paramsSchema: FoodAffordanceParamsSchema,
      }),
    );
    expectOk(registries.assets.register({ ...sprite, id: "test:bush.glb", kind: "model" }));
    expectOk(
      registries.props.register({
        schemaVersion: 1,
        id: "test:bush",
        version: "1.0.0",
        name: "Bush",
        model: "test:bush.glb",
        blockRadius: 0.4,
        affordances: { "core:food": { eatSeconds: 0 } },
      }),
    );
    expectOk(
      registries.structures.register({
        schemaVersion: 2,
        id: "test:pantry",
        version: "1.0.0",
        name: "Pantry",
        affordances: { "core:food": {} },
      }),
    );
    expect(resolveReferences(registries).diagnostics.map(formatDiagnostic)).toEqual([
      "error: structures/test:pantry affordances.core:food.eatSeconds: Invalid input: expected number, received undefined (invalid_type)",
      "error: props/test:bush affordances.core:food.eatSeconds: Too small: expected number to be >0 (too_small)",
    ]);
  });

  it("reports unregistered capabilities and affordances", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(registries.behaviors.register({ id: "core:wander", version: "1.0.0" }));
    expectOk(registries.species.register({ ...species, capabilities: { "core:wlak": 1 } }));
    expectOk(
      registries.structures.register({
        schemaVersion: 2,
        id: "test:bridge",
        version: "1.0.0",
        name: "Bridge",
        affordances: { "core:crossable": {} },
      }),
    );
    expect(resolveReferences(registries).diagnostics.map(formatDiagnostic)).toEqual([
      'error: structures/test:bridge affordances.core:crossable: "core:crossable" is not registered in affordances (unresolved_reference)',
      'error: species/test:pebble capabilities.core:wlak: "core:wlak" is not registered in capabilities (unresolved_reference)',
    ]);
  });

  it("checks a species' senses and traits against the registered ranges", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(registries.behaviors.register({ id: "core:wander", version: "1.0.0" }));
    expectOk(
      registries.senses.register({
        id: "core:vision",
        version: "1.0.0",
        default: 8,
        min: 1,
        max: 30,
      }),
    );
    expectOk(
      registries.traits.register({
        id: "core:appetite",
        version: "1.0.0",
        default: 1,
        min: 0.5,
        max: 2,
      }),
    );
    expectOk(
      registries.species.register({
        ...species,
        senses: { "core:vision": 8 },
        traits: { "core:appetite": 2 },
      }),
    );
    expect(resolveReferences(registries).diagnostics).toEqual([]);

    const bad = createRegistries();
    withActions(bad);
    expectOk(bad.behaviors.register({ id: "core:wander", version: "1.0.0" }));
    expectOk(bad.senses.register(registries.senses.get("core:vision")));
    expectOk(bad.traits.register(registries.traits.get("core:appetite")));
    expectOk(
      bad.species.register({
        ...species,
        senses: { "core:vision": 40, "core:smell": 3 },
        traits: { "core:appetite": 0.1, "core:shy": 1 },
      }),
    );
    expect(resolveReferences(bad).diagnostics.map(formatDiagnostic)).toEqual([
      'error: species/test:pebble senses.core:vision: "core:vision" is 40, outside its range [1, 30] (invalid_value)',
      'error: species/test:pebble senses.core:smell: "core:smell" is not registered in senses (unresolved_reference)',
      'error: species/test:pebble traits.core:appetite: "core:appetite" is 0.1, outside its range [0.5, 2] (invalid_value)',
      'error: species/test:pebble traits.core:shy: "core:shy" is not registered in traits (unresolved_reference)',
    ]);
  });

  it("validates locomotion rules on capabilities", () => {
    const result = createRegistries().capabilities.register({
      id: "core:hover",
      version: "1.0.0",
      locomotion: { regionKinds: ["lava"], maxSlopeDeg: 120 },
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => d.path.join("."))).toEqual([
      "locomotion.regionKinds.0",
      "locomotion.maxSlopeDeg",
    ]);
  });

  it("accepts a locomotion rule's animation and submersion", () => {
    const registries = createRegistries();
    expectOk(
      registries.capabilities.register({
        id: "core:swim",
        version: "1.0.0",
        locomotion: { regionKinds: ["water"], animation: "swim", submersion: 0.5 },
      }),
    );
    expectOk(
      registries.capabilities.register({
        id: "core:land",
        version: "1.0.0",
        locomotion: { regionKinds: ["land"], animation: { fromStyle: "land" }, submersion: 0 },
      }),
    );
    expectOk(
      registries.capabilities.register({
        id: "core:wade",
        version: "1.0.0",
        locomotion: { regionKinds: ["water"], submersion: 1 },
      }),
    );
  });

  it.each([
    ["a submersion below 0", { submersion: -0.1 }, "locomotion.submersion"],
    ["a submersion above 1", { submersion: 1.5 }, "locomotion.submersion"],
    ["a submersion that isn't a number", { submersion: "deep" }, "locomotion.submersion"],
    ["an empty profile name", { animation: "" }, "locomotion.animation"],
    ["a blank profile name", { animation: "  " }, "locomotion.animation"],
    [
      "a style with extra keys",
      { animation: { fromStyle: "land", profile: "walk" } },
      "locomotion.animation",
    ],
    ["a style of an unknown medium", { animation: { fromStyle: "air" } }, "locomotion.animation"],
    ["an animation that is a number", { animation: 3 }, "locomotion.animation"],
  ])("rejects %s", (_, rule, path) => {
    const result = createRegistries().capabilities.register({
      id: "core:swim",
      version: "1.0.0",
      locomotion: { regionKinds: ["water"], ...rule },
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => d.path.join("."))).toEqual([path]);
  });

  it("takes the animation profile from the rule, or from the species' style there", () => {
    const body = defaultBody();
    const swim = { regionKinds: ["water"], animation: "swim" } as const;
    const land = { regionKinds: ["land"], animation: { fromStyle: "land" } } as const;
    expect(animationProfile(swim, body)).toBe("swim");
    expect(animationProfile(land, body)).toBe("walk");
    expect(animationProfile(land, { ...body, locomotion: { land: { gait: "hop" } } })).toBe("hop");
    expect(animationProfile({ regionKinds: ["land"] }, body)).toBeUndefined();
  });

  it("requires a species to have a way of moving", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(registries.behaviors.register({ id: "core:wander", version: "1.0.0" }));
    expectOk(registries.capabilities.register({ id: "test:sing", version: "1.0.0" }));
    expectOk(registries.species.register({ ...species, capabilities: { "test:sing": 1 } }));
    expect(resolveReferences(registries).diagnostics.map(formatDiagnostic)).toEqual([
      "error: species/test:pebble capabilities: A species needs at least one way of moving: a capability with a locomotion rule (no_locomotion)",
    ]);

    const moving = createRegistries();
    withActions(moving);
    expectOk(moving.behaviors.register({ id: "core:wander", version: "1.0.0" }));
    expectOk(moving.capabilities.register({ id: "test:sing", version: "1.0.0" }));
    expectOk(
      moving.species.register({ ...species, capabilities: { "test:sing": 1, "core:walk": 1 } }),
    );
    expect(resolveReferences(moving).diagnostics).toEqual([]);
  });

  it("reports an unregistered capability only as unresolved, not as no way of moving", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(registries.behaviors.register({ id: "core:wander", version: "1.0.0" }));
    expectOk(registries.species.register({ ...species, capabilities: { "test:fly": 1 } }));
    expect(resolveReferences(registries).diagnostics.map((d) => d.code)).toEqual([
      "unresolved_reference",
    ]);
  });

  it("reports unresolved references and unsatisfied version ranges", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(
      registries.behaviors.register({
        id: "test:nap",
        version: "1.0.0",
        dependencies: [{ registry: "actions", id: "core:follow_path", version: "^2.0.0" }],
      }),
    );
    expectOk(registries.species.register({ ...species, behaviors: ["test:nap", "core:wander"] }));

    const resolution = resolveReferences(registries);
    expect(resolution.ok).toBe(false);
    expect(resolution.diagnostics.map(formatDiagnostic)).toEqual([
      'error: species/test:pebble behaviors[1]: "core:wander" is not registered in behaviors (unresolved_reference)',
      'error: behaviors/test:nap dependencies[0]: "core:follow_path" is version 1.2.0, which does not satisfy ^2.0.0 (version_mismatch)',
    ]);
  });

  it("reports dependency cycles", () => {
    const registries = createRegistries();
    expectOk(
      registries.behaviors.register({
        id: "test:a",
        version: "1.0.0",
        dependencies: [{ registry: "behaviors", id: "test:b" }],
      }),
    );
    expectOk(
      registries.behaviors.register({
        id: "test:b",
        version: "1.0.0",
        dependencies: [{ registry: "behaviors", id: "test:a" }],
      }),
    );
    const resolution = resolveReferences(registries);
    expect(resolution.diagnostics.map(formatDiagnostic)).toEqual([
      "error: behaviors/test:a: Dependency cycle: behaviors/test:a → behaviors/test:b → behaviors/test:a (dependency_cycle)",
    ]);
    expect(resolution.loadOrder).toEqual([]);
  });
});

describe("addEntries", () => {
  /** Resolved registries with what `species` refers to, except its appearance. */
  function resolved() {
    const registries = createRegistries();
    expectOk(
      registries.capabilities.register({
        id: "core:walk",
        version: "1.0.0",
        locomotion: { regionKinds: ["land"] },
      }),
    );
    expectOk(registries.behaviors.register({ id: "core:wander", version: "1.0.0" }));
    expect(resolveReferences(registries).diagnostics).toEqual([]);
    return registries;
  }

  it("adds entries that refer to each other and to registered ones", () => {
    const registries = resolved();
    const result = addEntries(registries, [
      { registry: "species", input: species },
      { registry: "assets", input: sprite },
    ]);
    expectOk(result);
    expect(result.ok && result.value).toEqual([
      { registry: "species", id: "test:pebble" },
      { registry: "assets", id: sprite.id },
    ]);
    expect(registries.species.has("test:pebble")).toBe(true);
    expect(registries.assets.has(sprite.id)).toBe(true);
    expect(resolveReferences(registries).diagnostics).toEqual([]);
  });

  it("registers nothing if any entry is invalid or unresolved", () => {
    const registries = resolved();
    const result = addEntries(registries, [
      { registry: "species", input: { ...species, behaviors: ["core:wander", "test:sleep"] } },
      { registry: "assets", input: sprite },
    ]);
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      'error: species/test:pebble behaviors[1]: "test:sleep" is not registered in behaviors (unresolved_reference)',
    ]);
    expect(registries.species.size).toBe(0);
    expect(registries.assets.size).toBe(0);

    const invalid = addEntries(registries, [
      { registry: "species", input: species },
      { registry: "assets", input: { ...sprite, kind: "sound" } },
    ]);
    expect(invalid.ok).toBe(false);
    expect(registries.species.size).toBe(0);
  });

  it("checks that a species added has a way of moving, against entries added with it", () => {
    const registries = resolved();
    expectOk(registries.capabilities.register({ id: "test:sing", version: "1.0.0" }));
    const still = { ...species, capabilities: { "test:sing": 1 } };
    const result = addEntries(registries, [
      { registry: "species", input: still },
      { registry: "assets", input: sprite },
    ]);
    expect(result.ok ? [] : result.diagnostics.map((d) => d.code)).toEqual(["no_locomotion"]);
    expect(registries.species.size).toBe(0);
  });

  it("finds a species' way of moving among the entries added with it", () => {
    const registries = resolved();
    const swim = { id: "test:swim", version: "1.0.0", locomotion: { regionKinds: ["water"] } };
    const result = addEntries(registries, [
      { registry: "species", input: { ...species, capabilities: { "test:swim": 1 } } },
      { registry: "capabilities", input: swim },
      { registry: "assets", input: sprite },
    ]);
    expectOk(result);
    expect(registries.species.has("test:pebble")).toBe(true);
    expect(registries.capabilities.has("test:swim")).toBe(true);
  });

  it("rejects IDs that are registered or added twice", () => {
    const registries = resolved();
    expectOk(registries.assets.register(sprite));
    const result = addEntries(registries, [
      { registry: "species", input: species },
      { registry: "species", input: species },
      { registry: "assets", input: sprite },
    ]);
    expect(result.ok ? [] : result.diagnostics.map((d) => d.code)).toEqual([
      "duplicate_id",
      "duplicate_id",
    ]);
    expect(registries.species.size).toBe(0);
  });
});
