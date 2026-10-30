import { voxelIndex, type VoxelSize } from "@living-diorama/content-schema";
import type { VoxCubes } from "./vox-parser";

// Shape helpers for parts made in code (`pnpm parts:bootstrap`): a grid of cubes filled and
// painted with solids tested at each cube's centre. Points are in the part's cubes, in ADR 0022
// §16's axes (+X forward, Y up, +Z right); a cube (x, y, z) has its centre at (x + ½, y + ½, z + ½).

/** A point in a part's cubes. */
export interface Point {
  x: number;
  y: number;
  z: number;
}

/** Whether a point lies inside a solid. */
export type Solid = (p: Point) => boolean;

/** An ellipsoid with centre `c` and radii `r`. */
export const ellipsoid =
  (c: Point, r: Point): Solid =>
  (p) =>
    ((p.x - c.x) / r.x) ** 2 + ((p.y - c.y) / r.y) ** 2 + ((p.z - c.z) / r.z) ** 2 <= 1;

/**
 * A superellipsoid: like `ellipsoid`, but with `power` above 2 it is boxier, its sides flatter
 * and its edges still rounded.
 */
export const superellipsoid =
  (c: Point, r: Point, power: number): Solid =>
  (p) =>
    Math.abs((p.x - c.x) / r.x) ** power +
      Math.abs((p.y - c.y) / r.y) ** power +
      Math.abs((p.z - c.z) / r.z) ** power <=
    1;

/** A capsule: every point within `radius` of the segment from `a` to `b`. */
export const capsule =
  (a: Point, b: Point, radius: number): Solid =>
  (p) => {
    const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const length = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
    const t =
      length === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / length),
          );
    const dx = p.x - (a.x + t * ab.x);
    const dy = p.y - (a.y + t * ab.y);
    const dz = p.z - (a.z + t * ab.z);
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  };

/** The box from `min` to `max`, corners in cubes. */
export const box =
  (min: Point, max: Point): Solid =>
  (p) =>
    p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y && p.z >= min.z && p.z <= max.z;

/** The box from `min` to `max` with its edges and corners rounded to `radius`. */
export const roundedBox =
  (min: Point, max: Point, radius: number): Solid =>
  (p) => {
    const d = (v: number, lo: number, hi: number) =>
      Math.max(lo + radius - v, 0, v - (hi - radius));
    const dx = d(p.x, min.x, max.x);
    const dy = d(p.y, min.y, max.y);
    const dz = d(p.z, min.z, max.z);
    return box(min, max)(p) && dx * dx + dy * dy + dz * dz <= radius * radius;
  };

export const union =
  (...solids: Solid[]): Solid =>
  (p) =>
    solids.some((s) => s(p));

export const intersect =
  (...solids: Solid[]): Solid =>
  (p) =>
    solids.every((s) => s(p));

export const subtract =
  (solid: Solid, ...holes: Solid[]): Solid =>
  (p) =>
    solid(p) && !holes.some((h) => h(p));

/** A grid of cubes being built, its colours a 1-based list. */
export class Sketch {
  readonly grid: Uint8Array;

  constructor(
    readonly size: VoxelSize,
    readonly colors: readonly string[],
  ) {
    this.grid = new Uint8Array(size.x * size.y * size.z);
  }

  #each(visit: (x: number, y: number, z: number, centre: Point) => void): void {
    for (let z = 0; z < this.size.z; z++) {
      for (let y = 0; y < this.size.y; y++) {
        for (let x = 0; x < this.size.x; x++)
          visit(x, y, z, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
      }
    }
  }

  #color(color: number): number {
    if (!Number.isInteger(color) || color < 1 || color > this.colors.length) {
      throw new Error(`Colour ${color} isn't one of the part's ${this.colors.length}`);
    }
    return color;
  }

  /** Fills every cube whose centre lies in `solid` with colour `color` (1-based). */
  fill(solid: Solid, color = 1): this {
    const index = this.#color(color);
    this.#each((x, y, z, centre) => {
      if (solid(centre)) this.grid[voxelIndex(this.size, x, y, z)] = index;
    });
    return this;
  }

  /** Recolours the filled cubes whose centre lies in `solid`. */
  paint(solid: Solid, color: number): this {
    const index = this.#color(color);
    this.#each((x, y, z, centre) => {
      const i = voxelIndex(this.size, x, y, z);
      if (this.grid[i] !== 0 && solid(centre)) this.grid[i] = index;
    });
    return this;
  }

  /** Empties every cube whose centre lies in `solid`. */
  carve(solid: Solid): this {
    this.#each((x, y, z, centre) => {
      if (solid(centre)) this.grid[voxelIndex(this.size, x, y, z)] = 0;
    });
    return this;
  }

  /** Sets one cube, or empties it with colour 0. */
  set(x: number, y: number, z: number, color: number): this {
    this.grid[voxelIndex(this.size, x, y, z)] = color === 0 ? 0 : this.#color(color);
    return this;
  }

  filled(x: number, y: number, z: number): boolean {
    return (
      x >= 0 &&
      y >= 0 &&
      z >= 0 &&
      x < this.size.x &&
      y < this.size.y &&
      z < this.size.z &&
      this.grid[voxelIndex(this.size, x, y, z)] !== 0
    );
  }

  /**
   * Recolours the filled cubes that show a face in direction `side` (an axis and a sign) and
   * whose centre lies in `where`: the outer shell on that side, e.g. a lighter top.
   */
  paintFacing(
    side: { axis: "x" | "y" | "z"; sign: 1 | -1 },
    color: number,
    where: Solid = () => true,
  ): this {
    const index = this.#color(color);
    const marks: number[] = [];
    this.#each((x, y, z, centre) => {
      if (!this.filled(x, y, z) || !where(centre)) return;
      const next = { x, y, z };
      next[side.axis] += side.sign;
      if (!this.filled(next.x, next.y, next.z)) marks.push(voxelIndex(this.size, x, y, z));
    });
    for (const i of marks) this.grid[i] = index;
    return this;
  }

  cubes(): VoxCubes {
    return { size: this.size, colors: [...this.colors], grid: this.grid };
  }
}
