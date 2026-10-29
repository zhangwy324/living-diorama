import { describe, expect, it } from "vitest";
import { parseDrawing, parseLibraryEntry, type Result } from "./index";
import { migrate } from "./migrate";

const codes = (result: Result<unknown>) => (result.ok ? [] : result.diagnostics.map((d) => d.code));

function validDrawing() {
  return {
    schemaVersion: 2,
    canvas: { width: 512, height: 512 },
    history: [
      {
        kind: "stroke",
        tool: "pen",
        color: "#3a7d5c",
        width: 12,
        points: [10, 20, 0.5, 30, 40, 1],
      },
      { kind: "stroke", tool: "eraser", color: "#000000", width: 20, points: [15, 25, 0] },
    ],
  };
}

function validEntry() {
  return {
    schemaVersion: 3,
    species: {
      schemaVersion: 1,
      id: "user:3f9c2a1e-0000-4000-8000-000000000000",
      version: "1.0.0",
      name: "Blob",
      appearance: "user:3f9c2a1e-0000-4000-8000-000000000000/appearance.png",
      sizeClass: "small",
      body: {
        thickness: 0.3,
        template: "walker",
        locomotion: { land: { gait: "walk" } },
        anchors: { centerOfGravity: { x: 128, y: 140 } },
      },
      capabilities: { "core:land": 1 },
      baseSpeed: 0.6,
      behaviors: ["core:wander", "core:feed", "core:rest"],
      senses: { "core:vision": 8 },
      traits: {},
    },
    createdAt: "2026-10-27T12:00:00.000Z",
  };
}

describe("parseDrawing", () => {
  it("accepts a valid drawing", () => {
    expect(parseDrawing(validDrawing())).toEqual({ ok: true, value: validDrawing() });
  });

  it("accepts a drawing with nothing in its history", () => {
    expect(parseDrawing({ ...validDrawing(), history: [] }).ok).toBe(true);
  });

  it.each([
    ["points not in threes", [1, 2]],
    ["pressure above 1", [1, 2, 1.5]],
    ["negative pressure", [1, 2, -0.1]],
  ])("rejects %s", (_, points) => {
    const drawing = validDrawing();
    drawing.history[0]!.points = points;
    expect(parseDrawing(drawing).ok).toBe(false);
  });

  it("rejects a bad colour and an unknown tool", () => {
    const drawing = validDrawing();
    drawing.history[0]!.color = "green";
    drawing.history[1]!.tool = "spray";
    expect(parseDrawing(drawing).ok).toBe(false);
  });

  it("accepts a fill between strokes", () => {
    const { history, ...drawing } = validDrawing();
    const fill = { kind: "fill", x: 0, y: 511, color: "#3c7fc2" };
    expect(parseDrawing({ ...drawing, history: [history[0], fill, history[1]] }).ok).toBe(true);
  });

  it.each([
    ["between pixels", { x: 1.5, y: 2 }],
    ["off the top", { x: 1, y: -1 }],
    ["with no colour", { color: undefined }],
    ["with a brush width", { width: 10 }],
  ])("rejects a fill %s", (_, change) => {
    const fill = { kind: "fill", x: 1, y: 2, color: "#3c7fc2", ...change };
    expect(parseDrawing({ ...validDrawing(), history: [fill] }).ok).toBe(false);
  });

  it("rejects an operation of an unknown kind or with none", () => {
    const [stroke] = validDrawing().history;
    expect(parseDrawing({ ...validDrawing(), history: [{ ...stroke, kind: "spray" }] }).ok).toBe(
      false,
    );
    const kindless: Record<string, unknown> = { ...stroke };
    delete kindless.kind;
    expect(parseDrawing({ ...validDrawing(), history: [kindless] }).ok).toBe(false);
  });

  it("rejects the strokes of version 1 under version 2", () => {
    const { history, ...drawing } = validDrawing();
    expect(parseDrawing({ ...drawing, strokes: history }).ok).toBe(false);
  });

  it("reads a version 1 drawing, its strokes as the record in the same order", () => {
    const { history } = validDrawing();
    const strokes = history.map((stroke) => {
      const old: Record<string, unknown> = { ...stroke };
      delete old.kind;
      return old;
    });
    const result = parseDrawing({ schemaVersion: 1, canvas: { width: 512, height: 512 }, strokes });
    expect(result).toEqual({ ok: true, value: validDrawing() });
  });

  it("rejects a version 1 drawing with bad strokes", () => {
    const drawing = { schemaVersion: 1, canvas: { width: 256, height: 256 } };
    expect(parseDrawing({ ...drawing, strokes: [{ tool: "pen" }] }).ok).toBe(false);
    expect(parseDrawing({ ...drawing, strokes: [7] }).ok).toBe(false);
    expect(parseDrawing({ ...drawing, strokes: "none" }).ok).toBe(false);
  });

  it("rejects a newer version with one clear diagnostic", () => {
    const result = parseDrawing({ ...validDrawing(), schemaVersion: 3 });
    expect(codes(result)).toEqual(["unsupported_schema_version"]);
  });
});

describe("parseLibraryEntry", () => {
  it("accepts a valid entry", () => {
    expect(parseLibraryEntry(validEntry())).toEqual({ ok: true, value: validEntry() });
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

  it("reads a species without a body plan as a walker", () => {
    const entry = validEntry();
    const species: Record<string, unknown> = { ...entry.species };
    delete species.body;
    const result = parseLibraryEntry({ ...entry, species });
    expect(result.ok && result.value.species.body).toEqual({
      thickness: 0.4,
      template: "walker",
      locomotion: { land: { gait: "walk" } },
      anchors: {},
    });
  });

  it.each([[1], [2]])("doesn't migrate a version %i entry", (schemaVersion) => {
    expect(codes(parseLibraryEntry({ ...validEntry(), schemaVersion }))).toEqual([
      "missing_migration",
    ]);
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
