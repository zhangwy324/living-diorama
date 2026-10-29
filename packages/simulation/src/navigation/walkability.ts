import { WORLD_TOLERANCES } from "@living-diorama/content-schema";
import { pointInPolygon } from "../world/geometry";
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
  /** Below the surface of an overlapping water region. */
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
   * A water region's surface is not above the ground here, e.g. where its footprint reaches over
   * the bank (ADR 0020 §3). Like `outside`, this is not an obstacle for clearance.
   */
  dry: 11,
} as const;
export type CellState = (typeof CellState)[keyof typeof CellState];

/**
 * Whether a cell in this state keeps the creature's radius away. For a creature that can swim,
 * water over the ground is somewhere it can go, not an obstacle, so its walkable land reaches
 * the waterline and meets the water's walkable cells there (the derived entry, ADR 0020 §4).
 */
const isBaseBlocked = (s: number, canSwim: boolean) =>
  s === CellState.offSurface ||
  s === CellState.steep ||
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
  const { terrain, bounds } = world;
  const cs = terrain.cellSize;
  const originX = bounds.min.x;
  const originZ = bounds.min.z;
  const worldColumns = terrain.columns - 1;
  const worldRows = terrain.rows - 1;
  const clampI = (v: number) => Math.max(0, Math.min(worldColumns - 1, v));
  const clampJ = (v: number) => Math.max(0, Math.min(worldRows - 1, v));
  const i0 = clampI(Math.floor((region.box.minX - originX) / cs));
  const j0 = clampJ(Math.floor((region.box.minZ - originZ) / cs));
  const columns = clampI(Math.floor((region.box.maxX - originX) / cs)) - i0 + 1;
  const rows = clampJ(Math.floor((region.box.maxZ - originZ) / cs)) - j0 + 1;

  const states = new Uint8Array(columns * rows);
  const heights = new Float64Array(columns * rows).fill(NaN);
  const mask = new RegionMask(region, i0, j0, columns, rows, cs, originX, originZ, states, heights);
  const maxSlope = profile.maxSlopeByKind.get(region.kind);
  const eps = WORLD_TOLERANCES.surfaceEpsilon;

  const others = [...world.regions.values()].filter((r) => r !== region);
  const covers = (r: RegionModel, x: number, z: number) =>
    x >= r.box.minX &&
    x <= r.box.maxX &&
    z >= r.box.minZ &&
    z <= r.box.maxZ &&
    pointInPolygon(x, z, r.footprint);

  // Pass 1: what the surface itself allows.
  for (let cell = 0; cell < states.length; cell++) {
    const { x, z } = mask.center(cell);
    if (!pointInPolygon(x, z, region.footprint)) continue;
    if (maxSlope === undefined) {
      states[cell] = CellState.noLocomotion;
      continue;
    }
    const h = region.surface.heightAt(x, z);
    if (h === undefined) {
      states[cell] = CellState.offSurface;
      continue;
    }
    // A water region is only where its surface lies above the ground (ADR 0020 §3).
    if (region.kind === "water" && h <= terrain.heightAt(x, z) + eps) {
      states[cell] = CellState.dry;
      continue;
    }
    heights[cell] = h;
    // Centre plus one point inside each of the cell's two terrain triangles.
    const q = cs / 4;
    const slopes = [
      region.surface.slopeAt(x, z),
      region.surface.slopeAt(x + q, z - q),
      region.surface.slopeAt(x - q, z + q),
    ];
    if (slopes.some((s) => s !== undefined && s > maxSlope)) {
      states[cell] = CellState.steep;
      continue;
    }
    let state: CellState = CellState.walkable;
    for (const other of others) {
      if (!covers(other, x, z)) continue;
      const above = other.surface.heightAt(x, z);
      if (above === undefined || above <= h + eps) continue;
      if (other.kind === "water") {
        state = CellState.submerged;
        break;
      }
      if (above <= h + WORLD_TOLERANCES.maxStepHeight) {
        state = CellState.covered;
      } else if (above < h + profile.height) {
        state = CellState.noHeadroom;
        break;
      }
    }
    states[cell] = state;
  }

  // Pass 2: clearance for the creature's radius.
  const radius = profile.radius;
  const reach = Math.ceil((radius + cs / 2) / cs);
  const canSwim = profile.maxSlopeByKind.has("water");
  const blocked = Uint8Array.from(states, (s) => (isBaseBlocked(s, canSwim) ? 1 : 0));
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
    if (
      world.props.some(
        (p) =>
          Math.hypot(p.transform.position.x - x, p.transform.position.z - z) <
          p.blockRadius + radius,
      )
    ) {
      states[cell] = CellState.prop;
      continue;
    }
    if (region.surface.edgeDistance(x, z) < radius) {
      states[cell] = CellState.tooClose;
      continue;
    }
    const i = cell % columns;
    const j = Math.floor(cell / columns);
    search: for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= columns || nj >= rows || !blocked[nj * columns + ni])
          continue;
        // Distance from this centre to the nearest point of the blocked cell's square.
        const dx = Math.max(0, Math.abs(di) * cs - cs / 2);
        const dz = Math.max(0, Math.abs(dj) * cs - cs / 2);
        if (Math.hypot(dx, dz) < radius) {
          states[cell] = CellState.tooClose;
          break search;
        }
      }
    }
  }
  return mask;
}
