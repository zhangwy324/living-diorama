import { WORLD_TOLERANCES } from "@living-diorama/content-schema";
import { projectOnSegment } from "../world/geometry";
import type { ConnectionModel, WorldModel } from "../world/world-model";
import type { NavProfile } from "./profile";
import { buildRegionMask, CellState, type RegionMask } from "./walkability";

export type PortalCheck =
  | { usable: true }
  | {
      usable: false;
      reason: "missing_capability" | "no_walkable_side" | "step_too_high";
      detail: string;
    };

/** Region masks and the capability-filtered region graph for one navigation profile. */
export interface Navigation {
  profile: NavProfile;
  masks: ReadonlyMap<string, RegionMask>;
  portals: ReadonlyMap<string, PortalCheck>;
  /** Regions reachable from `regionId` through usable connections, including itself. */
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
  return {
    profile,
    masks,
    portals,
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

/** Distance from (x, z) to the portal segment of `connection`. */
export function distanceToPortal(connection: ConnectionModel, x: number, z: number): number {
  return projectOnSegment(x, z, connection.portal.a, connection.portal.b).distance;
}
