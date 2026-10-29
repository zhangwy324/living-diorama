import { WORLD_TOLERANCES, type RegionKind, type Vec2 } from "@living-diorama/content-schema";
import { projectOnSegment } from "../world/geometry";
import type { ConnectionModel, WorldModel } from "../world/world-model";
import type { NavProfile } from "./profile";
import { buildRegionMask, CellState, type RegionMask } from "./walkability";

export type PortalCheck =
  | { usable: true }
  | {
      usable: false;
      /**
       * `not_applicable`: a side is in a region kind the profile has no locomotion for, so the
       * connection is not for it, like one needing a capability it lacks (ADR 0020 §5).
       */
      reason: "missing_capability" | "not_applicable" | "no_walkable_side" | "step_too_high";
      detail: string;
    };

/** Two edge-adjacent walkable cells, one in each of two regions, with their centres. */
export interface CellPair {
  fromCell: number;
  toCell: number;
  from: Vec2;
  to: Vec2;
}

/**
 * The derived way from a land region into a water region for a profile that can move in both
 * (ADR 0020 §4): every walkable cell of the land region edge-adjacent to a walkable cell of the
 * water region, within a step of its surface. One-way: out of the water is only by a connection.
 */
export interface WaterEntry {
  fromRegionId: string;
  toRegionId: string;
  pairs: readonly CellPair[];
}

/** Region masks and the capability-filtered region graph for one navigation profile. */
export interface Navigation {
  profile: NavProfile;
  masks: ReadonlyMap<string, RegionMask>;
  portals: ReadonlyMap<string, PortalCheck>;
  /** The derived water entries, one per land and water region pair that has any. */
  entries: readonly WaterEntry[];
  /**
   * Regions linked to `regionId` through usable connections and water entries, including itself,
   * following their directions. Region-level only: a region may split into areas a creature
   * can't cross (`Pathfinder.reachableCells`).
   */
  reachableRegions(regionId: string): Set<string>;
}

function walkableNear(mask: RegionMask, x: number, z: number, distance: number): boolean {
  const reach = Math.ceil(distance / mask.cellSize) + 1;
  const ci = Math.floor((x - mask.originX) / mask.cellSize) - mask.i0;
  const cj = Math.floor((z - mask.originZ) / mask.cellSize) - mask.j0;
  for (let j = cj - reach; j <= cj + reach; j++) {
    for (let i = ci - reach; i <= ci + reach; i++) {
      if (i < 0 || j < 0 || i >= mask.columns || j >= mask.rows) continue;
      const cell = j * mask.columns + i;
      if (mask.states[cell] !== CellState.walkable) continue;
      const c = mask.center(cell);
      if (Math.hypot(c.x - x, c.z - z) <= distance) return true;
    }
  }
  return false;
}

/**
 * A portal is usable when the profile has every required capability and, somewhere along the
 * portal, both sides have walkable cells within one cell and the surfaces meet within the step
 * height.
 */
function checkPortal(
  connection: ConnectionModel,
  world: WorldModel,
  masks: ReadonlyMap<string, RegionMask>,
  profile: NavProfile,
): PortalCheck {
  const missing = connection.requiredCapabilities.filter((c) => !profile.capabilities.has(c));
  if (missing.length > 0) {
    return { usable: false, reason: "missing_capability", detail: `needs ${missing.join(", ")}` };
  }
  const from = masks.get(connection.from);
  const to = masks.get(connection.to);
  if (!from || !to) {
    return { usable: false, reason: "no_walkable_side", detail: "it joins an unknown region" };
  }
  const foreign = [from, to].find((m) => !profile.maxSlopeByKind.has(m.region.kind));
  if (foreign) {
    return {
      usable: false,
      reason: "not_applicable",
      detail: `it joins a ${foreign.region.kind} region, which the profile can't move in`,
    };
  }
  const { a, b } = connection.portal;
  const cs = world.terrain.cellSize;
  const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (cs / 2)));
  let sidesFound = false;
  let worstStep = Infinity;
  for (let k = 0; k <= steps; k++) {
    const x = a.x + ((b.x - a.x) * k) / steps;
    const z = a.z + ((b.z - a.z) * k) / steps;
    if (!walkableNear(from, x, z, cs) || !walkableNear(to, x, z, cs)) continue;
    sidesFound = true;
    const hFrom = from.region.surface.heightAt(x, z);
    const hTo = to.region.surface.heightAt(x, z);
    if (hFrom === undefined || hTo === undefined) continue;
    const step = Math.abs(hFrom - hTo);
    if (step <= WORLD_TOLERANCES.maxStepHeight) return { usable: true };
    worstStep = Math.min(worstStep, step);
  }
  return sidesFound
    ? {
        usable: false,
        reason: "step_too_high",
        detail: `the surfaces meet ${Number.isFinite(worstStep) ? `${worstStep.toFixed(2)} m` : "nowhere"} apart (max ${WORLD_TOLERANCES.maxStepHeight} m)`,
      }
    : {
        usable: false,
        reason: "no_walkable_side",
        detail: "no point along the portal has walkable cells on both sides",
      };
}

