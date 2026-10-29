import { WORLD_TOLERANCES, type RegionPosition, type Vec2 } from "@living-diorama/content-schema";
import type { ConnectionModel, WorldModel } from "../world/world-model";
import { distanceField, findGridPath, pathLength } from "./grid-path";
import { distanceToPortal, type BankPair, type Navigation } from "./region-graph";
import { CellState, type RegionMask } from "./walkability";

// Hierarchical route planning (roadmap M3 task 5, ADR 0006). Each usable portal gets a few
// crossings: pairs of edge-adjacent walkable cells, one on each side. Their cells are the doors
// of a small graph whose in-region edge costs come from exact walking-distance fields, so the
// region-level search picks the truly shortest sequence of regions. Grid A* then fills in each
// region's leg.
//
// A region can split into several walkable areas for one profile, e.g. a rock that a large
// creature can't pass (ADR 0013), or land that only a detour through other regions joins. Areas
// are linked by the same crossings routes use. A route stays inside its region only when start
// and goal share an area; otherwise it takes the door graph like a route between regions, even
// when both ends are in one region. So what `reachableCells` returns is exactly what `findRoute`
// can reach.
//
// For a profile that moves on land and in water, derived banks (ADR 0020 §4) add crossings both
// ways between land and water, picked from the bank's cell pairs and spaced like a portal's. The
// graph stays directed for one-way connections.

/** Crossings on one portal are at least this far apart, in metres. */
const CROSSING_SPACING = 1;
/**
 * Crossings of one bank between the same two areas are at least this far apart, in metres. A
 * bank is long and has no portal to spread along, so they are sparser than a portal's; every
 * crossing is a door with a distance field of its own.
 */
const BANK_SPACING = 2;
/**
 * Extra cost of a jump across a bank, in metres of walking (#140), so a route between two places
 * on land crosses the water only when that is clearly shorter than a bridge: a trip there and out
 * again pays it twice, 24 m, more than swimming saves over the Hollow's bridge for nearly any trip.
 * It is the same on every jump, so it never changes which way a route into or out of the water
 * goes. Search cost only; a route's length stays the distance walked. Tuned on `pnpm soak:quick`.
 */
export const BANK_CROSSING_COST = 12;

/**
 * One way across a portal, from a walkable cell in one region into an adjacent one in the next,
 * or a jump across a bank between a land cell and a water cell up to `bankReach` apart.
 */
export interface Crossing {
  /** The connection crossed; absent for a bank. */
  connectionId?: string;
  fromRegionId: string;
  toRegionId: string;
  fromCell: number;
  toCell: number;
  /** Cell centres. The region changes halfway, on the shared cell edge. */
  from: Vec2;
  to: Vec2;
  /** Distance between the centres plus the connection's extra cost, or `BANK_CROSSING_COST`. */
  cost: number;
}

/** The part of a route inside one region. */
export interface RouteLeg {
  regionId: string;
  /** Smoothed waypoints; the first is the start or the entry, the last the goal or the exit. */
  points: Vec2[];
  /** How the route leaves this region; absent on the last leg. */
  exit?: Crossing;
}

export interface Route {
  legs: RouteLeg[];
  /** Horizontal walking distance in metres. */
  length: number;
}

export type RouteFailure = "start_not_walkable" | "goal_not_walkable" | "unreachable";

export type RouteResult =
  { ok: true; route: Route } | { ok: false; reason: RouteFailure; detail: string };

const doorKey = (regionId: string, cell: number) => `${regionId}#${cell}`;

/** Walkable cells per region, in cell order. */
export type ReachableCells = ReadonlyMap<string, readonly number[]>;

const NO_CELLS: ReachableCells = new Map();

/** Route planning for one navigation profile. Derived data is built lazily and cached. */
export class Pathfinder {
  readonly #crossings = new Map<string, Crossing[]>();
  readonly #fields = new Map<string, Float64Array>();
  /** Per region, the area (index into `components()`) of each cell, or -1. */
  readonly #areas = new Map<string, { ofCell: Int32Array; cells: number[][] }>();
  /** Per area key, the cells reachable from it. */
  readonly #reachable = new Map<string, ReachableCells>();
  /** Per region, every crossing leaving it (`#exits`). */
  readonly #exitsByRegion = new Map<string, readonly Crossing[]>();
  /** Per region, the crossings of the banks leaving it; built on first use. */
  #bankCrossings: Map<string, Crossing[]> | undefined;

