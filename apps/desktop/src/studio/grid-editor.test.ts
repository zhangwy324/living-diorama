import { DRAWING_GRID, MAX_PART_COLORS } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import {
  MAX_GRID_HISTORY,
  canRedo,
  canUndo,
  cellAt,
  colourIndex,
  commit,
  compactDrawing,
  emptyGrid,
  floodFill,
  isBlank,
  lineCells,
  paint,
  redo,
  startHistory,
  undo,
  type Grid,
} from "./grid-editor";

/** The painted cells of a grid as rows of text, `.` empty, rows `top` to `top + rows - 1`. */
const rows = (grid: Grid, rowCount: number, width = 6) =>
  Array.from({ length: rowCount }, (_, y) =>
    Array.from({ length: width }, (_, x) => {
      const value = cellAt(grid, x, y);
      return value === 0 ? "." : String(value);
    }).join(""),
  );

/** A grid from rows of text, `.` empty and a digit a colour index, from the top-left. */
const gridOf = (lines: readonly string[]) =>
  paint(
    emptyGrid(),
    lines.flatMap((line, y) =>
      [...line].flatMap((char, x) => (char === "." ? [] : [[x, y] as const])),
    ),
    1,
  );

describe("the pen and the eraser", () => {
  it("paint every cell of a stroke between two cells", () => {
    expect(lineCells(0, 0, 3, 0)).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(lineCells(0, 0, 2, 2)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
    // Steep and backwards: one cell a row, no gaps.
    const steep = lineCells(1, 4, 0, 0);
    expect(steep).toHaveLength(5);
    expect(steep[0]).toEqual([1, 4]);
    expect(steep.at(-1)).toEqual([0, 0]);
  });

  it("make a new grid and leave the old one as it was", () => {
    const before = emptyGrid();
    const after = paint(before, [[1, 1]], 2);
    expect(cellAt(after, 1, 1)).toBe(2);
    expect(isBlank(before)).toBe(true);
  });

  it("give the same grid back when nothing changes", () => {
    const grid = paint(emptyGrid(), [[1, 1]], 2);
    expect(paint(grid, [[1, 1]], 2)).toBe(grid);
    expect(paint(grid, [[5, 5]], 0)).toBe(grid);
    expect(paint(grid, [[-1, 0]], 2)).toBe(grid);
    expect(paint(grid, [[DRAWING_GRID, 0]], 2)).toBe(grid);
  });

  it("erase with 0", () => {
    const grid = paint(gridOf(["111"]), [[1, 0]], 0);
    expect(rows(grid, 1, 3)).toEqual(["1.1"]);
  });
});

describe("fill", () => {
  it("fills the cells of a colour joined side by side, not corner to corner", () => {
    const grid = gridOf(["11.", "1..", "..1"]);
    expect(rows(floodFill(grid, 0, 0, 2), 3, 3)).toEqual(["22.", "2..", "..1"]);
  });

  it("fills an empty region inside a shape", () => {
    const ring = gridOf(["111", "1.1", "111"]);
    expect(rows(floodFill(ring, 1, 1, 3), 3, 3)).toEqual(["111", "131", "111"]);
  });

  it("fills the whole outside from an empty cell outside", () => {
    const ring = gridOf(["111", "1.1", "111"]);
    const filled = floodFill(ring, 10, 10, 2);
    expect(cellAt(filled, 1, 1)).toBe(0);
    expect(cellAt(filled, DRAWING_GRID - 1, DRAWING_GRID - 1)).toBe(2);
    expect(cellAt(filled, 3, 0)).toBe(2);
  });

  it("gives the same grid back when the colour is already there", () => {
    const grid = gridOf(["11"]);
    expect(floodFill(grid, 0, 0, 1)).toBe(grid);
    expect(floodFill(grid, -1, 0, 2)).toBe(grid);
  });
});

describe("undo", () => {
  it("keeps each grid as a snapshot, one step an edit", () => {
    const a = gridOf(["1"]);
    const b = paint(a, [[1, 0]], 1);
    let history = commit(commit(startHistory(), a), b);
    expect(history.present).toBe(b);
    expect(canUndo(history)).toBe(true);
    history = undo(history);
    expect(history.present).toBe(a);
    expect(rows(history.present, 1, 2)).toEqual(["1."]);
    history = undo(history);
    expect(isBlank(history.present)).toBe(true);
    expect(canUndo(history)).toBe(false);
    expect(undo(history)).toBe(history);
    history = redo(redo(history));
    expect(history.present).toBe(b);
    expect(canRedo(history)).toBe(false);
    expect(redo(history)).toBe(history);
  });

  it("makes no step for a grid like the present", () => {
    const history = commit(startHistory(), gridOf(["1"]));
    expect(commit(history, gridOf(["1"]))).toBe(history);
  });

  it("drops what redo had on a new edit", () => {
    const history = undo(commit(startHistory(), gridOf(["1"])));
    expect(canRedo(history)).toBe(true);
    const next = commit(history, gridOf([".1"]));
    expect(canRedo(next)).toBe(false);
  });

  it(`goes back at most ${MAX_GRID_HISTORY} steps`, () => {
    let history = startHistory();
    for (let i = 0; i < MAX_GRID_HISTORY + 10; i++) {
      history = commit(history, paint(history.present, [[i % DRAWING_GRID, 0]], (i % 9) + 1));
    }
    expect(history.past).toHaveLength(MAX_GRID_HISTORY);
  });
});

describe("the palette", () => {
  it("finds a colour, case aside, or adds it", () => {
    const added = colourIndex([], "#AABBCC");
    expect(added).toEqual({ palette: ["#aabbcc"], index: 1 });
    const palette = ["#112233", "#aabbcc"];
    const found = colourIndex(palette, "#aabbcc");
    expect(found?.index).toBe(2);
    expect(found?.palette).toBe(palette);
  });

  it(`refuses a new colour past ${MAX_PART_COLORS}`, () => {
    const full = Array.from(
      { length: MAX_PART_COLORS },
      (_, i) => `#${i.toString(16).padStart(6, "0")}`,
    );
    expect(colourIndex(full, "#ffffff")).toBeUndefined();
    expect(colourIndex(full, "#000001")?.index).toBe(2);
  });

  it("saves only the colours a drawing uses, in the palette's order", () => {
    const grid = paint(paint(emptyGrid(), [[0, 0]], 3), [[1, 0]], 1);
    const { pixels, palette } = compactDrawing(grid, ["#000001", "#000002", "#000003"]);
    expect(palette).toEqual(["#000001", "#000003"]);
    expect(pixels.slice(0, 3)).toEqual([2, 1, 0]);
    expect(pixels).toHaveLength(DRAWING_GRID * DRAWING_GRID);
  });
});
