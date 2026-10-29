import { maxJumpClearance, WORLD_TOLERANCES, type Vec2 } from "@living-diorama/content-schema";
import {
  bankReach,
  CellState,
  isBankPair,
  JUMP_DECK_DEPTH,
  JUMP_STRUCTURE_MARGIN,
  projectOnSegment,
  RegionMask,
  type Bank,
  type BankPair,
  type NavProfile,
  type RegionModel,
  type WorldModel,
} from "@living-diorama/simulation";

// Test oracle: navigation building as it was before it was made faster, one cell and one
// point-in-polygon test at a time. The fast build must give exactly these masks and banks.
// Keep this as it is; it is the reference, not something to optimise.

function pointInPolygon(x: number, z: number, polygon: readonly Vec2[]): boolean {
  let inside = false;
  const edges = polygon.map((p, i) => [polygon[(i + polygon.length - 1) % polygon.length] ?? p, p]);
  for (const [b, a] of edges) {
    if (!a || !b) continue;
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

const isBaseBlocked = (s: number, canSwim: boolean) =>
  s === CellState.offSurface ||
  s === CellState.steep ||
  s === CellState.dry ||
  (s === CellState.submerged && !canSwim) ||
  s === CellState.noHeadroom;

export function referenceRegionMask(
  world: WorldModel,
  region: RegionModel,
  profile: NavProfile,
): RegionMask {
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

  const states = new Uint8Array(columns * rows);
  const heights = new Float64Array(columns * rows).fill(NaN);
  const mask = new RegionMask(region, i0, j0, columns, rows, cs, originX, originZ, states, heights);
  const maxSlope = profile.maxSlopeByKind.get(region.kind);
  const eps = WORLD_TOLERANCES.surfaceEpsilon;

  const others = [...world.regions.values()].filter((r) => r !== region);
  const covers = (r: RegionModel, x: number, z: number) =>
    x >= r.box.minX &&
    x <= r.box.maxX &&
    z >= r.box.minZ &&
    z <= r.box.maxZ &&
    pointInPolygon(x, z, r.footprint);
  const samples = (x: number, z: number) => {
    const d = cs * 0.49;
    return [
      { x, z },
      { x: x - d, z: z - d },
      { x: x + d, z: z - d },
      { x: x - d, z: z + d },
      { x: x + d, z: z + d },
    ];
  };
  const waters = others.filter((r) => r.kind === "water");
  const isUnder = (w: RegionModel, x: number, z: number) =>
    samples(x, z).some((p) => {
      if (!covers(w, p.x, p.z)) return false;
      const below = region.surface.heightAt(p.x, p.z);
      const above = w.surface.heightAt(p.x, p.z);
      return below !== undefined && above !== undefined && above > below + eps;
    });

  for (let cell = 0; cell < states.length; cell++) {
    const { x, z } = mask.center(cell);
    if (!pointInPolygon(x, z, region.footprint)) continue;
    if (maxSlope === undefined) {
      states[cell] = CellState.noLocomotion;
      continue;
    }
    const h = region.surface.heightAt(x, z);
    if (h === undefined) {
      states[cell] = CellState.offSurface;
      continue;
    }
    if (
      region.kind === "water" &&
      samples(x, z).some((p) => terrain.heightAt(p.x, p.z) >= h + eps)
    ) {
      states[cell] = CellState.dry;
      continue;
    }
    heights[cell] = h;
    const q = cs / 4;
    const slopes = [
      region.surface.slopeAt(x, z),
      region.surface.slopeAt(x + q, z - q),
      region.surface.slopeAt(x - q, z + q),
    ];
    if (slopes.some((s) => s !== undefined && s > maxSlope)) {
      states[cell] = CellState.steep;
      continue;
    }
    if (waters.some((w) => isUnder(w, x, z))) {
      states[cell] = CellState.submerged;
      continue;
    }
    let state: CellState = CellState.walkable;
    for (const other of others) {
      if (other.kind === "water" || !covers(other, x, z)) continue;
      const above = other.surface.heightAt(x, z);
      if (above === undefined || above <= h + eps) continue;
      if (above <= h + WORLD_TOLERANCES.maxStepHeight) {
        state = CellState.covered;
      } else if (above < h + profile.height) {
        state = CellState.noHeadroom;
        break;
      }
    }
    states[cell] = state;
  }

  const radius = profile.radius;
  const reach = Math.ceil((radius + cs / 2) / cs);
  const canSwim = profile.maxSlopeByKind.has("water");
  const blocked = Uint8Array.from(states, (s) => (isBaseBlocked(s, canSwim) ? 1 : 0));
  for (let cell = 0; cell < states.length; cell++) {
    if (states[cell] !== CellState.walkable) continue;
    const { x, z } = mask.center(cell);
    if (
      x - bounds.min.x < radius ||
      bounds.max.x - x < radius ||
      z - bounds.min.z < radius ||
      bounds.max.z - z < radius
    ) {
      states[cell] = CellState.worldEdge;
      continue;
    }
    if (
      world.props.some(
        (p) =>
          Math.hypot(p.transform.position.x - x, p.transform.position.z - z) <
          p.blockRadius + radius,
      )
    ) {
      states[cell] = CellState.prop;
      continue;
    }
    if (region.surface.edgeDistance(x, z) < radius) {
      states[cell] = CellState.tooClose;
      continue;
    }
    const i = cell % columns;
    const j = Math.floor(cell / columns);
    search: for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const ni = i + di;
        const nj = j + dj;
        if (ni < 0 || nj < 0 || ni >= columns || nj >= rows || !blocked[nj * columns + ni])
          continue;
        const dx = Math.max(0, Math.abs(di) * cs - cs / 2);
        const dz = Math.max(0, Math.abs(dj) * cs - cs / 2);
        if (Math.hypot(dx, dz) < radius) {
          states[cell] = CellState.tooClose;
          break search;
        }
      }
    }
  }
  return mask;
}

