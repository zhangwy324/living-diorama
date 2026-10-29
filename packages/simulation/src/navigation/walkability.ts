import { CellBase, regionCells } from "./region-cells";
import type { RegionModel, WorldModel } from "../world/world-model";
import type { NavProfile } from "./profile";

// Walkability is derived at load time from the world definition (ADR 0005 §4). Each region gets
// a mask on the world's cell grid (the heightfield cells), per navigation profile.

export const CellState = {
  /** The cell centre is outside the region's footprint. */
  outside: 0,
  walkable: 1,
  /** No surface here, e.g. beside a deck. */
  offSurface: 2,
  steep: 3,
  /** Below the surface of an overlapping water region, anywhere in the cell. */
  submerged: 4,
  /** Another region's surface is lower than the creature's height above this one. */
  noHeadroom: 5,
  /** Closer than the creature's radius to a blocked cell or the surface's edge. */
  tooClose: 6,
  prop: 7,
  worldEdge: 8,
  /** The creature has no locomotion for this region's kind. */
  noLocomotion: 9,
  /**
   * Another region's surface lies within a step above this one, e.g. under the end of a deck.
   * The creature stands on that region here instead, so this is not an obstacle for clearance.
   */
  covered: 10,
  /**
   * A water region's surface is not above the ground somewhere in this cell, e.g. where its
   * footprint reaches over the bank (ADR 0020 §3). An obstacle for clearance, so a swimmer's
   * body keeps out of the bank.
   */
  dry: 11,
} as const;
export type CellState = (typeof CellState)[keyof typeof CellState];

/**
 * Whether a cell in this state keeps the creature's radius away. For a creature that can swim,
 * water over the ground is somewhere it can go, not an obstacle, so its walkable land reaches
 * the waterline (ADR 0020 §4).
 */
const isBaseBlocked = (s: number, canSwim: boolean) =>
  s === CellState.offSurface ||
  s === CellState.steep ||
  s === CellState.dry ||
  (s === CellState.submerged && !canSwim) ||
  s === CellState.noHeadroom;

export class RegionMask {
  constructor(
    readonly region: RegionModel,
    /** First world cell column/row covered by this mask. */
    readonly i0: number,
    readonly j0: number,
    readonly columns: number,
    readonly rows: number,
    readonly cellSize: number,
    readonly originX: number,
    readonly originZ: number,
    readonly states: Uint8Array,
    /** Surface height at each cell centre (NaN off the surface). */
    readonly heights: Float64Array,
  ) {}

  /** Index of the mask cell containing (x, z), or -1 outside the mask. */
  cellAt(x: number, z: number): number {
    const i = Math.floor((x - this.originX) / this.cellSize) - this.i0;
    const j = Math.floor((z - this.originZ) / this.cellSize) - this.j0;
    return i < 0 || j < 0 || i >= this.columns || j >= this.rows ? -1 : j * this.columns + i;
  }

  center(index: number): { x: number; z: number } {
    const i = (index % this.columns) + this.i0;
    const j = Math.floor(index / this.columns) + this.j0;
    return {
      x: this.originX + (i + 0.5) * this.cellSize,
      z: this.originZ + (j + 0.5) * this.cellSize,
    };
  }

  state(cell: number): CellState {
    return (this.states[cell] ?? CellState.outside) as CellState;
  }

  /** Surface height at a cell's centre, NaN off the surface. */
  height(cell: number): number {
    return this.heights[cell] ?? NaN;
  }

  isWalkableAt(x: number, z: number): boolean {
    const cell = this.cellAt(x, z);
    return cell !== -1 && this.states[cell] === CellState.walkable;
  }

  get walkableCount(): number {
    return this.states.reduce((n, s) => n + (s === CellState.walkable ? 1 : 0), 0);
  }

  /** Connected walkable areas, largest first. 8-connected, but never cutting a blocked corner. */
  components(): number[][] {
    const { columns, rows, states } = this;
    const seen = new Uint8Array(states.length);
    const walkable = (i: number, j: number) =>
      i >= 0 && j >= 0 && i < columns && j < rows && states[j * columns + i] === CellState.walkable;
    const found: number[][] = [];
    for (let start = 0; start < states.length; start++) {
      if (seen[start] || states[start] !== CellState.walkable) continue;
      const component = [start];
      seen[start] = 1;
      for (const cell of component) {
        const i = cell % columns;
        const j = Math.floor(cell / columns);
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if ((di === 0 && dj === 0) || !walkable(i + di, j + dj)) continue;
            if (di !== 0 && dj !== 0 && !(walkable(i + di, j) && walkable(i, j + dj))) continue;
            const next = (j + dj) * columns + i + di;
            if (seen[next]) continue;
            seen[next] = 1;
            component.push(next);
          }
        }
      }
      found.push(component);
    }
    return found.sort((a, b) => b.length - a.length);
  }
}