  constructor(
    readonly world: WorldModel,
    readonly navigation: Navigation,
  ) {}

  /** The crossings of a connection in both usable directions; empty if it is unusable. */
  crossings(connection: ConnectionModel): readonly Crossing[] {
    let found = this.#crossings.get(connection.id);
    if (!found) {
      found = this.#buildCrossings(connection);
      this.#crossings.set(connection.id, found);
    }
    return found;
  }

  /**
   * The walkable cells a creature standing at `from` can reach, per region: its own area and
   * every area that crossings lead to. Empty if `from` is not walkable.
   */
  reachableCells(from: RegionPosition): ReachableCells {
    const start = this.#areaAt(from.regionId, from.x, from.z);
    if (start === undefined) return NO_CELLS;
    const key = areaKey(from.regionId, start);
    let found = this.#reachable.get(key);
    if (!found) {
      found = this.#flood(from.regionId, start);
      this.#reachable.set(key, found);
    }
    return found;
  }

  #regionAreas(regionId: string) {
    let areas = this.#areas.get(regionId);
    if (!areas) {
      const mask = this.navigation.masks.get(regionId);
      const cells = mask?.components() ?? [];
      const ofCell = new Int32Array(mask?.states.length ?? 0).fill(-1);
      cells.forEach((area, index) => {
        for (const cell of area) ofCell[cell] = index;
      });
      areas = { ofCell, cells };
      this.#areas.set(regionId, areas);
    }
    return areas;
  }

  #areaAt(regionId: string, x: number, z: number): number | undefined {
    const cell = this.navigation.masks.get(regionId)?.cellAt(x, z) ?? -1;
    const area = cell === -1 ? -1 : (this.#regionAreas(regionId).ofCell[cell] ?? -1);
    return area === -1 ? undefined : area;
  }

  #flood(regionId: string, start: number): ReachableCells {
    const seen = new Set([areaKey(regionId, start)]);
    const queue = [{ regionId, area: start }];
    // Iterating while pushing visits the appended areas too.
    for (const current of queue) {
      for (const exit of this.#exits(current.regionId)) {
        const { ofCell } = this.#regionAreas(current.regionId);
        if (ofCell[exit.fromCell] !== current.area) continue;
        const area = this.#regionAreas(exit.toRegionId).ofCell[exit.toCell] ?? -1;
        const key = areaKey(exit.toRegionId, area);
        if (area === -1 || seen.has(key)) continue;
        seen.add(key);
        queue.push({ regionId: exit.toRegionId, area });
      }
    }
    const reachable = new Map<string, number[]>();
    for (const { regionId: id, area } of queue) {
      const cells = this.#regionAreas(id).cells[area] ?? [];
      reachable.set(id, [...(reachable.get(id) ?? []), ...cells]);
    }
    // Cell order, so random picks don't depend on the order areas were found in.
    for (const cells of reachable.values()) cells.sort((a, b) => a - b);
    return reachable;
  }

  /**
   * Drops cached routing data for these regions and every connection touching them. For future
   * world edits (unused in v1); the walkability masks themselves come from `navigation`.
   */
  invalidateRegions(regionIds: Iterable<string>): void {
    const ids = new Set(regionIds);
    for (const connection of this.world.connections) {
      if (ids.has(connection.from) || ids.has(connection.to)) this.#crossings.delete(connection.id);
    }
    for (const key of [...this.#fields.keys()]) {
      if (ids.has(key.slice(0, key.lastIndexOf("#")))) this.#fields.delete(key);
    }
    for (const id of ids) this.#areas.delete(id);
    this.#reachable.clear();
    this.#bankCrossings = undefined;
    this.#exitsByRegion.clear();
  }

  findRoute(from: RegionPosition, to: RegionPosition): RouteResult {
    const startMask = this.navigation.masks.get(from.regionId);
    const goalMask = this.navigation.masks.get(to.regionId);
    const startCell = startMask?.cellAt(from.x, from.z) ?? -1;
    const goalCell = goalMask?.cellAt(to.x, to.z) ?? -1;
    if (!startMask || startMask.state(startCell) !== CellState.walkable) {
      return fail("start_not_walkable", `${describe(from)} is not walkable`);
    }
    if (!goalMask || goalMask.state(goalCell) !== CellState.walkable) {
      return fail("goal_not_walkable", `${describe(to)} is not walkable`);
    }

    if (from.regionId === to.regionId && this.#sameArea(from.regionId, startCell, goalCell)) {
      const points = findGridPath(startMask, point(from), point(to));
      return points
        ? {
            ok: true,
            route: { legs: [{ regionId: from.regionId, points }], length: pathLength(points) },
          }
        : fail(
            "unreachable",
            `no path inside "${from.regionId}" from ${describe(from)} to ${describe(to)}`,
          );
    }

    const crossings = this.#crossingSequence(from.regionId, startCell, to.regionId, goalCell);
    if (!crossings) {
      return fail("unreachable", `no route from ${describe(from)} to ${describe(to)}`);
    }
    const legs: RouteLeg[] = [];
    let entry = point(from);
    let regionId = from.regionId;
    let length = 0;
    for (const exit of [...crossings, undefined]) {
      const mask = this.navigation.masks.get(regionId);
      const target = exit ? exit.from : point(to);
      const points = mask && findGridPath(mask, entry, target);
      if (!points) {
        return fail(
          "unreachable",
          `no path inside "${regionId}" towards ${describe({ regionId, ...target })}`,
        );
      }
      length += pathLength(points);
      legs.push(exit ? { regionId, points, exit } : { regionId, points });
      if (exit) {
        length += Math.hypot(exit.to.x - exit.from.x, exit.to.z - exit.from.z);
        entry = exit.to;
        regionId = exit.toRegionId;
      }
    }
    return { ok: true, route: { legs, length } };
  }

  /** Whether two walkable cells of a region lie in one walkable area. */
  #sameArea(regionId: string, a: number, b: number): boolean {
    const { ofCell } = this.#regionAreas(regionId);
    return ofCell[a] === ofCell[b];
  }

  /**
   * Cheapest crossings from a start cell to a goal cell in another region, or in another area of
   * the same region (Dijkstra on doors).
   */
  #crossingSequence(
    startRegion: string,
    startCell: number,
    goalRegion: string,
    goalCell: number,
  ): Crossing[] | undefined {
    const GOAL = "goal";
    const cost = new Map<string, number>();
    const via = new Map<string, { previous?: string; crossing?: Crossing }>();
    const done = new Set<string>();
    const relax = (key: string, c: number, link: { previous?: string; crossing?: Crossing }) => {
      if (c >= (cost.get(key) ?? Infinity)) return;
      cost.set(key, c);
      via.set(key, link);
    };

    // From the start to every door of its region. Each door's field is kept, so later routes
    // reuse them.
    for (const exit of this.#exits(startRegion)) {
      const d = this.#field(startRegion, exit.fromCell)[startCell] ?? Infinity;
      if (Number.isFinite(d)) relax(doorKey(startRegion, exit.fromCell), d, {});
    }

    for (;;) {
      // A linear scan for the cheapest door: the door graph has a few dozen nodes, or a couple
      // of hundred where banks line a river (ADR 0020 §4), and a scan of that is still cheap
      // beside the distance fields each popped door needs.
      let key: string | undefined;
      let best = Infinity;
      for (const [k, c] of cost) {
        if (!done.has(k) && c < best) [key, best] = [k, c];
      }
      if (key === undefined) return undefined;
      if (key === GOAL) break;
      done.add(key);
      const split = key.lastIndexOf("#");
      const region = key.slice(0, split);
      const cell = Number(key.slice(split + 1));
      const field = this.#field(region, cell);

      if (region === goalRegion) {
        const d = field[goalCell] ?? Infinity;
        if (Number.isFinite(d)) relax(GOAL, best + d, { previous: key });
      }
      for (const exit of this.#exits(region)) {
        if (exit.fromCell === cell) {
          relax(doorKey(exit.toRegionId, exit.toCell), best + exit.cost, {
            previous: key,
            crossing: exit,
          });
        } else {
          const d = field[exit.fromCell] ?? Infinity;
          if (Number.isFinite(d))
            relax(doorKey(region, exit.fromCell), best + d, { previous: key });
        }
      }
    }

    const sequence: Crossing[] = [];
    for (let link = via.get(GOAL); link?.previous !== undefined; link = via.get(link.previous)) {
      if (link.crossing) sequence.push(link.crossing);
    }
    return sequence.reverse();
  }

  /** Every crossing leaving `regionId`, over connections and banks; built once per region. */
  #exits(regionId: string): readonly Crossing[] {
    let exits = this.#exitsByRegion.get(regionId);
    if (!exits) {
      exits = [
        ...this.world.connections
          .filter((c) => c.from === regionId || c.to === regionId)
          .flatMap((c) => this.crossings(c).filter((x) => x.fromRegionId === regionId)),
        ...this.bankCrossings(regionId),
      ];
      this.#exitsByRegion.set(regionId, exits);
    }
    return exits;
  }

  /** The crossings of the derived banks leaving `regionId` (ADR 0020 §4), in cell order. */
  bankCrossings(regionId: string): readonly Crossing[] {
    this.#bankCrossings ??= this.#buildBankCrossings();
    return this.#bankCrossings.get(regionId) ?? [];
  }

  /**
   * Per bank and pair of areas it joins, cell pairs whose land cells are at least `BANK_SPACING`
   * apart, taken in land cell order, so every area that reaches the water gets a way in and out.
   * Each pair is a crossing each way.
   */
  #buildBankCrossings(): Map<string, Crossing[]> {
    const byRegion = new Map<string, Crossing[]>();
    const add = (crossing: Crossing) => {
      let list = byRegion.get(crossing.fromRegionId);
      if (!list) byRegion.set(crossing.fromRegionId, (list = []));
      list.push(crossing);
    };
    for (const bank of this.navigation.banks) {
      const landAreas = this.#regionAreas(bank.landRegionId).ofCell;
      const waterAreas = this.#regionAreas(bank.waterRegionId).ofCell;
      const chosen = new Map<string, BankPair[]>();
      for (const pair of bank.pairs) {
        const key = `${landAreas[pair.landCell] ?? -1}|${waterAreas[pair.waterCell] ?? -1}`;
        let list = chosen.get(key);
        if (!list) chosen.set(key, (list = []));
        const near = (p: BankPair) =>
          Math.hypot(p.land.x - pair.land.x, p.land.z - pair.land.z) < BANK_SPACING - 1e-9;
        if (!list.some(near)) list.push(pair);
      }
      const pairs = [...chosen.values()].flat().sort((p, q) => p.landCell - q.landCell);
      for (const pair of pairs) {
        const cost =
          Math.hypot(pair.water.x - pair.land.x, pair.water.z - pair.land.z) + BANK_CROSSING_COST;
        add({
          fromRegionId: bank.landRegionId,
          toRegionId: bank.waterRegionId,
          fromCell: pair.landCell,
          toCell: pair.waterCell,
          from: pair.land,
          to: pair.water,
          cost,
        });
        add({
          fromRegionId: bank.waterRegionId,
          toRegionId: bank.landRegionId,
          fromCell: pair.waterCell,
          toCell: pair.landCell,
          from: pair.water,
          to: pair.land,
          cost,
        });
      }
    }
    for (const list of byRegion.values()) list.sort((p, q) => p.fromCell - q.fromCell);
    return byRegion;
  }

  #field(regionId: string, cell: number): Float64Array {
    const key = doorKey(regionId, cell);
    let field = this.#fields.get(key);
    if (!field) {
      const mask = this.navigation.masks.get(regionId);
      field = mask ? distanceField(mask, cell) : new Float64Array(0);
      this.#fields.set(key, field);
    }
    return field;
  }

  #buildCrossings(connection: ConnectionModel): Crossing[] {
    if (!this.navigation.portals.get(connection.id)?.usable) return [];
    const a = this.navigation.masks.get(connection.from);
    const b = this.navigation.masks.get(connection.to);
    if (!a || !b) return [];
    const { portal } = connection;
    const portalLength = Math.hypot(portal.b.x - portal.a.x, portal.b.z - portal.a.z);
    const candidates = candidatePairs(a, b, connection).map((pair) => {
      const mx = (pair.from.x + pair.to.x) / 2;
      const mz = (pair.from.z + pair.to.z) / 2;
      const dx = portal.b.x - portal.a.x;
      const dz = portal.b.z - portal.a.z;
      const along =
        portalLength === 0 ? 0 : ((mx - portal.a.x) * dx + (mz - portal.a.z) * dz) / portalLength;
      return { ...pair, along };
    });
    // Start from the pair nearest the middle of the usable span, then fan out both ways.
    candidates.sort((p, q) => p.along - q.along || p.fromCell - q.fromCell);
    const first = candidates[0];
    const last = candidates[candidates.length - 1];
    if (!first || !last) return [];
    const middle = (first.along + last.along) / 2;
    const byMiddle = [...candidates].sort(
      (p, q) => Math.abs(p.along - middle) - Math.abs(q.along - middle) || p.along - q.along,
    );
    const chosen: typeof candidates = [];
    for (const candidate of byMiddle) {
      if (chosen.every((c) => Math.abs(c.along - candidate.along) >= CROSSING_SPACING - 1e-9)) {
        chosen.push(candidate);
      }
    }
    chosen.sort((p, q) => p.along - q.along);

    const crossings: Crossing[] = [];
    for (const pair of chosen) {
      const cost = Math.hypot(pair.to.x - pair.from.x, pair.to.z - pair.from.z) + connection.cost;
      crossings.push({
        connectionId: connection.id,
        fromRegionId: connection.from,
        toRegionId: connection.to,
        fromCell: pair.fromCell,
        toCell: pair.toCell,
        from: pair.from,
        to: pair.to,
        cost,
      });
      if (connection.bidirectional) {
        crossings.push({
          connectionId: connection.id,
          fromRegionId: connection.to,
          toRegionId: connection.from,
          fromCell: pair.toCell,
          toCell: pair.fromCell,
          from: pair.to,
          to: pair.from,
          cost,
        });
      }
    }
    return crossings;
  }
}

