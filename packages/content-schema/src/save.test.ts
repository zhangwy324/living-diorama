import { describe, expect, it } from "vitest";
import { formatDiagnostic, parseWorldSave, WORLD_SAVE_SCHEMA_VERSION, type Result } from "./index";

function messages<T>(result: Result<T>): string[] {
  return result.ok ? [] : result.diagnostics.map(formatDiagnostic);
}

function codesAndPaths<T>(result: Result<T>) {
  return result.ok ? [] : result.diagnostics.map((d) => ({ code: d.code, path: d.path }));
}

/**
 * A real RNG state: `Rng.fromSeed(123).state` in the simulation. Its words are signed 32-bit
 * integers, some negative, and its key is unsigned and above 2^31.
 */
const rng = { words: [1127421319, -934664643, 1264157164, 327006313], key: 2235285516 };

/** A creature with every optional field set. */
function busyCreature() {
  return {
    id: "creature-1",
    speciesId: "core:mossling",
    speciesVersion: "1.2.0",
    position: { regionId: "north-bank", x: 1.5, z: -2 },
    heading: -Math.PI,
    rng,
    action: {
      id: "core:follow_path",
      behavior: "core:feed",
      state: { path: { points: [{ x: 1, z: 2 }], next: 0 } },
      startTick: 90,
    },
    lastResult: { action: "core:idle", outcome: "interrupted", reason: "outranked" },
    decideAtTick: 120,
    memory: { "core:wander": { lastRegion: "north-bank" }, "core:feed": {} },
    usedStructures: ["bridge"],
    progress: { x: 1.5, z: -2, stalledTicks: 3 },
    needs: { "core:hunger": 0.4, "core:tiredness": 1 },
    knowledge: {
      places: {
        "core:food": [
          { placementId: "mushroom-1", lastSeenTick: 80 },
          {
            placementId: "bush-2",
            lastSeenTick: 70,
            failures: { noRoute: 0, stuck: 2, retryTick: 250, cell: { x: -1, z: 0 } },
          },
        ],
      },
      recentCells: [{ x: -1, z: 0, tick: 100 }],
    },
    home: "log-1",
    variation: { needs: { "core:hunger": 0.9 }, senses: { "core:vision": 1.1 } },
    spotAngle: 2.5,
    day: { phase: "dusk", morning: -12.5, evening: 29.9 },
    asleep: false,
    phaseReactionTick: 130,
    releasedAtTick: 10,
  };
}

/** A freshly spawned wanderer: no optional fields, no needs, no home. */
function idleCreature() {
  return {
    id: "creature-2",
    speciesId: "user:0b7e1c2a-5f3d-4c6e-9a8b-1d2e3f4a5b6c",
    speciesVersion: "1.0.0",
    position: { regionId: "south-bank", x: 0, z: 0 },
    heading: 0,
    rng: { words: [0, 0, 0, 0], key: 0 },
    decideAtTick: 0,
    memory: {},
    usedStructures: [],
    progress: { x: 0, z: 0, stalledTicks: 0 },
    needs: {},
    knowledge: { places: {}, recentCells: [] },
    home: null,
    variation: { needs: {}, senses: {} },
    spotAngle: 0,
    day: { phase: "night", morning: 0 },
    asleep: false,
  };
}

function validSave() {
  return {
    schemaVersion: WORLD_SAVE_SCHEMA_VERSION,
    savedAt: 1_793_000_000_000,
    world: { id: "core:meadow", version: "2.0.0" },
    seed: 123456,
    tick: 150,
    minutes: 21 * 60 + 30.5,
    dayPhase: "dusk",
    rng,
    nextCreature: 3,
    introducedSpecies: ["core:mossling"],
    species: {
      "core:mossling": "1.2.0",
      "user:0b7e1c2a-5f3d-4c6e-9a8b-1d2e3f4a5b6c": "1.0.0",
    },
    creatures: [busyCreature(), idleCreature()],
  };
}