/** Builds the walkability mask of one region for one navigation profile. */
export function buildRegionMask(
  world: WorldModel,
  region: RegionModel,
  profile: NavProfile,
): RegionMask {
  const { bounds } = world;
  const cells = regionCells(world, region);
  const { i0, j0, columns, rows, cellSize: cs, originX, originZ } = cells.grid;
  const states = new Uint8Array(columns * rows);
  const heights = new Float64Array(columns * rows).fill(NaN);
  const mask = new RegionMask(region, i0, j0, columns, rows, cs, originX, originZ, states, heights);
  const maxSlope = profile.maxSlopeByKind.get(region.kind);

  // Pass 1: what the surface itself allows.
  for (let cell = 0; cell < states.length; cell++) {
    const base = cells.base[cell];
    if (base === CellBase.outside) continue;
    if (maxSlope === undefined) {
      states[cell] = CellState.noLocomotion;
      continue;
    }
    if (base === CellBase.offSurface) {
      states[cell] = CellState.offSurface;
      continue;
    }
    // A water region is only where its surface lies above the ground (ADR 0020 §3), all over the
    // cell, since a creature may stand anywhere in it.
    if (base === CellBase.dry) {
      states[cell] = CellState.dry;
      continue;
    }
    const h = cells.heights[cell] ?? NaN;
    heights[cell] = h;
    if ((cells.slopes[cell] ?? -Infinity) > maxSlope) {
      states[cell] = CellState.steep;
      continue;
    }
    // Land is under water if any part of the cell is: a creature may stand anywhere in it.
    if (cells.submerged[cell]) {
      states[cell] = CellState.submerged;
      continue;
    }
    // Another region's surface within a step above: the creature stands on that one here. Any
    // higher but lower than the creature's height leaves it no room.
    states[cell] =
      (cells.lowestAbove[cell] ?? Infinity) < h + profile.height
        ? CellState.noHeadroom
        : cells.covered[cell]
          ? CellState.covered
          : CellState.walkable;
  }

  // Pass 2: clearance for the creature's radius.
  const radius = profile.radius;
  const reach = Math.ceil((radius + cs / 2) / cs);
  const canSwim = profile.maxSlopeByKind.has("water");
  const blocked = Uint8Array.from(states, (s) => (isBaseBlocked(s, canSwim) ? 1 : 0));
  const nearProp = propCells(world, mask, radius);
  // The neighbours, as offsets, whose square comes within the radius of a cell's centre.
  const close: number[][] = [];
  for (let dj = -reach; dj <= reach; dj++) {
    for (let di = -reach; di <= reach; di++) {
      // Distance from the centre to the nearest point of the neighbour's square.
      const dx = Math.max(0, Math.abs(di) * cs - cs / 2);
      const dz = Math.max(0, Math.abs(dj) * cs - cs / 2);
      if (Math.hypot(dx, dz) < radius) close.push([di, dj]);
    }
  }
  for (let cell = 0; cell < states.length; cell++) {
    if (states[cell] !== CellState.walkable) continue;
    const { x, z } = mask.center(cell);
    if (
      x - bounds.min.x < radius ||
      bounds.max.x - x < radius ||
      z - bounds.min.z < radius ||
      bounds.max.z - z < radius
    ) {
      states[cell] = CellState.worldEdge;
      continue;
    }
    if (nearProp[cell]) {
      states[cell] = CellState.prop;
      continue;
    }
    if (cells.edgeDistance(cell) < radius) {
      states[cell] = CellState.tooClose;
      continue;
    }
    const i = cell % columns;
    const j = Math.floor(cell / columns);
    for (const [di = 0, dj = 0] of close) {
      const ni = i + di;
      const nj = j + dj;
      if (ni >= 0 && nj >= 0 && ni < columns && nj < rows && blocked[nj * columns + ni]) {
        states[cell] = CellState.tooClose;
        break;
      }
    }
  }
  return mask;
}

/**
 * 1 for each mask cell whose centre is closer to a prop than its block radius plus `radius`.
 * Visits only the cells around each prop instead of every prop per cell.
 */
function propCells(world: WorldModel, mask: RegionMask, radius: number): Uint8Array {
  const { i0, j0, columns, rows, cellSize: cs, originX, originZ } = mask;
  const near = new Uint8Array(columns * rows);
  for (const p of world.props) {
    const { x: px, z: pz } = p.transform.position;
    const range = p.blockRadius + radius;
    // `Math.hypot` is never below either leg, so no cell further than `range` along an axis
    // passes; a cell's margin on each side absorbs rounding.
    const iLo = Math.max(0, Math.floor((px - range - originX) / cs) - i0 - 1);
    const iHi = Math.min(columns - 1, Math.ceil((px + range - originX) / cs) - i0 + 1);
    const jLo = Math.max(0, Math.floor((pz - range - originZ) / cs) - j0 - 1);
    const jHi = Math.min(rows - 1, Math.ceil((pz + range - originZ) / cs) - j0 + 1);
    for (let j = jLo; j <= jHi; j++) {
      for (let i = iLo; i <= iHi; i++) {
        const cell = j * columns + i;
        if (near[cell]) continue;
        const { x, z } = mask.center(cell);
        if (Math.hypot(px - x, pz - z) < range) near[cell] = 1;
      }
    }
  }
  return near;
}
