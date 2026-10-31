import { describe, expect, it } from "vitest";
import { libraryAppearance, parseLibraryEntry, type Result } from "./index";
import { migrate } from "./migrate";

const codes = (result: Result<unknown>) => (result.ok ? [] : result.diagnostics.map((d) => d.code));
const messages = (result: Result<unknown>) =>
  result.ok ? [] : result.diagnostics.map((d) => d.message);
const paths = (result: Result<unknown>) =>
  result.ok ? [] : result.diagnostics.map((d) => d.path.join("."));

const ID = "user:3f9c2a1e-0000-4000-8000-000000000000";

/** A 10 × 15 × 5 cm block of 2.5 cm cubes: tiny. */
const assembly = () => ({
  parts: {
    body: {
      type: "test:torso",
      size: { x: 4, y: 6, z: 2 },
      step: 0.025,
      colors: ["#7fae5a"],
      voxels: [48, 1],
      attach: { x: 2, y: 0, z: 1 },
    },
  },
  instances: [{ id: "body", part: "body" }],
});

function validEntry() {
  return {
    schemaVersion: 7,
    species: {
      schemaVersion: 2,
      id: ID,
      version: "1.0.0",
      name: "Blob",
      appearance: `${ID}/assembly.json`,
      sizeClass: "tiny",
      body: { locomotion: { land: { gait: "hop" } } } as Record<string, unknown>,
      capabilities: { "core:land": 1 },
      baseSpeed: 0.6,
      behaviors: ["core:wander", "core:feed", "core:rest"],
      senses: { "core:vision": 8 },
      traits: {},
    },
    assembly: assembly(),
    createdAt: "2026-10-27T12:00:00.000Z",
  };
}

describe("parseLibraryEntry", () => {
  it("accepts a species with its assembly inline", () => {
    const result = parseLibraryEntry(validEntry());
    expect(messages(result)).toEqual([]);
    if (!result.ok) throw new Error("not parsed");
    expect(result.value.assembly.instances[0]?.rotation).toEqual([0, 0, 0, 1]);
    expect(result.value.species.body.locomotion.land.gait).toBe("hop");
  });

  it("parses to an entry which parses again unchanged", () => {
    const first = parseLibraryEntry(validEntry());
    if (!first.ok) throw new Error(messages(first).join("\n"));
    expect(first.value.species.body).toEqual({ locomotion: { land: { gait: "hop" } } });
    const again = parseLibraryEntry(JSON.parse(JSON.stringify(first.value)));
    expect(messages(again)).toEqual([]);
    expect(again.ok && again.value).toEqual(first.value);
  });

  it("checks the species like pack content", () => {
    const entry = validEntry();
    entry.species.behaviors = [];
    const result = parseLibraryEntry(entry, "library/blob");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics[0]?.source).toBe("library/blob");
  });

  it("rejects a bad created time", () => {
    expect(parseLibraryEntry({ ...validEntry(), createdAt: "yesterday" }).ok).toBe(false);
  });

  it.each([[null], [[]], ["entry"], [{ species: {} }]])("rejects %j", (input) => {
    expect(parseLibraryEntry(input).ok).toBe(false);
  });

  it("reads a species without a body plan with the walk gait alone", () => {
    const entry = validEntry();
    const species: Record<string, unknown> = { ...entry.species };
    delete species.body;
    const result = parseLibraryEntry({ ...entry, species });
    expect(result.ok && result.value.species.body).toEqual({
      locomotion: { land: { gait: "walk" } },
    });
  });

  it.each([[1], [2], [3], [4], [5]])("doesn't migrate a version %i entry", (schemaVersion) => {
    expect(codes(parseLibraryEntry({ ...validEntry(), schemaVersion }))).toEqual([
      "missing_migration",
    ]);
  });

  it("migrates a version 6 entry's species to schema version 2", () => {
    const entry = validEntry();
    entry.species.schemaVersion = 1;
    const result = parseLibraryEntry({ ...entry, schemaVersion: 6 });
    expect(messages(result)).toEqual([]);
    expect(result.ok && result.value.species.schemaVersion).toBe(2);
  });

  it("refuses a drawn body", () => {
    // Drawn bodies went at M23: an entry of version 5 that held one fails to load.
    const entry: Record<string, unknown> = validEntry();
    delete entry.assembly;
    expect(parseLibraryEntry({ ...entry, body: { kind: "drawn" } }).ok).toBe(false);
  });

  it("names the assembly as its appearance", () => {
    expect(libraryAppearance("user:abc")).toBe("user:abc/assembly.json");
    const entry = validEntry();
    entry.species.appearance = `${ID}/appearance.png`;
    expect(messages(parseLibraryEntry(entry))).toEqual([
      `A library species' appearance is "${ID}/assembly.json"`,
    ]);
  });

  it("checks the stored size class against the one the cubes give", () => {
    const entry = validEntry();
    entry.species.sizeClass = "small";
    expect(messages(parseLibraryEntry(entry))).toEqual([
      "The body's size class is tiny, not small",
    ]);
    const huge = validEntry();
    huge.assembly.parts.body.step = 0.1;
    huge.assembly.parts.body.size.y = 20;
    huge.assembly.parts.body.voxels = [160, 1];
    expect(messages(parseLibraryEntry(huge))).toEqual([
      "The body is too large for every size class",
    ]);
  });

  it("checks the assembly's structure on load", () => {
    const entry = validEntry();
    entry.assembly.parts.body.voxels = [47, 1];
    expect(paths(parseLibraryEntry(entry))).toEqual(["assembly.parts.body.voxels"]);
  });
});

describe("migrate", () => {
  const migrations = {
    1: (data: Record<string, unknown>) => ({ ...data, legs: 2 }),
    2: ({ legs, ...data }: Record<string, unknown>) => ({ ...data, limbs: { legs } }),
  };

  it("runs every step from the file's version to the current one", () => {
    expect(migrate("thing", { schemaVersion: 1, name: "a" }, 3, migrations)).toEqual({
      ok: true,
      value: { schemaVersion: 3, name: "a", limbs: { legs: 2 } },
    });
    expect(migrate("thing", { schemaVersion: 2, legs: 4 }, 3, migrations)).toEqual({
      ok: true,
      value: { schemaVersion: 3, limbs: { legs: 4 } },
    });
  });

  it("leaves the current version alone", () => {
    const input = { schemaVersion: 3 };
    expect(migrate("thing", input, 3, migrations)).toEqual({ ok: true, value: input });
  });

  it("reports a missing step", () => {
    expect(codes(migrate("thing", { schemaVersion: 1 }, 3, { 2: migrations[2] }))).toEqual([
      "missing_migration",
    ]);
  });

  it.each([[{}], [{ schemaVersion: "1" }], [{ schemaVersion: 0 }], [{ schemaVersion: 4 }]])(
    "rejects schema version of %j",
    (input) => {
      expect(codes(migrate("thing", input, 3, migrations))).toEqual(["unsupported_schema_version"]);
    },
  );
});
