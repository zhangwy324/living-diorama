import { WORLD_TOLERANCES } from "@living-diorama/content-schema";
import { insideAt, polygonCrossings } from "../world/geometry";
import type { RegionModel, WorldModel } from "../world/world-model";

// What a region's walkability mask needs to know about each cell that doesn't depend on the
// creature: footprint coverage, surface heights and slopes, water and other regions overhead.
// Computed once per world model and region, then shared by the masks of every navigation profile,
// so a rebuild costs one pass over the cells plus a cheap pass per profile. The world model is
// never changed once built (an edit builds a new one), so the cache is keyed by its identity.

/** The part of the world's cell grid a region's mask covers: the cells its bounding box touches. */
export interface MaskGrid {
  /** First world cell column/row covered. */
  i0: number;
  j0: number;
  columns: number;
  rows: number;
  cellSize: number;
  originX: number;
  originZ: number;
}

export function maskGrid(world: WorldModel, region: RegionModel): MaskGrid {
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
  return { i0, j0, columns, rows, cellSize: cs, originX, originZ };
}

/** What a cell centre is, before any profile's rules. */
export const CellBase = {
  /** Outside the region's footprint. */
  outside: 0,
  /** In the footprint, off the surface. */
  offSurface: 1,
  /** In a water region's footprint, where its surface isn't above the ground all over the cell. */
  dry: 2,
  /** On the surface: the other arrays hold its facts. */
  surface: 3,
} as const;

export interface RegionCells {
  grid: MaskGrid;
  /** A `CellBase` per mask cell. */
  base: Uint8Array;
  /** Surface height at the cell centre, for `surface` cells; NaN otherwise. */
  heights: Float64Array;
  /** Steepest slope sampled in the cell (centre and one point per terrain triangle); -Infinity if none. */
  slopes: Float64Array;
  /** 1 where an overlapping water region's surface is above this one anywhere in the cell. */
  submerged: Uint8Array;
  /** 1 where another region's surface lies within a step above this one at the centre. */
  covered: Uint8Array;
  /** The lowest other region's surface more than a step above this one at the centre; Infinity if none. */
  lowestAbove: Float64Array;
  /** `region.surface.edgeDistance` at the cell centre, filled in on first use (NaN until then). */
  edgeDistance(cell: number): number;
}

/** A point-in-footprint test that computes each line's edge crossings once (a scanline). */
class FootprintRows {
  readonly #rows = new Map<number, number[]>();
  constructor(readonly region: RegionModel) {}

  /** Exactly `pointInPolygon(x, z, region.footprint)`. */
  contains(x: number, z: number): boolean {
    let crossings = this.#rows.get(z);
    if (!crossings) {
      crossings = polygonCrossings(this.region.footprint, z);
      this.#rows.set(z, crossings);
    }
    return insideAt(crossings, x);
  }

  /** Inside the bounding box and the footprint. */
  covers(x: number, z: number): boolean {
    const { box } = this.region;
    return x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ && this.contains(x, z);
  }
}

class WorldCells {
  readonly #footprints = new Map<RegionModel, FootprintRows>();
  readonly #cells = new Map<RegionModel, RegionCells>();
  constructor(readonly world: WorldModel) {}

  footprint(region: RegionModel): FootprintRows {
    let rows = this.#footprints.get(region);
    if (!rows) {
      rows = new FootprintRows(region);
      this.#footprints.set(region, rows);
    }
    return rows;
  }

  cells(region: RegionModel): RegionCells {
    let cells = this.#cells.get(region);
    if (!cells) {
      cells = this.#build(region);
      this.#cells.set(region, cells);
    }
    return cells;
  }

  #build(region: RegionModel): RegionCells {
    const { world } = this;
    const { terrain } = world;
    const grid = maskGrid(world, region);
    const { i0, j0, columns, rows, originX, originZ } = grid;
    const cs = grid.cellSize;
    const count = columns * rows;
    const eps = WORLD_TOLERANCES.surfaceEpsilon;
    const step = WORLD_TOLERANCES.maxStepHeight;
    const base = new Uint8Array(count);
    const heights = new Float64Array(count).fill(NaN);
    const slopes = new Float64Array(count).fill(-Infinity);
    const submerged = new Uint8Array(count);
    const covered = new Uint8Array(count);
    const lowestAbove = new Float64Array(count).fill(Infinity);
    const edges = new Float64Array(count).fill(NaN);

