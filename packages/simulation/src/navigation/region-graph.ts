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

/** A walkable land cell and a walkable water cell a creature can jump between, with centres. */
export interface BankPair {
  landCell: number;
  waterCell: number;
  land: Vec2;
  water: Vec2;
}

/**
 * The derived bank between a land region and a water region for a profile that can move in both
 * (ADR 0020 §4, as revised by the owner): the creature jumps in or climbs out between each walkable
 * land cell and the nearest walkable water cell within `bankReach` of it whose surface is within
 * `maxBankJumpHeight`. Two-way, and needs no connection.
 */
export interface Bank {
  landRegionId: string;
  waterRegionId: string;
  /** One per land cell that has a water cell in reach, in land cell order. */
  pairs: readonly BankPair[];
}

/** Region masks and the capability-filtered region graph for one navigation profile. */
export interface Navigation {
  profile: NavProfile;
  masks: ReadonlyMap<string, RegionMask>;
  portals: ReadonlyMap<string, PortalCheck>;
  /** The derived banks, one per land and water region pair that has any. */
  banks: readonly Bank[];
  /**
   * Regions linked to `regionId` through usable connections, in the directions they allow, and
   * banks, both ways, including itself. Region-level only: a region may split into areas a creature
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
  const banks = findBanks(masks, profile);
  for (const bank of banks) {
    link(bank.landRegionId, bank.waterRegionId);
    link(bank.waterRegionId, bank.landRegionId);
  }
  return {
    profile,
    masks,
    portals,
    banks,
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

/** Whether one of two region kinds is water and the other not, so a bank can join them. */
export function isBankKinds(a: RegionKind, b: RegionKind): boolean {
  return (a === "water") !== (b === "water");
}

/**
 * Whether two walkable cells, one in a region of each mask, one on land and one in water, have
 * surfaces close enough in height to jump between (ADR 0020 §4). Horizontal reach is the
 * caller's to check (`bankReach`).
 */
export function isBankPair(a: RegionMask, aCell: number, b: RegionMask, bCell: number): boolean {
  return (
    isBankKinds(a.region.kind, b.region.kind) &&
    a.state(aCell) === CellState.walkable &&
    b.state(bCell) === CellState.walkable &&
    Math.abs(a.height(aCell) - b.height(bCell)) <= WORLD_TOLERANCES.maxBankJumpHeight
  );
}

/**
 * How far apart, horizontally, the centres of a land cell and a water cell may be for a creature
 * of this profile to jump between them: `maxBankJumpGap` between its body's edges on either side,
 * so its radius twice over, since clearance keeps its walkable cells that far from a steep bank
 * on land and from the bank in the water.
 */
export function bankReach(profile: NavProfile): number {
  return 2 * profile.radius + WORLD_TOLERANCES.maxBankJumpGap;
}

/** Every derived bank of a profile; none unless it can move on land and in water. */
function findBanks(masks: ReadonlyMap<string, RegionMask>, profile: NavProfile): Bank[] {
  if (!profile.maxSlopeByKind.has("water")) return [];
  const all = [...masks.values()];
  const banks: Bank[] = [];
  for (const land of all) {
    if (land.region.kind === "water" || !profile.maxSlopeByKind.has(land.region.kind)) continue;
    for (const water of all) {
      if (water.region.kind !== "water" || water.walkableCount === 0) continue;
      const pairs = bankPairs(land, water, bankReach(profile));
      if (pairs.length > 0) {
        banks.push({ landRegionId: land.region.id, waterRegionId: water.region.id, pairs });
      }
    }
  }
  return banks;
}

/**
 * For each walkable cell of `land`, the nearest walkable cell of `water` within `reach` that it
 * can jump to (the first in cell order on a tie), in land cell order.
 */
function bankPairs(land: RegionMask, water: RegionMask, reach: number): BankPair[] {
  const cs = land.cellSize;
  const { box } = water.region;
  const span = Math.ceil(reach / cs);
  const pairs: BankPair[] = [];
  for (let cell = 0; cell < land.states.length; cell++) {
    if (land.states[cell] !== CellState.walkable) continue;
    const c = land.center(cell);
    if (
      c.x < box.minX - reach ||
      c.x > box.maxX + reach ||
      c.z < box.minZ - reach ||
      c.z > box.maxZ + reach
    ) {
      continue;
    }
    let best: { cell: number; distance: number } | undefined;
    for (let dj = -span; dj <= span; dj++) {
      for (let di = -span; di <= span; di++) {
        const distance = Math.hypot(di * cs, dj * cs);
        if (distance > reach + 1e-9) continue;
        const w = water.cellAt(c.x + di * cs, c.z + dj * cs);
        if (w === -1 || !isBankPair(land, cell, water, w)) continue;
        if (!best || distance < best.distance || (distance === best.distance && w < best.cell)) {
          best = { cell: w, distance };
        }
      }
    }
    if (best) {
      pairs.push({ landCell: cell, waterCell: best.cell, land: c, water: water.center(best.cell) });
    }
  }
  return pairs;
}

/** Distance from (x, z) to the portal segment of `connection`. */
export function distanceToPortal(connection: ConnectionModel, x: number, z: number): number {
  return projectOnSegment(x, z, connection.portal.a, connection.portal.b).distance;
}
