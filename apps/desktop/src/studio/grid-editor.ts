import { DRAWING_GRID, MAX_PART_COLORS } from "@living-diorama/content-schema";

// Draw mode's pixel grid (ADR 0025 §4, §15): a 32 × 32 grid of colour indices, 0 empty and `i`
// the palette's colour `i - 1`, edited with a pen, an eraser and a fill. Every edit makes a new
// grid and leaves the old one as it was, so undo keeps the grids themselves as snapshots. Pure.

/** `DRAWING_GRID`² colour indices, row by row from the top-left. Never changed once made. */
export type Grid = Readonly<Uint8Array>;

/** The grid's tools. The pen and the eraser paint the cells a stroke crosses; fill floods. */
export const GRID_TOOLS = ["pen", "eraser", "fill"] as const;
export type GridTool = (typeof GRID_TOOLS)[number];

/** How many steps undo goes back. */
export const MAX_GRID_HISTORY = 100;

export const emptyGrid = (): Grid => new Uint8Array(DRAWING_GRID * DRAWING_GRID);

/** Whether a cell lies on the grid. */
export const onGrid = (x: number, y: number) =>
  Number.isInteger(x) &&
  Number.isInteger(y) &&
  x >= 0 &&
  y >= 0 &&
  x < DRAWING_GRID &&
  y < DRAWING_GRID;

export const cellAt = (grid: Grid, x: number, y: number): number =>
  onGrid(x, y) ? (grid[x + DRAWING_GRID * y] ?? 0) : 0;

export const isBlank = (grid: Grid) => grid.every((value) => value === 0);

export const sameGrid = (a: Grid, b: Grid) =>
  a === b || (a.length === b.length && a.every((value, i) => value === b[i]));

/** The cells of a straight line from one cell to another, both included (Bresenham). */
export function lineCells(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const cells: [number, number][] = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  let [x, y] = [x0, y0];
  for (;;) {
    cells.push([x, y]);
    if (x === x1 && y === y1) return cells;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
}

/**
 * The grid with `cells` set to `value` (0 erases). The same grid when nothing changes, so a
 * stroke over cells already that colour makes no undo step.
 */
export function paint(grid: Grid, cells: Iterable<readonly [number, number]>, value: number): Grid {
  let next: Uint8Array | undefined;
  for (const [x, y] of cells) {
    if (!onGrid(x, y)) continue;
    const i = x + DRAWING_GRID * y;
    if ((next ?? grid)[i] === value) continue;
    next ??= new Uint8Array(grid);
    next[i] = value;
  }
  return next ?? grid;
}

/**
 * The grid with the region around a cell set to `value`: the cells of that cell's value joined to
 * it side by side (not corner to corner). Filling an empty cell fills the empty region around it.
 */
export function floodFill(grid: Grid, x: number, y: number, value: number): Grid {
  if (!onGrid(x, y)) return grid;
  const from = cellAt(grid, x, y);
  if (from === value) return grid;
  const next = new Uint8Array(grid);
  const stack = [x + DRAWING_GRID * y];
  next[x + DRAWING_GRID * y] = value;
  for (let i = stack.pop(); i !== undefined; i = stack.pop()) {
    const cx = i % DRAWING_GRID;
    const cy = Math.floor(i / DRAWING_GRID);
    for (const [nx, ny] of [
      [cx - 1, cy],
      [cx + 1, cy],
      [cx, cy - 1],
      [cx, cy + 1],
    ] as const) {
      if (!onGrid(nx, ny)) continue;
      const j = nx + DRAWING_GRID * ny;
      if (next[j] !== from) continue;
      next[j] = value;
      stack.push(j);
    }
  }
  return next;
}

/** The grid's undo history: snapshots of whole grids (ADR 0025 §15), as Build mode keeps (§16). */
export interface GridHistory {
  past: readonly Grid[];
  present: Grid;
  future: readonly Grid[];
}

export const startHistory = (grid: Grid = emptyGrid()): GridHistory => ({
  past: [],
  present: grid,
  future: [],
});

/**
 * Makes `grid` the present, one undo step after the grid before, and drops what redo had. Nothing
 * changes when it is the same as the present, so a click that paints nothing new is no step.
 */
export function commit(history: GridHistory, grid: Grid): GridHistory {
  if (sameGrid(grid, history.present)) return history;
  return {
    past: [...history.past, history.present].slice(-MAX_GRID_HISTORY),
    present: grid,
    future: [],
  };
}

export const canUndo = (history: GridHistory) => history.past.length > 0;
export const canRedo = (history: GridHistory) => history.future.length > 0;

export function undo(history: GridHistory): GridHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: GridHistory): GridHistory {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/**
 * The palette index (from 1) of `color` for painting, adding it to the palette if it isn't there.
 * The palette only grows while drawing, so every snapshot's indices stay good; saving keeps only
 * the colours used (`compactDrawing`). Undefined when it is full (`MAX_PART_COLORS`).
 */
export function colourIndex(
  palette: readonly string[],
  color: string,
): { palette: readonly string[]; index: number } | undefined {
  const lower = color.toLowerCase();
  const found = palette.indexOf(lower);
  if (found >= 0) return { palette, index: found + 1 };
  if (palette.length >= MAX_PART_COLORS) return undefined;
  return { palette: [...palette, lower], index: palette.length + 1 };
}

/**
 * The grid as a drawing's `pixels` and `palette`, keeping only the colours it uses, in the
 * palette's order, so the same picture always saves the same.
 */
export function compactDrawing(
  grid: Grid,
  palette: readonly string[],
): { pixels: number[]; palette: string[] } {
  const used = [...new Set(grid)].filter((value) => value !== 0).sort((a, b) => a - b);
  const remap = new Map(used.map((value, i) => [value, i + 1]));
  return {
    pixels: Array.from(grid, (value) => remap.get(value) ?? 0),
    palette: used.map((value) => palette[value - 1] ?? "#000000"),
  };
}