    const own = this.footprint(region);
    const others = [...world.regions.values()].filter((r) => r !== region);
    const waters = others.filter((r) => r.kind === "water").map((r) => this.footprint(r));
    const lands = others.filter((r) => r.kind !== "water").map((r) => this.footprint(r));
    const surface = region.surface;
    // The cell centre and four points just inside its corners.
    const d = cs * 0.49;
    const q = cs / 4;
    const sampleX = [0, -d, d, -d, d];
    const sampleZ = [0, -d, -d, d, d];
    const sample = (k: number, x: number, z: number) =>
      k === 0 ? { x, z } : { x: x + (sampleX[k] ?? 0), z: z + (sampleZ[k] ?? 0) };

    for (let cell = 0; cell < count; cell++) {
      // As `RegionMask.center`.
      const x = originX + ((cell % columns) + i0 + 0.5) * cs;
      const z = originZ + (Math.floor(cell / columns) + j0 + 0.5) * cs;
      if (!own.contains(x, z)) continue;
      const h = surface.heightAt(x, z);
      if (h === undefined) {
        base[cell] = CellBase.offSurface;
        continue;
      }
      if (region.kind === "water") {
        let dry = false;
        for (let k = 0; k < 5 && !dry; k++) {
          const p = sample(k, x, z);
          dry = terrain.heightAt(p.x, p.z) >= h + eps;
        }
        if (dry) {
          base[cell] = CellBase.dry;
          continue;
        }
      }
      base[cell] = CellBase.surface;
      heights[cell] = h;
      let steepest = -Infinity;
      for (const s of [
        surface.slopeAt(x, z),
        surface.slopeAt(x + q, z - q),
        surface.slopeAt(x - q, z + q),
      ]) {
        // NaN never compares greater, as it never counts as too steep.
        if (s !== undefined && s > steepest) steepest = s;
      }
      slopes[cell] = steepest;
      under: for (const w of waters) {
        for (let k = 0; k < 5; k++) {
          const p = sample(k, x, z);
          if (!w.covers(p.x, p.z)) continue;
          const below = surface.heightAt(p.x, p.z);
          const above = w.region.surface.heightAt(p.x, p.z);
          if (below !== undefined && above !== undefined && above > below + eps) {
            submerged[cell] = 1;
            break under;
          }
        }
      }
      for (const other of lands) {
        if (!other.covers(x, z)) continue;
        const above = other.region.surface.heightAt(x, z);
        if (above === undefined || above <= h + eps) continue;
        if (above <= h + step) covered[cell] = 1;
        else if (above < (lowestAbove[cell] ?? Infinity)) lowestAbove[cell] = above;
      }
    }

    return {
      grid,
      base,
      heights,
      slopes,
      submerged,
      covered,
      lowestAbove,
      edgeDistance(cell) {
        let distance = edges[cell] ?? NaN;
        if (Number.isNaN(distance)) {
          const x = originX + ((cell % columns) + i0 + 0.5) * cs;
          const z = originZ + (Math.floor(cell / columns) + j0 + 0.5) * cs;
          distance = surface.edgeDistance(x, z);
          edges[cell] = distance;
        }
        return distance;
      },
    };
  }
}

const cache = new WeakMap<WorldModel, WorldCells>();

function worldCells(world: WorldModel): WorldCells {
  let cells = cache.get(world);
  if (!cells) {
    cells = new WorldCells(world);
    cache.set(world, cells);
  }
  return cells;
}

/** The profile-independent cell facts of `region`'s mask, shared by every profile. */
export function regionCells(world: WorldModel, region: RegionModel): RegionCells {
  return worldCells(world).cells(region);
}

/** `pointInPolygon` (inside the box too, for `covers`) on a region's footprint, with cached rows. */
export function footprintRows(world: WorldModel, region: RegionModel): FootprintRows {
  return worldCells(world).footprint(region);
}
