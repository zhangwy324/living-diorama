import type { Heightfield, WorldBounds } from "@living-diorama/content-schema";

// Heightfield sampling exactly as docs/world-coordinates.md "Sampling" describes, so the
// simulation's ground is the mesh the renderer draws.

export class Terrain {
  readonly columns: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly heights: Float64Array;

  constructor(
    columns: number,
    rows: number,
    cellSize: number,
    minX: number,
    minZ: number,
    heights: ArrayLike<number>,
  ) {
    this.columns = columns;
    this.rows = rows;
    this.cellSize = cellSize;
    this.minX = minX;
    this.minZ = minZ;
    this.heights = Float64Array.from(heights);
  }

  /** Builds the terrain from an inline heightfield; asset heightfields are not supported yet. */
  static fromDefinition(heightfield: Heightfield, bounds: WorldBounds): Terrain | undefined {
    if (heightfield.source !== "inline") return undefined;
    const { columns, rows, cellSize, heights } = heightfield;
    return new Terrain(columns, rows, cellSize, bounds.min.x, bounds.min.z, heights);
  }

  sample(i: number, j: number): number {
    return this.heights[j * this.columns + i] ?? NaN;
  }

  #locate(x: number, z: number) {
    const u = Math.max(0, Math.min(this.columns - 1, (x - this.minX) / this.cellSize));
    const v = Math.max(0, Math.min(this.rows - 1, (z - this.minZ) / this.cellSize));
    const i = Math.min(Math.floor(u), this.columns - 2);
    const j = Math.min(Math.floor(v), this.rows - 2);
    return {
      fx: u - i,
      fz: v - j,
      h00: this.sample(i, j),
      h10: this.sample(i + 1, j),
      h01: this.sample(i, j + 1),
      h11: this.sample(i + 1, j + 1),
    };
  }

  heightAt(x: number, z: number): number {
    const { fx, fz, h00, h10, h01, h11 } = this.#locate(x, z);
    return fx >= fz
      ? h00 + fx * (h10 - h00) + fz * (h11 - h10)
      : h00 + fz * (h01 - h00) + fx * (h11 - h01);
  }

  /** Slope in radians of the triangle containing (x, z). */
  slopeAt(x: number, z: number): number {
    const { fx, fz, h00, h10, h01, h11 } = this.#locate(x, z);
    const [gx, gz] = fx >= fz ? [h10 - h00, h11 - h10] : [h11 - h01, h01 - h00];
    return Math.atan(Math.hypot(gx, gz) / this.cellSize);
  }
}
