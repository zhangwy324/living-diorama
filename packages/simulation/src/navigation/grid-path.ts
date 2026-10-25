import type { Vec2 } from "@living-diorama/content-schema";
import { MinHeap } from "./heap";
import { CellState, type RegionMask } from "./walkability";

// Local navigation inside one region over its walkability mask (roadmap M3 task 5): 8-connected
// grid search that never cuts a blocked corner, and string-pulling with a conservative line of
// sight so a smoothed path only crosses walkable cells.

const STEPS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

function walkable(mask: RegionMask, i: number, j: number): boolean {
  return (
    i >= 0 &&
    j >= 0 &&
    i < mask.columns &&
    j < mask.rows &&
    mask.states[j * mask.columns + i] === CellState.walkable
  );
}

/** Calls `visit` for each walkable neighbour of `cell` with the step length in metres. */
export function forEachNeighbor(
  mask: RegionMask,
  cell: number,
  visit: (next: number, distance: number) => void,
): void {
  const i = cell % mask.columns;
  const j = Math.floor(cell / mask.columns);
  for (const [di, dj, length] of STEPS) {
    if (!walkable(mask, i + di, j + dj)) continue;
    if (di !== 0 && dj !== 0 && !(walkable(mask, i + di, j) && walkable(mask, i, j + dj))) continue;
    visit((j + dj) * mask.columns + i + di, length * mask.cellSize);
  }
}

/** Walking distance in metres from `source` to every cell; Infinity where unreachable. */
export function distanceField(mask: RegionMask, source: number): Float64Array {
  const distance = new Float64Array(mask.states.length).fill(Infinity);
  if (mask.states[source] !== CellState.walkable) return distance;
  distance[source] = 0;
  const open = new MinHeap();
  open.push(source, 0);
  for (let cell = open.pop(); cell !== undefined; cell = open.pop()) {
    const here = distance[cell] ?? Infinity;
    forEachNeighbor(mask, cell, (next, step) => {
      const d = here + step;
      if (d >= (distance[next] ?? Infinity)) return;
      distance[next] = d;
      open.push(next, d);
    });
  }
  return distance;
}

/** A* between two walkable cells. Returns the cells from start to goal, or undefined. */
export function findCellPath(mask: RegionMask, start: number, goal: number): number[] | undefined {
  if (mask.states[start] !== CellState.walkable || mask.states[goal] !== CellState.walkable) {
    return undefined;
  }
  const { columns, cellSize } = mask;
  const gi = goal % columns;
  const gj = Math.floor(goal / columns);
  // Octile distance: exact on an empty grid, so the search stays optimal.
  const heuristic = (cell: number) => {
    const di = Math.abs((cell % columns) - gi);
    const dj = Math.abs(Math.floor(cell / columns) - gj);
    return (Math.max(di, dj) + (Math.SQRT2 - 1) * Math.min(di, dj)) * cellSize;
  };
  const cost = new Float64Array(mask.states.length).fill(Infinity);
  const from = new Int32Array(mask.states.length).fill(-1);
  const closed = new Uint8Array(mask.states.length);
  cost[start] = 0;
  const open = new MinHeap();
  open.push(start, heuristic(start));
  for (let cell = open.pop(); cell !== undefined; cell = open.pop()) {
    if (cell === goal) break;
    if (closed[cell]) continue;
    closed[cell] = 1;
    const here = cost[cell] ?? Infinity;
    forEachNeighbor(mask, cell, (next, step) => {
      const c = here + step;
      if (c >= (cost[next] ?? Infinity)) return;
      cost[next] = c;
      from[next] = cell;
      open.push(next, c + heuristic(next));
    });
  }
  if (start !== goal && from[goal] === -1) return undefined;
  const cells = [goal];
  for (let cell = goal; cell !== start;) {
    cell = from[cell] ?? start;
    cells.push(cell);
  }
  return cells.reverse();
}

/**
 * True when every cell the segment a–b passes through is walkable. Passing exactly through a
 * cell corner needs both side cells clear, the same rule as a diagonal grid step.
 */
export function hasLineOfSight(mask: RegionMask, a: Vec2, b: Vec2): boolean {
  const cs = mask.cellSize;
  const fx = (a.x - mask.originX) / cs - mask.i0;
  const fz = (a.z - mask.originZ) / cs - mask.j0;
  const tx = (b.x - mask.originX) / cs - mask.i0;
  const tz = (b.z - mask.originZ) / cs - mask.j0;
  let i = Math.floor(fx);
  let j = Math.floor(fz);
  const ti = Math.floor(tx);
  const tj = Math.floor(tz);
  if (!walkable(mask, i, j)) return false;
  const dx = tx - fx;
  const dz = tz - fz;
  const si = Math.sign(dx);
  const sj = Math.sign(dz);
  // Amanatides–Woo traversal: parameter t along a–b at which the next cell boundary is crossed.
  const deltaX = si === 0 ? Infinity : Math.abs(1 / dx);
  const deltaZ = sj === 0 ? Infinity : Math.abs(1 / dz);
  let nextX = si > 0 ? (i + 1 - fx) / dx : si < 0 ? (i - fx) / dx : Infinity;
  let nextZ = sj > 0 ? (j + 1 - fz) / dz : sj < 0 ? (j - fz) / dz : Infinity;
  const eps = 1e-9;
  let guard = Math.abs(ti - i) + Math.abs(tj - j);
  while ((i !== ti || j !== tj) && guard-- > 0) {
    // Only step along an axis whose target cell is not reached yet. An end point exactly on a
    // cell edge belongs to the cell `floor` picks, so its final boundary crossing may not count.
    const needI = i !== ti;
    const needJ = j !== tj;
    if (needI && needJ && Math.abs(nextX - nextZ) < eps) {
      if (!walkable(mask, i + si, j) || !walkable(mask, i, j + sj)) return false;
      i += si;
      j += sj;
      nextX += deltaX;
      nextZ += deltaZ;
    } else if (needI && (!needJ || nextX < nextZ)) {
      i += si;
      nextX += deltaX;
    } else {
      j += sj;
      nextZ += deltaZ;
    }
    if (!walkable(mask, i, j)) return false;
  }
  return i === ti && j === tj;
}

/** Drops waypoints that the previous kept point can see past. Keeps the first and last points. */
export function smoothPath(mask: RegionMask, points: readonly Vec2[]): Vec2[] {
  const first = points[0];
  if (!first || points.length <= 2) return [...points];
  const kept = [first];
  let anchor = first;
  for (let k = 1; k < points.length - 1; k++) {
    const next = points[k + 1];
    const here = points[k];
    if (!next || !here) break;
    if (hasLineOfSight(mask, anchor, next)) continue;
    kept.push(here);
    anchor = here;
  }
  kept.push(points[points.length - 1] ?? first);
  return kept;
}

/**
 * A smoothed walking path from `from` to `to` inside one region, both of which must lie in
 * walkable cells. The first and last points are exactly `from` and `to`.
 */
export function findGridPath(mask: RegionMask, from: Vec2, to: Vec2): Vec2[] | undefined {
  const start = mask.cellAt(from.x, from.z);
  const goal = mask.cellAt(to.x, to.z);
  if (start === -1 || goal === -1) return undefined;
  const cells = findCellPath(mask, start, goal);
  if (!cells) return undefined;
  const raw = [from, ...cells.slice(1, -1).map((cell) => mask.center(cell)), to];
  return smoothPath(mask, raw);
}

export function pathLength(points: readonly Vec2[]): number {
  let length = 0;
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1];
    const b = points[k];
    if (a && b) length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return length;
}
