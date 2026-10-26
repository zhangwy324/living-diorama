import type {
  MaterialZones,
  Portal,
  PropPlacement,
  RegionKind,
  Vec3,
  WorldBounds,
} from "@living-diorama/content-schema";
import { pointInPolygon, projectOnSegment } from "./geometry";
import type { SurfaceMesh } from "./surfaces";
import type { WorldModel } from "./world-model";

/**
 * Static world geometry for the renderer, resolved from the world model so the renderer never
 * interprets surface types or parameters. Plain data, so it can cross the worker boundary.
 */
export interface SceneData {
  bounds: WorldBounds;
  terrain: {
    columns: number;
    rows: number;
    cellSize: number;
    heights: number[];
    /** Palette colour (`#rrggbb`) per sample, same layout as `heights`. */
    colors: string[];
  };
  /** Every region surface that is not already drawn by the terrain mesh, e.g. water and decks. */
  surfaces: {
    regionId: string;
    kind: RegionKind;
    /** Placement ID when a structure contributed the region. */
    structureId?: string;
    mesh: SurfaceMesh;
    /**
     * For structure surfaces: the mesh's rim edges that no portal of the region covers, i.e.
     * where a creature could step off. The renderer draws railings along them (ADR 0007 §3).
     */
    openEdges?: [Vec3, Vec3][];
  }[];
  /**
   * Height of the water standing above the terrain at each edge sample of the world, for drawing
   * the water's cross-section on the diorama's sides. NaN where there is none. Order: north edge
   * west→east, then south edge, west edge north→south, east edge.
   */
  edgeWater: { north: number[]; south: number[]; west: number[]; east: number[] };
  props: PropPlacement[];
  spawnPoints: Vec3[];
}

/** How far a rim vertex may lie from a portal and still count as on it, in metres. */
const PORTAL_TOLERANCE = 0.05;

/** Rim edges of a surface mesh (edges of only one triangle) that do not lie along any portal. */
export function openEdges(mesh: SurfaceMesh, portals: readonly Portal[]): [Vec3, Vec3][] {
  const vertex = (i: number): Vec3 => ({
    x: mesh.positions[i * 3] ?? 0,
    y: mesh.positions[i * 3 + 1] ?? 0,
    z: mesh.positions[i * 3 + 2] ?? 0,
  });
  const uses = new Map<string, { a: number; b: number; count: number }>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    for (let n = 0; n < 3; n++) {
      const a = mesh.indices[t + n] ?? 0;
      const b = mesh.indices[t + ((n + 1) % 3)] ?? 0;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const edge = uses.get(key) ?? { a, b, count: 0 };
      edge.count++;
      uses.set(key, edge);
    }
  }
  const onPortal = (p: Vec3) =>
    portals.some(
      (portal) => projectOnSegment(p.x, p.z, portal.a, portal.b).distance <= PORTAL_TOLERANCE,
    );
  return [...uses.values()]
    .filter((e) => e.count === 1)
    .map((e): [Vec3, Vec3] => [vertex(e.a), vertex(e.b)])
    .filter(([a, b]) => !(onPortal(a) && onPortal(b)));
}

function sampleColors(materials: MaterialZones, count: number): string[] {
  const fallback = materials.palette[0]?.color ?? "#ff00ff";
  if (materials.indices.source !== "inline") return Array<string>(count).fill(fallback);
  const { values } = materials.indices;
  return Array.from(
    { length: count },
    (_, k) => materials.palette[values[k] ?? 0]?.color ?? fallback,
  );
}

export function describeScene(model: WorldModel): SceneData {
  const { terrain, bounds, definition } = model;
  const regions = [...model.regions.values()];
  const water = regions.filter((r) => r.kind === "water");

  const waterAt = (x: number, z: number) => {
    const ground = terrain.heightAt(x, z);
    let top = NaN;
    for (const r of water) {
      if (!pointInPolygon(x, z, r.footprint)) continue;
      const y = r.surface.heightAt(x, z);
      if (y !== undefined && y > ground && !(y <= top)) top = y;
    }
    return top;
  };
  // Nudge samples just inside the bounds so edge points are inside the footprints.
  const inset = 1e-6;
  const along = (count: number, at: (k: number) => [number, number]) =>
    Array.from({ length: count }, (_, k) => waterAt(...at(k)));
  const xAt = (i: number) =>
    Math.min(
      bounds.max.x - inset,
      Math.max(bounds.min.x + inset, bounds.min.x + i * terrain.cellSize),
    );
  const zAt = (j: number) =>
    Math.min(
      bounds.max.z - inset,
      Math.max(bounds.min.z + inset, bounds.min.z + j * terrain.cellSize),
    );

  return {
    bounds,
    terrain: {
      columns: terrain.columns,
      rows: terrain.rows,
      cellSize: terrain.cellSize,
      heights: [...terrain.heights],
      colors: sampleColors(definition.terrain.materials, terrain.columns * terrain.rows),
    },
    surfaces: regions.flatMap((region) => {
      const mesh = region.surface.mesh(region.footprint);
      if (!mesh) return [];
      if (region.structureId === undefined)
        return [{ regionId: region.id, kind: region.kind, mesh }];
      const portals = model.connections
        .filter((c) => c.from === region.id || c.to === region.id)
        .map((c) => c.portal);
      return [
        {
          regionId: region.id,
          kind: region.kind,
          structureId: region.structureId,
          mesh,
          openEdges: openEdges(mesh, portals),
        },
      ];
    }),
    edgeWater: {
      north: along(terrain.columns, (i) => [xAt(i), bounds.min.z + inset]),
      south: along(terrain.columns, (i) => [xAt(i), bounds.max.z - inset]),
      west: along(terrain.rows, (j) => [bounds.min.x + inset, zAt(j)]),
      east: along(terrain.rows, (j) => [bounds.max.x - inset, zAt(j)]),
    },
    props: [...model.props],
    spawnPoints: definition.spawnPoints.flatMap((s) => {
      const y = model.regions
        .get(s.position.regionId)
        ?.surface.heightAt(s.position.x, s.position.z);
      return y === undefined ? [] : [{ x: s.position.x, y, z: s.position.z }];
    }),
  };
}