export function referenceRaisedSurfaces(world: WorldModel): RegionModel[] {
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

interface JumpEnd {
  x: number;
  z: number;
  y: number;
}

function nearestFootprintPoint(region: RegionModel, x: number, z: number) {
  if (pointInPolygon(x, z, region.footprint)) return { x, z, distance: 0 };
  let best = { x, z, distance: Infinity };
  const fp = region.footprint;
  for (const [i, b] of fp.entries()) {
    const a = fp[(i + fp.length - 1) % fp.length] ?? b;
    const { t, distance } = projectOnSegment(x, z, a, b);
    if (distance < best.distance) {
      best = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, distance };
    }
  }
  return best;
}

function referenceIsJumpClear(
  world: WorldModel,
  profile: NavProfile,
  a: JumpEnd,
  b: JumpEnd,
  raised: readonly RegionModel[],
) {
  const eps = WORLD_TOLERANCES.surfaceEpsilon;
  const low = Math.min(a.y, b.y);
  const high = Math.max(a.y, b.y);
  const top = high + maxJumpClearance(profile.radius) + profile.height;
  const length = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(1, Math.ceil(length / 0.1));
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
      if (y === undefined) return false;
      if (Math.abs(y - world.terrain.heightAt(point.x, point.z)) <= eps) continue;
      if (y > low - eps && y - JUMP_DECK_DEPTH < top) return false;
    }
  }
  return true;
}

function referenceBankPairs(
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

/** The banks of a profile, from masks built by `referenceRegionMask`. */
export function referenceBanks(
  world: WorldModel,
  masks: ReadonlyMap<string, RegionMask>,
  profile: NavProfile,
): Bank[] {
  if (!profile.maxSlopeByKind.has("water")) return [];
  const all = [...masks.values()];
  const raised = referenceRaisedSurfaces(world);
  const banks: Bank[] = [];
  for (const land of all) {
    if (land.region.kind === "water" || !profile.maxSlopeByKind.has(land.region.kind)) continue;
    for (const water of all) {
      if (water.region.kind !== "water" || water.walkableCount === 0) continue;
      const pairs = referenceBankPairs(land, water, bankReach(profile), (a, b) =>
        referenceIsJumpClear(world, profile, a, b, raised),
      );
      if (pairs.length > 0) {
        banks.push({ landRegionId: land.region.id, waterRegionId: water.region.id, pairs });
      }
    }
  }
  return banks;
}
