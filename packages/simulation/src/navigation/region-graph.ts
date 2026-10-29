import { WORLD_TOLERANCES, type RegionKind, type Vec2 } from "@living-diorama/content-schema";
import { pointInPolygon, polygonEdges, projectOnSegment } from "../world/geometry";
import type { ConnectionModel, RegionModel, WorldModel } from "../world/world-model";
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
  const banks = findBanks(world, masks, profile);
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
function findBanks(
  world: WorldModel,
  masks: ReadonlyMap<string, RegionMask>,
  profile: NavProfile,
): Bank[] {
  if (!profile.maxSlopeByKind.has("water")) return [];
  const all = [...masks.values()];
  const raised = raisedSurfaces(world);
  const banks: Bank[] = [];
  for (const land of all) {
    if (land.region.kind === "water" || !profile.maxSlopeByKind.has(land.region.kind)) continue;
    for (const water of all) {
      if (water.region.kind !== "water" || water.walkableCount === 0) continue;
      const pairs = bankPairs(land, water, bankReach(profile), (a, b) =>
        isJumpClear(world, profile, a, b, raised),
      );
      if (pairs.length > 0) {
        banks.push({ landRegionId: land.region.id, waterRegionId: water.region.id, pairs });
      }
    }
  }
  return banks;
}

/** One end of a jump: a point and the surface height there. */
interface JumpEnd {
  x: number;
  z: number;
  y: number;
}

/** Jumps are checked at points this far apart, in metres, along the straight line. */
const JUMP_SAMPLE_SPACING = 0.1;

/**
 * How far, in metres, a jump keeps its body (the creature's radius) from a raised surface's
 * footprint, at both ends and along its line (#132): room for the deck's slab and posts, which the
 * renderer draws at the footprint's edge, so a creature never lands against or under a bridge.
 */
export const JUMP_STRUCTURE_MARGIN = 0.25;

/**
 * How deep, in metres, a raised surface's underside may lie below the surface itself, for the
 * jump line check (#132): the renderer draws a deck as a slab this thick below its walkable
 * surface (`DECK_THICKNESS` in `packages/renderer/src/world-meshes.ts`). Change both together.
 */
export const JUMP_DECK_DEPTH = 0.15;

/**
 * The regions with a raised surface, such as a bridge deck: not water, and with a surface off the
 * ground somewhere in the footprint, sampled at its corners and on a grid a terrain cell apart. A
 * region whose surface is the ground everywhere is the jump's ground check's.
 *
 * Known gaps, to revisit: "off the ground anywhere" also catches a flat land region set partly
 * into a slope, whose whole footprint then keeps jumps away; and any kind but water counts, so
 * a region of a kind nothing walks on (air, say) does too.
 */
export function raisedSurfaces(world: WorldModel): RegionModel[] {
  const eps = WORLD_TOLERANCES.surfaceEpsilon;
  const { terrain } = world;
  const cs = terrain.cellSize;
  const offGround = (region: RegionModel, x: number, z: number) => {
    const y = region.surface.heightAt(x, z);
    return y !== undefined && Math.abs(y - terrain.heightAt(x, z)) > eps;
  };
  return [...world.regions.values()].filter((region) => {
    if (region.kind === "water") return false;
    if (region.footprint.some((p) => offGround(region, p.x, p.z))) return true;
    const { box } = region;
    for (let z = (Math.floor(box.minZ / cs) + 0.5) * cs; z <= box.maxZ; z += cs) {
      for (let x = (Math.floor(box.minX / cs) + 0.5) * cs; x <= box.maxX; x += cs) {
        if (pointInPolygon(x, z, region.footprint) && offGround(region, x, z)) return true;
      }
    }
    return false;
  });
}

/** The point of `region`'s footprint nearest (x, z) and its distance: (x, z) itself if inside. */
function nearestFootprintPoint(region: RegionModel, x: number, z: number) {
  if (pointInPolygon(x, z, region.footprint)) return { x, z, distance: 0 };
  let best = { x, z, distance: Infinity };
  for (const [a, b] of polygonEdges(region.footprint)) {
    const { t, distance } = projectOnSegment(x, z, a, b);
    if (distance < best.distance) {
      best = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, distance };
    }
  }
  return best;
}

