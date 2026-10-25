import { describe, expect, it } from "vitest";
import {
  CellState,
  distanceField,
  findCellPath,
  findGridPath,
  hasLineOfSight,
  pathLength,
  RegionMask,
  type RegionModel,
} from "../index";

/** A mask from rows of text: `.` walkable, `#` blocked. Row 0 is the smallest z; 1 m cells. */
function maskFrom(rows: string[]): RegionMask {
  const columns = rows[0]!.length;
  const states = Uint8Array.from(rows.join(""), (c) =>
    c === "." ? CellState.walkable : CellState.steep,
  );
  const heights = new Float64Array(states.length).fill(0);
  const region = { id: "test" } as RegionModel;
  return new RegionMask(region, 0, 0, columns, rows.length, 1, 0, 0, states, heights);
}

const at = (mask: RegionMask, i: number, j: number) => j * mask.columns + i;

describe("grid search", () => {
  const mask = maskFrom([
    ".....", //
    ".###.",
    ".#...",
    ".#.#.",
    ".....",
  ]);

  it("finds the shortest 8-connected path without cutting blocked corners", () => {
    const cells = findCellPath(mask, at(mask, 0, 0), at(mask, 2, 2))!;
    // Every diagonal step must have both side cells walkable.
    for (const cell of cells) expect(mask.state(cell)).toBe(CellState.walkable);
    for (let k = 1; k < cells.length; k++) {
      const [a, b] = [cells[k - 1]!, cells[k]!];
      const di = (b % 5) - (a % 5);
      const dj = Math.floor(b / 5) - Math.floor(a / 5);
      if (di !== 0 && dj !== 0) {
        expect(mask.state(at(mask, (a % 5) + di, Math.floor(a / 5)))).toBe(CellState.walkable);
        expect(mask.state(at(mask, a % 5, Math.floor(a / 5) + dj))).toBe(CellState.walkable);
      }
    }
    const field = distanceField(mask, at(mask, 0, 0));
    // Either way round is 8 m: no diagonal step is allowed past the wall's corners.
    expect(field[at(mask, 2, 2)]).toBeCloseTo(8);
    expect(field[at(mask, 1, 1)]).toBe(Infinity);
  });

  it("returns undefined for blocked or unreachable cells", () => {
    expect(findCellPath(mask, at(mask, 0, 0), at(mask, 1, 1))).toBeUndefined();
    const split = maskFrom(["..#..", "..#..", "..#.."]);
    expect(findCellPath(split, at(split, 0, 0), at(split, 4, 0))).toBeUndefined();
  });
});

describe("line of sight and smoothing", () => {
  it("rejects segments through blocked cells and blocked corners", () => {
    const mask = maskFrom([
      "...", //
      ".#.",
      "...",
    ]);
    expect(hasLineOfSight(mask, { x: 0.5, z: 0.5 }, { x: 2.5, z: 0.5 })).toBe(true);
    expect(hasLineOfSight(mask, { x: 0.5, z: 0.5 }, { x: 2.5, z: 2.5 })).toBe(false);
    const corner = maskFrom([
      ".#", //
      "#.",
    ]);
    // Exactly through the shared corner of two blocked cells.
    expect(hasLineOfSight(corner, { x: 0.5, z: 0.5 }, { x: 1.5, z: 1.5 })).toBe(false);
  });

  it("straightens a path in open space and keeps it on walkable cells", () => {
    const mask = maskFrom([
      "........", //
      "........",
      "...##...",
      "...##...",
      "........",
    ]);
    const open = findGridPath(mask, { x: 0.2, z: 0.3 }, { x: 7.6, z: 0.7 })!;
    expect(open).toEqual([
      { x: 0.2, z: 0.3 },
      { x: 7.6, z: 0.7 },
    ]);
    const around = findGridPath(mask, { x: 0.5, z: 2.5 }, { x: 7.5, z: 3.5 })!;
    expect(around.length).toBeGreaterThan(2);
    for (let k = 1; k < around.length; k++) {
      expect(hasLineOfSight(mask, around[k - 1]!, around[k]!)).toBe(true);
    }
    expect(pathLength(around)).toBeLessThan(9);
  });
});

it("accepts a segment that ends exactly on a cell corner", () => {
  const mask = maskFrom([
    "...", //
    "...",
  ]);
  // (2, 0) is the corner shared by cells (1, 0) and (2, 0); `floor` puts it in (2, 0).
  expect(hasLineOfSight(mask, { x: 1.75, z: 0.25 }, { x: 2, z: 0 })).toBe(true);
  expect(hasLineOfSight(mask, { x: 0.5, z: 1.5 }, { x: 2, z: 0 })).toBe(true);
  expect(hasLineOfSight(mask, { x: 2.5, z: 1.5 }, { x: 1, z: 1 })).toBe(true);
});
