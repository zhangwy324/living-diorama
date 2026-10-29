import { describe, expect, it } from "vitest";
import {
  EDIT_OP_KINDS,
  parseWorldEdit,
  type AppliedPropAddOp,
  type AppliedWorldEdit,
  type Result,
  type WorldEditInput,
} from "./index";

function codesAndPaths<T>(result: Result<T>) {
  return result.ok ? [] : result.diagnostics.map((d) => ({ code: d.code, path: d.path }));
}

function messages<T>(result: Result<T>): string[] {
  return result.ok ? [] : result.diagnostics.map((d) => d.message);
}

describe("WorldEdit", () => {
  it("accepts one op of every kind and fills in an add's defaults", () => {
    const edit: WorldEditInput = {
      ops: [
        { op: "prop.add", prop: "hollow:pine", position: { x: 1, z: -2 } },
        { op: "prop.remove", id: "rock-1" },
        { op: "prop.move", id: "pine-2", position: { x: 0, z: 0 } },
        { op: "prop.move", id: "pine-3", rotationY: Math.PI / 2 },
        { op: "prop.scale", id: "bush-1", scale: 2.5 },
      ],
    };
    const parsed = parseWorldEdit(edit);
    expect(parsed).toEqual({
      ok: true,
      value: {
        ops: [
          {
            op: "prop.add",
            prop: "hollow:pine",
            position: { x: 1, z: -2 },
            rotationY: 0,
            scale: 1,
          },
          ...edit.ops.slice(1),
        ],
      },
    });
  });

  it("keeps an add's own placement ID, rotation and scale", () => {
    const op = {
      op: "prop.add",
      prop: "hollow:mushroom",
      position: { x: 0, z: 3 },
      rotationY: 1,
      scale: 0.5,
      id: "mushroom-9",
    } as const;
    expect(parseWorldEdit({ ops: [op] })).toEqual({ ok: true, value: { ops: [op] } });
  });

  it("names every op kind", () => {
    expect(EDIT_OP_KINDS).toEqual(["prop.add", "prop.remove", "prop.move", "prop.scale"]);
  });

  it("has no upper bound on scale", () => {
    expect(parseWorldEdit({ ops: [{ op: "prop.scale", id: "pine-1", scale: 1e6 }] }).ok).toBe(true);
  });

  it.each([0, -1])("rejects a scale of %d", (scale) => {
    const add = parseWorldEdit({
      ops: [{ op: "prop.add", prop: "hollow:pine", position: { x: 0, z: 0 }, scale }],
    });
    const set = parseWorldEdit({ ops: [{ op: "prop.scale", id: "pine-1", scale }] });
    expect(codesAndPaths(add)).toEqual([{ code: "too_small", path: ["ops", 0, "scale"] }]);
    expect(messages(set)).toEqual(["A prop's scale must be greater than 0"]);
  });

  it("rejects an edit without ops", () => {
    expect(messages(parseWorldEdit({ ops: [] }))).toEqual(["An edit needs at least one op"]);
    expect(codesAndPaths(parseWorldEdit({}))).toEqual([{ code: "invalid_type", path: ["ops"] }]);
  });

  it("rejects an unknown op, naming the known ones", () => {
    const parsed = parseWorldEdit({ ops: [{ op: "terrain.raise", id: "pine-1" }] });
    expect(codesAndPaths(parsed)).toEqual([{ code: "invalid_union", path: ["ops", 0, "op"] }]);
    expect(messages(parsed)).toEqual([
      "Unknown edit op (expected one of prop.add, prop.remove, prop.move, prop.scale)",
    ]);
  });

  it("rejects an op without an op kind, saying so", () => {
    const parsed = parseWorldEdit({ ops: [{ id: "pine-1" }] });
    expect(codesAndPaths(parsed)).toEqual([{ code: "invalid_union", path: ["ops", 0, "op"] }]);
    expect(messages(parsed)).toEqual([
      'An edit op needs an "op" (one of prop.add, prop.remove, prop.move, prop.scale)',
    ]);
  });

  it("types an applied edit's adds with their IDs", () => {
    const unnamed = {
      op: "prop.add",
      prop: "hollow:pine",
      position: { x: 0, z: 0 },
      rotationY: 0,
      scale: 1,
    } as const;
    const named: AppliedPropAddOp = { ...unnamed, id: "pine-7" };
    // @ts-expect-error: an applied add must name its placement.
    const missing: AppliedWorldEdit = { ops: [unnamed] };
    expect({ ops: [named] } satisfies AppliedWorldEdit).not.toEqual(missing);
  });

  it("rejects a move that changes nothing", () => {
    const parsed = parseWorldEdit({ ops: [{ op: "prop.move", id: "pine-1" }] });
    expect(messages(parsed)).toEqual(["A move needs a position, a rotation or both"]);
  });

  it("rejects a height: the engine puts props on the ground", () => {
    const parsed = parseWorldEdit({
      ops: [{ op: "prop.move", id: "pine-1", position: { x: 0, y: 2, z: 0 } }],
    });
    expect(codesAndPaths(parsed)).toEqual([
      { code: "unrecognized_keys", path: ["ops", 0, "position"] },
    ]);
  });

  it("rejects malformed IDs and non-finite numbers, pointing into the op", () => {
    const parsed = parseWorldEdit({
      ops: [
        { op: "prop.add", prop: "pine", position: { x: Infinity, z: 0 }, id: "Pine 1" },
        { op: "prop.remove", id: "core:pine" },
        { op: "prop.move", id: "pine-1", rotationY: Number.NaN },
      ],
    });
    expect(codesAndPaths(parsed)).toEqual([
      { code: "invalid_format", path: ["ops", 0, "prop"] },
      { code: "invalid_type", path: ["ops", 0, "position", "x"] },
      { code: "invalid_format", path: ["ops", 0, "id"] },
      { code: "invalid_format", path: ["ops", 1, "id"] },
      { code: "invalid_type", path: ["ops", 2, "rotationY"] },
    ]);
  });
});