/**
 * Whether a jump between two ends is clear for a creature of this profile (ADR 0020 §4, #132).
 * Along the straight line, no prop's block radius comes within the creature's radius and the
 * ground rises no more than a step above the higher end. Raised surfaces (`raisedSurfaces`, a
 * bridge deck, say) are kept the creature's radius plus `JUMP_STRUCTURE_MARGIN` away: from either
 * end at any height, so it never takes off or lands on a deck, under one or against its side;
 * and from the line where the surface lies above the lower end and its underside
 * (`JUMP_DECK_DEPTH` below it) below the top of the creature's arc: its height above the higher
 * end plus its radius, the most the renderer's arc rises. A deck higher than that may span a jump.
 */
export function isJumpClear(
  world: WorldModel,
  profile: NavProfile,
  a: JumpEnd,
  b: JumpEnd,
  raised: readonly RegionModel[] = raisedSurfaces(world),
) {
  const eps = WORLD_TOLERANCES.surfaceEpsilon;
  const low = Math.min(a.y, b.y);
  const high = Math.max(a.y, b.y);
  const top = high + profile.radius + profile.height;
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(length / JUMP_SAMPLE_SPACING));
  const keep = profile.radius + JUMP_STRUCTURE_MARGIN;
  const near = raised.filter(
    ({ box }) =>
      box.maxX > Math.min(a.x, b.x) - keep &&
      box.minX < Math.max(a.x, b.x) + keep &&
      box.maxZ > Math.min(a.z, b.z) - keep &&
      box.minZ < Math.max(a.z, b.z) + keep,
  );
  for (const end of [a, b]) {
    if (near.some((r) => nearestFootprintPoint(r, end.x, end.z).distance < keep)) return false;
  }
  for (let k = 0; k <= steps; k++) {
    const x = a.x + ((b.x - a.x) * k) / steps;
    const z = a.z + ((b.z - a.z) * k) / steps;
    for (const prop of world.props) {
      if (prop.blockRadius <= 0) continue;
      const { position } = prop.transform;
      if (Math.hypot(position.x - x, position.z - z) < prop.blockRadius + profile.radius) {
        return false;
      }
    }
    const ground = world.terrain.heightAt(x, z);
    if (ground > high + WORLD_TOLERANCES.maxStepHeight) return false;
    for (const region of near) {
      const point = nearestFootprintPoint(region, x, z);
      if (point.distance >= keep) continue;
      const y = region.surface.heightAt(point.x, point.z);
      // No surface known there, as beside a curved deck: it may be in the way.
      if (y === undefined) return false;
      if (Math.abs(y - world.terrain.heightAt(point.x, point.z)) <= eps) continue;
      // Its underside, the deck's slab, as well as its surface may be in the arc's way.
      if (y > low - eps && y - JUMP_DECK_DEPTH < top) return false;
    }
  }
  return true;
}

/**
 * For each walkable cell of `land`, the nearest walkable cell of `water` within `reach` that it
 * can jump to with the line between them `clear` (the first in cell order on a tie), in land
 * cell order.
 */
function bankPairs(
  land: RegionMask,
  water: RegionMask,
  reach: number,
  clear: (a: JumpEnd, b: JumpEnd) => boolean,
): BankPair[] {
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
    // Candidates nearest first (then in cell order); the first with a clear line wins.
    const candidates: { cell: number; distance: number }[] = [];
    for (let dj = -span; dj <= span; dj++) {
      for (let di = -span; di <= span; di++) {
        const distance = Math.hypot(di * cs, dj * cs);
        if (distance > reach + 1e-9) continue;
        const w = water.cellAt(c.x + di * cs, c.z + dj * cs);
        if (w === -1 || !isBankPair(land, cell, water, w)) continue;
        candidates.push({ cell: w, distance });
      }
    }
    candidates.sort((p, q) => p.distance - q.distance || p.cell - q.cell);
    const from = { ...c, y: land.height(cell) };
    const best = candidates.find((w) =>
      clear(from, { ...water.center(w.cell), y: water.height(w.cell) }),
    );
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