describe("parseWorldSave", () => {
  it("accepts a valid save and keeps it as it was", () => {
    const save = validSave();
    expect(parseWorldSave(save)).toEqual({ ok: true, value: save });
  });

  it("keeps action state and behavior memory as they are", () => {
    const creature = busyCreature();
    const save = {
      ...validSave(),
      creatures: [
        {
          ...creature,
          action: { ...creature.action, state: { anything: [1, "two", null] } },
          memory: { "core:feed": { nested: { deep: true } } },
        },
      ],
    };
    expect(parseWorldSave(save)).toEqual({ ok: true, value: save });
  });

  it("accepts an empty world", () => {
    expect(
      parseWorldSave({ ...validSave(), introducedSpecies: [], species: {}, creatures: [] }).ok,
    ).toBe(true);
  });

  it("rejects another save version with one clear diagnostic", () => {
    expect(
      messages(
        parseWorldSave({ ...validSave(), schemaVersion: 1, unexpected: true }, "world.json"),
      ),
    ).toEqual([
      "error: world.json schemaVersion: World save version 1 is not supported (supported: 3) (unsupported_save_version)",
    ]);
  });

  it("rejects a save without a version", () => {
    const save: Record<string, unknown> = validSave();
    delete save.schemaVersion;
    expect(codesAndPaths(parseWorldSave(save))).toEqual([
      { code: "invalid_value", path: ["schemaVersion"] },
    ]);
  });

  it("rejects unknown fields at the top, in a creature and in its nested state", () => {
    const save = validSave();
    const creature = busyCreature();
    const result = parseWorldSave({
      ...save,
      extra: 1,
      world: { ...save.world, name: "Meadow" },
      creatures: [
        {
          ...creature,
          mood: "happy",
          rng: { ...rng, position: 4 },
          action: { ...creature.action, priority: 1 },
          knowledge: { ...creature.knowledge, maps: [] },
        },
      ],
    });
    expect(codesAndPaths(result)).toEqual(
      expect.arrayContaining([
        { code: "unrecognized_keys", path: [] },
        { code: "unrecognized_keys", path: ["world"] },
        { code: "unrecognized_keys", path: ["creatures", 0] },
        { code: "unrecognized_keys", path: ["creatures", 0, "rng"] },
        { code: "unrecognized_keys", path: ["creatures", 0, "action"] },
        { code: "unrecognized_keys", path: ["creatures", 0, "knowledge"] },
      ]),
    );
  });

  it("rejects bad top-level shapes", () => {
    const result = parseWorldSave({
      ...validSave(),
      savedAt: -1,
      seed: 1.5,
      tick: -1,
      minutes: 24 * 60,
      dayPhase: "evening",
      rng: { words: [1, 2, 3], key: 1 },
      nextCreature: 0,
      introducedSpecies: ["mossling"],
      species: { "core:mossling": "1" },
    });
    expect(codesAndPaths(result).map((d) => d.path)).toEqual([
      ["savedAt"],
      ["seed"],
      ["tick"],
      ["minutes"],
      ["dayPhase"],
      ["rng", "words"],
      ["nextCreature"],
      ["introducedSpecies", 0],
      ["species", "core:mossling"],
    ]);
  });

  it("rejects bad creature shapes", () => {
    const creature = busyCreature();
    const result = parseWorldSave({
      ...validSave(),
      creatures: [
        {
          ...creature,
          heading: Math.PI,
          rng: { words: [-(2 ** 31) - 1, -(2 ** 31), 2 ** 31 - 1, 2 ** 31], key: -1 },
          lastResult: { ...creature.lastResult, outcome: "crashed" },
          needs: { "core:hunger": 1.2 },
          home: undefined,
          variation: { ...creature.variation, needs: { "core:hunger": 0 } },
          knowledge: {
            places: {
              "core:food": [
                {
                  placementId: "bush-2",
                  lastSeenTick: 70,
                  failures: { noRoute: -1, stuck: 0, retryTick: 250, cell: { x: 0, z: 0 } },
                },
              ],
            },
            recentCells: [{ x: 0.5, z: 0, tick: 1 }],
          },
          day: { phase: "noon", morning: 60 },
          asleep: "no",
        },
      ],
    });
    const at = (...path: (string | number)[]) => ["creatures", 0, ...path];
    expect(codesAndPaths(result).map((d) => d.path)).toEqual([
      at("heading"),
      at("rng", "words", 0),
      at("rng", "words", 3),
      at("rng", "key"),
      at("lastResult", "outcome"),
      at("needs", "core:hunger"),
      at("knowledge", "places", "core:food", 0, "failures", "noRoute"),
      at("knowledge", "recentCells", 0, "x"),
      at("home"),
      at("variation", "needs", "core:hunger"),
      at("day", "phase"),
      at("day", "morning"),
      at("asleep"),
    ]);
  });

  it("rejects duplicate creature IDs and introduced species", () => {
    const save = validSave();
    const result = parseWorldSave({
      ...save,
      introducedSpecies: ["core:mossling", "core:mossling"],
      creatures: [busyCreature(), busyCreature()],
    });
    expect(messages(result)).toEqual([
      'error: introducedSpecies[1]: Duplicate species "core:mossling" (custom)',
      'error: creatures[1]: Duplicate creature ID "creature-1" (custom)',
    ]);
  });

  it("rejects input that is not an object", () => {
    expect(codesAndPaths(parseWorldSave(null))).toEqual([{ code: "invalid_type", path: [] }]);
    expect(codesAndPaths(parseWorldSave("{}"))).toEqual([{ code: "invalid_type", path: [] }]);
  });
});
