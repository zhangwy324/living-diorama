import {
  error,
  warning,
  WORLD_TOLERANCES,
  type Diagnostic,
  type DiagnosticPath,
  type WorldDefinition,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import { profileForSpecies, profileLabel, type NavProfile } from "../navigation/profile";
import {
  buildNavigation,
  distanceToPortal,
  isBankPair,
  type Navigation,
} from "../navigation/region-graph";
import { CellState, type RegionMask } from "../navigation/walkability";
import { buildWorldModel, type WorldModel } from "./world-model";

// Semantic and geometric world checks (ADR 0002 §7, ADR 0005 §5). They need the world's
// surfaces and the registered species, so they run after reference resolution.

export interface WorldCheck {
  diagnostics: Diagnostic[];
  model?: WorldModel;
  /** One per distinct navigation profile among the registered species. */
  navigations: Navigation[];
  /** Per profile key, where that profile's creatures don't fit (ADR 0013). */
  limits: ReadonlyMap<string, Diagnostic[]>;
}

/**
 * Cut-off walkable areas this small or smaller, in square metres, are not a limit (ADR 0013 §5):
 * slivers a creature can't usefully stand in, like the few edge cells where a river meets the
 * world's edge. One square metre is four 0.5 m cells, or a large creature's footprint (radius
 * 0.8 m, about 2 m²) only half covered, so anything a creature could go to is still reported.
 */
export const MAX_IGNORED_ISLAND_AREA = 1;

const at = (x: number, z: number) => `(${x.toFixed(2)}, ${z.toFixed(2)})`;

/** Navigation profiles of every registered species, one per distinct profile. */
export function speciesProfiles(registries: Registries): NavProfile[] {
  const profiles = new Map<string, NavProfile>();
  for (const species of registries.species.values()) {
    const profile = profileForSpecies(species, registries);
    profiles.set(profile.key, profile);
  }
  return [...profiles.values()];
}

/** Collects diagnostics about a world, with paths into its definition. */
function reporter(world: WorldDefinition) {
  const source = `worlds/${world.id}`;
  const diagnostics: Diagnostic[] = [];
  const regionPaths = new Map<string, DiagnosticPath>();
  world.regions.forEach((r, i) => regionPaths.set(r.id, ["regions", i]));
  world.structures.forEach((s, si) =>
    s.regions.forEach((r, i) => regionPaths.set(r.id, ["structures", si, "regions", i])),
  );
  const connectionPaths = new Map<string, DiagnosticPath>();
  world.connections.forEach((c, i) => connectionPaths.set(c.id, ["connections", i]));
  world.structures.forEach((s, si) =>
    s.connections.forEach((c, i) =>
      connectionPaths.set(c.id, ["structures", si, "connections", i]),
    ),
  );
  return {
    diagnostics,
    err: (code: string, message: string, path: DiagnosticPath) =>
      diagnostics.push(error(code, message, path, source)),
    warn: (code: string, message: string, path: DiagnosticPath) => {
      const d = warning(code, message, path, source);
      diagnostics.push(d);
      return d;
    },
    regionPath: (id: string) => regionPaths.get(id) ?? [],
    connectionPath: (id: string) => connectionPaths.get(id) ?? [],
  };
}
type Reporter = ReturnType<typeof reporter>;

export function checkWorld(world: WorldDefinition, registries: Registries): WorldCheck {
  const built = buildWorldModel(world, registries);
  if (!built.ok) return { diagnostics: built.diagnostics, navigations: [], limits: new Map() };
  const model = built.value;
  const report = reporter(world);
  const { warn } = report;

  // No check here assumes the species registered now: a species that uses a connection or spawn
  // point, a swimmer say, may be registered from the library later (ADR 0020 §5).
  const profiles = speciesProfiles(registries);
  if (profiles.length === 0) {
    warn("no_species", "No species are registered, so walkability was not checked", []);
  }

  const limits = new Map<string, Diagnostic[]>();
  const navigations = profiles.map((profile) => {
    const { navigation, limits: found } = navigate(world, model, profile, report);
    limits.set(profile.key, found);
    return navigation;
  });

  const movable = new Set(
    registries.capabilities.values().flatMap((c) => c.locomotion?.regionKinds ?? []),
  );
  world.spawnPoints.forEach((spawn, i) => {
    const region = model.regions.get(spawn.position.regionId);
    if (!region || movable.has(region.kind)) return;
    warn(
      "spawn_unusable",
      `No registered capability moves in the ${region.kind} region of spawn point "${spawn.id}"`,
      ["spawnPoints", i, "position", "regionId"],
    );
  });

  return { diagnostics: report.diagnostics, model, navigations, limits };
}

export interface NavigationCheck {
  diagnostics: Diagnostic[];
  navigation: Navigation;
  /** The warnings about where this profile's creatures don't fit, also in `diagnostics`. */
  limits: Diagnostic[];
}

/**
 * Builds the navigation of one profile in a checked world and runs the per-profile checks of
 * `checkWorld`, e.g. for a species registered while the world runs (ADR 0012).
 */
export function checkNavigation(
  world: WorldDefinition,
  model: WorldModel,
  profile: NavProfile,
): NavigationCheck {
  const report = reporter(world);
  const { navigation, limits } = navigate(world, model, profile, report);
  return { diagnostics: report.diagnostics, navigation, limits };
}

/**
 * Builds one profile's navigation and checks that the world works for it. Where its creatures
 * don't fit (a region that splits, a portal or spawn point without room, water it can get into
 * but not out of) is a warning and a limit, not an error: they only go where they fit (ADR 0013).
 * A profile that fits no spawn point at all can't appear, which is an error. A connection that
 * isn't for the profile (it lacks a capability, or a side is in a region kind it can't move in)
 * is skipped (ADR 0020 §5).
 */
function navigate(
  world: WorldDefinition,
  model: WorldModel,
  profile: NavProfile,
  { err, warn, regionPath, connectionPath }: Reporter,
): { navigation: Navigation; limits: Diagnostic[] } {
  const nav = buildNavigation(model, profile);
  const label = profileLabel(nav.profile);
  const limits: Diagnostic[] = [];
  const limit = (code: string, message: string, path: DiagnosticPath) =>
    limits.push(warn(code, message, path));

  for (const [regionId, mask] of nav.masks) {
    if (!nav.profile.maxSlopeByKind.has(mask.region.kind)) continue;
    const components = mask.components();
    if (components.length === 0) {
      limit(
        "no_walkable_area",
        `Region "${regionId}" has no walkable area for ${label}`,
        regionPath(regionId),
      );
      continue;
    }
    const cellArea = mask.cellSize * mask.cellSize;
    const [largest = [], ...cutOff] = components;
    // A little slack, so islands of exactly the limit (four 0.5 m cells) are ignored.
    const islands = cutOff.filter((c) => c.length * cellArea > MAX_IGNORED_ISLAND_AREA + 1e-9);
    if (islands.length > 0) {
      const first = mask.center(islands[0]?.[0] ?? 0);
      limit(
        "disconnected_region",
        `Region "${regionId}" splits into ${islands.length + 1} walkable areas for ${label} ` +
          `(largest ${largest.length} cells; ${islands.map((c) => c.length).join(", ")} more, first near ${at(first.x, first.z)})`,
        regionPath(regionId),
      );
    }
  }

  for (const connection of model.connections) {
    const check = nav.portals.get(connection.id);
    if (
      !check ||
      check.usable ||
      check.reason === "missing_capability" ||
      check.reason === "not_applicable"
    ) {
      continue;
    }
    const where = connection.structureId === undefined ? "" : ` of "${connection.structureId}"`;
    // Too little room is a fit limit; surfaces that don't meet are a geometry error for anyone.
    (check.reason === "no_walkable_side" ? limit : err)(
      "portal_unusable",
      `Connection "${connection.id}"${where} is unusable for ${label}: ${check.detail}`,
      [...connectionPath(connection.id), "portal"],
    );
  }

  checkSeams(model, nav, label, err, warn, regionPath);
  checkWaterExits(world, nav, label, limit, regionPath);

  let standable = 0;
  world.spawnPoints.forEach((spawn, i) => {
    const mask = nav.masks.get(spawn.position.regionId);
    if (!mask || !nav.profile.maxSlopeByKind.has(mask.region.kind)) return;
    const { x, z } = spawn.position;
    if (mask.isWalkableAt(x, z)) {
      standable++;
      return;
    }
    const cell = mask.cellAt(x, z);
    const state = mask.state(cell);
    const reason = Object.entries(CellState).find(([, v]) => v === state)?.[0] ?? "unknown";
    limit(
      "spawn_not_walkable",
      `Spawn point "${spawn.id}" at ${at(x, z)} is not walkable for ${label} (${reason})`,
      ["spawnPoints", i, "position"],
    );
  });
  if (standable === 0) {
    err("no_spawn_point", `No spawn point is walkable for ${label}, so it can't appear`, [
      "spawnPoints",
    ]);
  }
  return { navigation: nav, limits };
}

/**
 * For a profile that moves on land and in water: a water region it can get into (from land, by a
 * connection, or by appearing at a spawn point there) but not out of to land, because every bank
 * is too high or too far and no connection leads out (ADR 0020 §4). A limit, not an error, since
 * the species can still be released. Region-level, like `reachableRegions`.
 */
function checkWaterExits(
  world: WorldDefinition,
  nav: Navigation,
  label: string,
  limit: (code: string, message: string, path: DiagnosticPath) => void,
  regionPath: (id: string) => DiagnosticPath,
) {
  const kinds = nav.profile.maxSlopeByKind;
  if (!kinds.has("water") || ![...kinds.keys()].some((k) => k !== "water")) return;
  const isLand = (id: string) => {
    const kind = nav.masks.get(id)?.region.kind;
    return kind !== undefined && kind !== "water" && kinds.has(kind);
  };
  const entered = new Set<string>();
  for (const [id, mask] of nav.masks) {
    if (!isLand(id) || mask.walkableCount === 0) continue;
    for (const reached of nav.reachableRegions(id)) entered.add(reached);
  }
  for (const spawn of world.spawnPoints) {
    const { regionId, x, z } = spawn.position;
    if (nav.masks.get(regionId)?.isWalkableAt(x, z)) entered.add(regionId);
  }
  for (const [regionId, mask] of [...nav.masks].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (mask.region.kind !== "water" || !entered.has(regionId)) continue;
    if ([...nav.reachableRegions(regionId)].some(isLand)) continue;
    limit(
      "no_water_exit",
      `Creatures of ${label} can get into water region "${regionId}" but no bank is low and near enough to climb out and no connection leads out`,
      regionPath(regionId),
    );
  }
}

/**
 * The columns [i0, i1) and rows [j0, j1) of `a` whose cell centres lie within `margin` of `b`'s
 * grid. A cell wider at each end, which costs little.
 */
function cellsNear(a: RegionMask, b: RegionMask, margin: number) {
  const span = (aOrigin: number, aFirst: number, aCount: number, bMin: number, bMax: number) => {
    const index = (x: number) => (x - aOrigin) / a.cellSize - aFirst - 0.5;
    return [
      Math.max(0, Math.floor(index(bMin - margin))),
      Math.min(aCount, Math.ceil(index(bMax + margin)) + 1),
    ] as const;
  };
  const [i0, i1] = span(
    a.originX,
    a.i0,
    a.columns,
    b.originX + b.i0 * b.cellSize,
    b.originX + (b.i0 + b.columns) * b.cellSize,
  );
  const [j0, j1] = span(
    a.originZ,
    a.j0,
    a.rows,
    b.originZ + b.j0 * b.cellSize,
    b.originZ + (b.j0 + b.rows) * b.cellSize,
  );
  return { i0, i1, j0, j1 };
}

/**
 * Regions may only be entered through portals. Where two regions' walkable cells touch away from
 * any portal joining them, a creature would meet an invisible wall (warning); where both regions
 * are walkable at the same place and height, positions would be ambiguous (error).
 */
function checkSeams(
  model: WorldModel,
  nav: Navigation,
  label: string,
  err: (code: string, message: string, path: DiagnosticPath) => void,
  warn: (code: string, message: string, path: DiagnosticPath) => void,
  regionPath: (id: string) => DiagnosticPath,
) {
  const masks = [...nav.masks.values()].filter((m) => m.walkableCount > 0);
  const cs = model.terrain.cellSize;
  const step = WORLD_TOLERANCES.maxStepHeight;
  for (const [ai, a] of masks.entries()) {
    for (const b of masks.slice(ai + 1)) {
      const joining = model.connections.filter(
        (c) =>
          (c.from === a.region.id && c.to === b.region.id) ||
          (c.from === b.region.id && c.to === a.region.id),
      );
      let overlap: { x: number; z: number } | undefined;
      let seams = 0;
      let firstSeam: { x: number; z: number } | undefined;
      // Only cells of `a` within a step of `b`'s grid can overlap or touch it (#196).
      const { i0, i1, j0, j1 } = cellsNear(a, b, cs);
      for (let cell = j0 * a.columns; cell < j1 * a.columns; cell++) {
        const i = cell % a.columns;
        if (i < i0 || i >= i1 || a.states[cell] !== CellState.walkable) continue;
        const c = a.center(cell);
        const hA = a.height(cell);
        const bCell = b.cellAt(c.x, c.z);
        if (
          bCell !== -1 &&
          b.states[bCell] === CellState.walkable &&
          Math.abs(b.height(bCell) - hA) < nav.profile.height
        ) {
          overlap ??= c;
          continue;
        }
        for (const [dx, dz] of [
          [cs, 0],
          [-cs, 0],
          [0, cs],
          [0, -cs],
        ] as const) {
          const nx = c.x + dx;
          const nz = c.z + dz;
          const n = b.cellAt(nx, nz);
          if (n === -1 || b.states[n] !== CellState.walkable || a.isWalkableAt(nx, nz)) continue;
          if (Math.abs(b.height(n) - hA) > step) continue;
          // A creature that swims jumps across a bank, both ways (ADR 0020 §4).
          if (isBankPair(a, cell, b, n)) continue;
          const mx = c.x + dx / 2;
          const mz = c.z + dz / 2;
          if (joining.some((j) => distanceToPortal(j, mx, mz) <= cs)) continue;
          seams++;
          firstSeam ??= { x: mx, z: mz };
        }
      }
      const pair = `"${a.region.id}" and "${b.region.id}"`;
      if (overlap) {
        err(
          "ambiguous_overlap",
          `Regions ${pair} are both walkable at the same height near ${at(overlap.x, overlap.z)} for ${label}`,
          regionPath(b.region.id),
        );
      }
      if (firstSeam) {
        warn(
          "region_seam",
          `Regions ${pair} touch without a portal at ${seams} cell edges for ${label}, first near ${at(firstSeam.x, firstSeam.z)}`,
          regionPath(b.region.id),
        );
      }
    }
  }
}
