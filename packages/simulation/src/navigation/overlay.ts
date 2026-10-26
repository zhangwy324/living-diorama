import type { Vec3 } from "@living-diorama/content-schema";
import type { WorldModel } from "../world/world-model";
import type { Navigation } from "./region-graph";
import { CellState, type RegionMask } from "./walkability";

// Static debug overlay data for one navigation profile (ADR 0007 §10). Like scene data, it is
// plain data resolved here, so the renderer draws it without interpreting masks or surfaces.

/** One mask cell on its region's surface. */
export interface NavigationCell {
  walkable: boolean;
  /** Surface points at the cell's corners, in order around it. */
  corners: [Vec3, Vec3, Vec3, Vec3];
}

export interface NavigationRegion {
  regionId: string;
  /** A walkable spot near the middle of the region's largest walkable area, for the graph node. */
  anchor: Vec3;
  /** Every cell with a surface, except those another region covers. */
  cells: NavigationCell[];
}

export interface NavigationPortal {
  connectionId: string;
  from: string;
  to: string;
  bidirectional: boolean;
  /** The portal segment on the `from` region's surface. */
  a: Vec3;
  b: Vec3;
  usable: boolean;
  /** Why the portal is unusable for this profile. */
  reason?: string;
}

export interface NavigationOverlay {
  profileKey: string;
  regions: NavigationRegion[];
  portals: NavigationPortal[];
}

function regionCells(mask: RegionMask): NavigationCell[] {
  const { surface } = mask.region;
  const half = mask.cellSize / 2;
  const cells: NavigationCell[] = [];
  for (let cell = 0; cell < mask.states.length; cell++) {
    const state = mask.state(cell);
    const y = mask.height(cell);
    if (state === CellState.outside || state === CellState.covered || Number.isNaN(y)) continue;
    const { x, z } = mask.center(cell);
    // Corners off the surface (at a deck's edge) take the centre height.
    const corner = (dx: number, dz: number): Vec3 => ({
      x: x + dx,
      y: surface.heightAt(x + dx, z + dz) ?? y,
      z: z + dz,
    });
    cells.push({
      walkable: state === CellState.walkable,
      corners: [corner(-half, -half), corner(half, -half), corner(half, half), corner(-half, half)],
    });
  }
  return cells;
}

/** The walkable cell closest to the middle of the largest walkable area, else of any surface. */
function regionAnchor(mask: RegionMask): Vec3 | undefined {
  const [largest] = mask.components();
  const candidates =
    largest ?? [...mask.heights.keys()].filter((cell) => !Number.isNaN(mask.height(cell)));
  const centers = candidates.map((cell) => ({ cell, ...mask.center(cell) }));
  const mx = centers.reduce((sum, c) => sum + c.x, 0) / centers.length;
  const mz = centers.reduce((sum, c) => sum + c.z, 0) / centers.length;
  let best: (typeof centers)[number] | undefined;
  for (const c of centers) {
    if (!best || Math.hypot(c.x - mx, c.z - mz) < Math.hypot(best.x - mx, best.z - mz)) best = c;
  }
  return best && { x: best.x, y: mask.height(best.cell), z: best.z };
}

/** Walkability, region graph nodes and portals of one navigation profile. */
export function describeNavigation(model: WorldModel, navigation: Navigation): NavigationOverlay {
  const regions: NavigationRegion[] = [];
  for (const [regionId, mask] of navigation.masks) {
    const anchor = regionAnchor(mask);
    if (anchor) regions.push({ regionId, anchor, cells: regionCells(mask) });
  }
  const portals = model.connections.map((connection): NavigationPortal => {
    const surface = (x: number, z: number) =>
      model.regions.get(connection.from)?.surface.heightAt(x, z) ??
      model.regions.get(connection.to)?.surface.heightAt(x, z) ??
      0;
    const { a, b } = connection.portal;
    const check = navigation.portals.get(connection.id);
    return {
      connectionId: connection.id,
      from: connection.from,
      to: connection.to,
      bidirectional: connection.bidirectional,
      a: { x: a.x, y: surface(a.x, a.z), z: a.z },
      b: { x: b.x, y: surface(b.x, b.z), z: b.z },
      usable: check?.usable ?? false,
      ...(check && !check.usable ? { reason: `${check.reason}: ${check.detail}` } : {}),
    };
  });
  return { profileKey: navigation.profile.key, regions, portals };
}