export function buildNavigation(world: WorldModel, profile: NavProfile): Navigation {
  const masks = new Map<string, RegionMask>();
  for (const region of world.regions.values()) {
    masks.set(region.id, buildRegionMask(world, region, profile));
  }
  const portals = new Map<string, PortalCheck>();
  const edges = new Map<string, Set<string>>();
  const link = (from: string, to: string) => {
    let set = edges.get(from);
    if (!set) edges.set(from, (set = new Set()));
    set.add(to);
  };
  for (const connection of world.connections) {
    const check = checkPortal(connection, world, masks, profile);
    portals.set(connection.id, check);
    if (!check.usable) continue;
    link(connection.from, connection.to);
    if (connection.bidirectional) link(connection.to, connection.from);
  }
  const entries = waterEntries(masks, profile);
  for (const entry of entries) link(entry.fromRegionId, entry.toRegionId);
  return {
    profile,
    masks,
    portals,
    entries,
    reachableRegions(regionId) {
      const seen = new Set([regionId]);
      const queue = [regionId];
      // Iterating while pushing visits the appended regions too.
      for (const current of queue) {
        for (const next of edges.get(current) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
      return seen;
    },
  };
}

/** Whether moving from a region of kind `from` into one of kind `to` is a derived water entry. */
export function isWaterEntry(from: RegionKind, to: RegionKind): boolean {
  return from !== "water" && to === "water";
}

/**
 * Whether two edge-adjacent walkable cells, one in a region of each mask, are a derived water
 * entry from `from` into `to`: land into water, within a step (ADR 0020 §4).
 */
export function isWaterEntryPair(
  from: RegionMask,
  fromCell: number,
  to: RegionMask,
  toCell: number,
) {
  return (
    isWaterEntry(from.region.kind, to.region.kind) &&
    from.state(fromCell) === CellState.walkable &&
    to.state(toCell) === CellState.walkable &&
    Math.abs(from.height(fromCell) - to.height(toCell)) <= WORLD_TOLERANCES.maxStepHeight
  );
}

/** Every derived water entry of a profile; none unless it can move on land and in water. */
function waterEntries(masks: ReadonlyMap<string, RegionMask>, profile: NavProfile): WaterEntry[] {
  if (!profile.maxSlopeByKind.has("water")) return [];
  const all = [...masks.values()];
  const entries: WaterEntry[] = [];
  for (const land of all) {
    if (land.region.kind === "water" || !profile.maxSlopeByKind.has(land.region.kind)) continue;
    for (const water of all) {
      if (!isWaterEntry(land.region.kind, water.region.kind)) continue;
      const pairs = adjacentPairs(land, water);
      if (pairs.length > 0) {
        entries.push({ fromRegionId: land.region.id, toRegionId: water.region.id, pairs });
      }
    }
  }
  return entries;
}

/** Edge-adjacent pairs of cells from `a` into `b` that are a water entry, in cell order. */
function adjacentPairs(a: RegionMask, b: RegionMask): CellPair[] {
  const cs = a.cellSize;
  const { box } = b.region;
  const pairs: CellPair[] = [];
  for (let cell = 0; cell < a.states.length; cell++) {
    if (a.states[cell] !== CellState.walkable) continue;
    const c = a.center(cell);
    if (c.x < box.minX - cs || c.x > box.maxX + cs || c.z < box.minZ - cs || c.z > box.maxZ + cs)
      continue;
    for (const [dx, dz] of EDGE_NEIGHBOURS) {
      const toCell = b.cellAt(c.x + dx * cs, c.z + dz * cs);
      if (toCell === -1 || !isWaterEntryPair(a, cell, b, toCell)) continue;
      pairs.push({ fromCell: cell, toCell, from: c, to: b.center(toCell) });
    }
  }
  return pairs;
}

const EDGE_NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Distance from (x, z) to the portal segment of `connection`. */
export function distanceToPortal(connection: ConnectionModel, x: number, z: number): number {
  return projectOnSegment(x, z, connection.portal.a, connection.portal.b).distance;
}