/**
 * Edge-adjacent pairs of walkable cells, one in each region, whose shared edge lies on the
 * portal and whose surfaces meet within the step height. All masks share the world cell grid.
 */
function candidatePairs(a: RegionMask, b: RegionMask, connection: ConnectionModel) {
  const cs = a.cellSize;
  const { portal } = connection;
  const minX = Math.min(portal.a.x, portal.b.x) - cs;
  const maxX = Math.max(portal.a.x, portal.b.x) + cs;
  const minZ = Math.min(portal.a.z, portal.b.z) - cs;
  const maxZ = Math.max(portal.a.z, portal.b.z) + cs;
  const pairs: { fromCell: number; toCell: number; from: Vec2; to: Vec2 }[] = [];
  const cellIndex = (v: number, origin: number) => Math.floor((v - origin) / cs);
  for (let j = cellIndex(minZ, a.originZ); j <= cellIndex(maxZ, a.originZ); j++) {
    for (let i = cellIndex(minX, a.originX); i <= cellIndex(maxX, a.originX); i++) {
      const x = a.originX + (i + 0.5) * cs;
      const z = a.originZ + (j + 0.5) * cs;
      const fromCell = a.cellAt(x, z);
      if (fromCell === -1 || a.state(fromCell) !== CellState.walkable) continue;
      for (const [dx, dz] of [
        [cs, 0],
        [-cs, 0],
        [0, cs],
        [0, -cs],
      ] as const) {
        const toCell = b.cellAt(x + dx, z + dz);
        if (toCell === -1 || b.state(toCell) !== CellState.walkable) continue;
        if (distanceToPortal(connection, x + dx / 2, z + dz / 2) > cs / 2 + 1e-9) continue;
        if (Math.abs(a.height(fromCell) - b.height(toCell)) > WORLD_TOLERANCES.maxStepHeight)
          continue;
        pairs.push({ fromCell, toCell, from: a.center(fromCell), to: b.center(toCell) });
      }
    }
  }
  return pairs;
}

const areaKey = (regionId: string, area: number) => `${regionId}#${area}`;

const describe = (p: RegionPosition) => `"${p.regionId}" (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`;

const fail = (reason: RouteFailure, detail: string): RouteResult => ({ ok: false, reason, detail });

/** Waypoints are plain (x, z); the region is on the leg. */
const point = (p: RegionPosition): Vec2 => ({ x: p.x, z: p.z });
