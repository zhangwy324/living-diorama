import {
  DeckSurfaceParamsSchema,
  FlatSurfaceParamsSchema,
  HeightfieldSurfaceParamsSchema,
  validate,
  type Schema,
  type Vec2,
  type Vec3,
} from "@living-diorama/content-schema";
import type { SurfaceType } from "@living-diorama/extension-api";
import { projectOnSegment, triangulate } from "./geometry";
import type { Terrain } from "./terrain";

/** Triangles in world space: `positions` is x, y, z per vertex. */
export interface SurfaceMesh {
  positions: number[];
  indices: number[];
}

/** A walkable (or swimmable) surface a region's positions resolve against. */
export interface Surface {
  /** World Y at (x, z), or undefined where (x, z) is off this surface. */
  heightAt(x: number, z: number): number | undefined;
  /** Angle between the surface normal and +Y in radians, or undefined off the surface. */
  slopeAt(x: number, z: number): number | undefined;
  /** Horizontal distance to the surface's own side edge; `Infinity` for unbounded surfaces. */
  edgeDistance(x: number, z: number): number;
  /** Geometry to draw over `footprint`, or undefined when the terrain mesh already shows it. */
  mesh(footprint: readonly Vec2[]): SurfaceMesh | undefined;
}

export interface SurfaceContext {
  terrain: Terrain;
}

/** A surface type with its simulation implementation, registered in the `surfaces` registry. */
export interface SurfaceProvider extends SurfaceType {
  create(params: unknown, context: SurfaceContext): Surface;
}

export function isSurfaceProvider(entry: SurfaceType): entry is SurfaceProvider {
  return typeof (entry as Partial<SurfaceProvider>).create === "function";
}

function parse<T>(schema: Schema<T>, params: unknown): T {
  const result = validate(schema, params);
  // Params were validated during reference resolution; failing here is a programming error.
  if (!result.ok) throw new Error(`Invalid surface params: ${result.diagnostics[0]?.message}`);
  return result.value;
}

class HeightfieldSurface implements Surface {
  constructor(readonly terrain: Terrain) {}
  heightAt(x: number, z: number) {
    return this.terrain.heightAt(x, z);
  }
  slopeAt(x: number, z: number) {
    return this.terrain.slopeAt(x, z);
  }
  edgeDistance() {
    return Infinity;
  }
  mesh() {
    return undefined;
  }
}

class FlatSurface implements Surface {
  constructor(readonly y: number) {}
  heightAt() {
    return this.y;
  }
  slopeAt() {
    return 0;
  }
  edgeDistance() {
    return Infinity;
  }
  mesh(footprint: readonly Vec2[]): SurfaceMesh {
    return {
      positions: footprint.flatMap((p) => [p.x, this.y, p.z]),
      indices: triangulate(footprint),
    };
  }
}

/** A strip of `width` along a centerline. It ends flat at the first and last points. */
class DeckSurface implements Surface {
  readonly #segments: { a: Vec3; b: Vec3 }[];

  constructor(
    readonly centerline: readonly Vec3[],
    readonly width: number,
  ) {
    this.#segments = centerline.slice(1).map((b, i) => ({ a: centerline[i] ?? b, b }));
  }

  #nearest(x: number, z: number) {
    let best: { a: Vec3; b: Vec3; t: number; distance: number } | undefined;
    const last = this.#segments.length - 1;
    for (const [s, { a, b }] of this.#segments.entries()) {
      const { t, distance } = projectOnSegment(x, z, a, b);
      // Beyond the deck's two ends is off the surface, not a rounded cap.
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const along = ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1);
      if ((s === 0 && along < -1e-9) || (s === last && along > 1 + 1e-9)) continue;
      if (!best || distance < best.distance) best = { a, b, t, distance };
    }
    return best && best.distance <= this.width / 2 + 1e-9 ? best : undefined;
  }

  heightAt(x: number, z: number) {
    const hit = this.#nearest(x, z);
    return hit && hit.a.y + hit.t * (hit.b.y - hit.a.y);
  }

  slopeAt(x: number, z: number) {
    const hit = this.#nearest(x, z);
    if (!hit) return undefined;
    const { a, b } = hit;
    return Math.atan2(Math.abs(b.y - a.y), Math.hypot(b.x - a.x, b.z - a.z));
  }

  edgeDistance(x: number, z: number) {
    const hit = this.#nearest(x, z);
    return hit ? this.width / 2 - hit.distance : -Infinity;
  }

  mesh(): SurfaceMesh {
    // Two vertices per centerline point, offset sideways by the averaged segment normals.
    const positions: number[] = [];
    const indices: number[] = [];
    const points = this.centerline;
    points.forEach((p, k) => {
      const prev = points[k - 1] ?? p;
      const next = points[k + 1] ?? p;
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const length = Math.hypot(dx, dz) || 1;
      const nx = (-dz / length) * (this.width / 2);
      const nz = (dx / length) * (this.width / 2);
      positions.push(p.x + nx, p.y, p.z + nz, p.x - nx, p.y, p.z - nz);
      if (k > 0) {
        const base = (k - 1) * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    });
    return { positions, indices };
  }
}

/** The core surface types (world-coordinates.md "Regions and region-relative positions"). */
export const coreSurfaces: readonly SurfaceProvider[] = [
  {
    id: "core:heightfield",
    version: "1.0.0",
    paramsSchema: HeightfieldSurfaceParamsSchema,
    create: (_params, { terrain }) => new HeightfieldSurface(terrain),
  },
  {
    id: "core:deck",
    version: "1.0.0",
    paramsSchema: DeckSurfaceParamsSchema,
    create: (params) => {
      const { centerline, width } = parse(DeckSurfaceParamsSchema, params);
      return new DeckSurface(centerline, width);
    },
  },
  {
    id: "core:flat",
    version: "1.0.0",
    paramsSchema: FlatSurfaceParamsSchema,
    create: (params) => new FlatSurface(parse(FlatSurfaceParamsSchema, params).y),
  },
];
