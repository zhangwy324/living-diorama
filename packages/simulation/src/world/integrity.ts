import {
  error,
  warning,
  WORLD_TOLERANCES,
  type Diagnostic,
  type DiagnosticPath,
  type WorldDefinition,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import { profileForSpecies, type NavProfile } from "../navigation/profile";
import { buildNavigation, distanceToPortal, type Navigation } from "../navigation/region-graph";
import { CellState } from "../navigation/walkability";
import { buildWorldModel, type WorldModel } from "./world-model";

// Semantic and geometric world checks (ADR 0002 §7, ADR 0005 §5). They need the world's
// surfaces and the registered species, so they run after reference resolution.

export interface WorldCheck {
  diagnostics: Diagnostic[];
  model?: WorldModel;
  /** One per distinct navigation profile among the registered species. */
  navigations: Navigation[];
}

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

export function checkWorld(world: WorldDefinition, registries: Registries): WorldCheck {
  const source = `worlds/${world.id}`;
  const built = buildWorldModel(world, registries);
  if (!built.ok) return { diagnostics: built.diagnostics, navigations: [] };
  const model = built.value;
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, message: string, path: DiagnosticPath) =>
    diagnostics.push(error(code, message, path, source));
  const warn = (code: string, message: string, path: DiagnosticPath) =>
    diagnostics.push(warning(code, message, path, source));

  const regionPaths = new Map<string, DiagnosticPath>();
  const regionPath = (id: string) => regionPaths.get(id) ?? [];
  world.regions.forEach((r, i) => regionPaths.set(r.id, ["regions", i]));
  world.structures.forEach((s, si) =>
    s.regions.forEach((r, i) => regionPaths.set(r.id, ["structures", si, "regions", i])),
  );
  const connectionPaths = new Map<string, DiagnosticPath>();
  const connectionPath = (id: string) => connectionPaths.get(id) ?? [];
  world.connections.forEach((c, i) => connectionPaths.set(c.id, ["connections", i]));
  world.structures.forEach((s, si) =>
    s.connections.forEach((c, i) =>
      connectionPaths.set(c.id, ["structures", si, "connections", i]),
    ),
  );

  const profiles = speciesProfiles(registries);
  if (profiles.length === 0) {
    warn("no_species", "No species are registered, so walkability was not checked", []);
  }

  for (const connection of model.connections) {
    if (
      !profiles.some((p) => connection.requiredCapabilities.every((c) => p.capabilities.has(c)))
    ) {
      warn(
        "unsatisfiable_connection",
        `No registered species has all of ${connection.requiredCapabilities.join(", ")}`,
        [...connectionPath(connection.id), "requiredCapabilities"],
      );
    }
  }

  const navigations = profiles.map((profile) => buildNavigation(model, profile));
  for (const nav of navigations) {
    const label = `size class ${nav.profile.sizeClass}`;

    for (const [regionId, mask] of nav.masks) {
      if (!nav.profile.maxSlopeByKind.has(mask.region.kind)) continue;
      const components = mask.components();
      if (components.length === 0) {
        warn(
          "no_walkable_area",
          `Region "${regionId}" has no walkable area for ${label}`,
          regionPath(regionId),
        );
      } else if (components.length > 1) {
        const [largest = [], ...islands] = components;
        const first = mask.center(islands[0]?.[0] ?? 0);
        err(
          "disconnected_region",
          `Region "${regionId}" splits into ${components.length} walkable areas for ${label} ` +
            `(largest ${largest.length} cells; ${islands.map((c) => c.length).join(", ")} more, first near ${at(first.x, first.z)})`,
          regionPath(regionId),
        );
      }
    }

    for (const connection of model.connections) {
      const check = nav.portals.get(connection.id);
      if (!check || check.usable || check.reason === "missing_capability") continue;
      err(
        "portal_unusable",
        `Connection "${connection.id}" is unusable for ${label}: ${check.detail}`,
        [...connectionPath(connection.id), "portal"],
      );
    }

    checkSeams(model, nav, label, err, warn, regionPath);

    world.spawnPoints.forEach((spawn, i) => {
      const mask = nav.masks.get(spawn.position.regionId);
      if (!mask || !nav.profile.maxSlopeByKind.has(mask.region.kind)) return;
      const { x, z } = spawn.position;
      if (!mask.isWalkableAt(x, z)) {
        const cell = mask.cellAt(x, z);
        const state = mask.state(cell);
        const reason = Object.entries(CellState).find(([, v]) => v === state)?.[0] ?? "unknown";
        err(
          "spawn_not_walkable",
          `Spawn point "${spawn.id}" at ${at(x, z)} is not walkable for ${label} (${reason})`,
          ["spawnPoints", i, "position"],
        );
      }
    });
  }

  world.spawnPoints.forEach((spawn, i) => {
    const region = model.regions.get(spawn.position.regionId);
    if (!region) return;
    if (profiles.length > 0 && !profiles.some((p) => p.maxSlopeByKind.has(region.kind))) {
      warn(
        "spawn_unusable",
        `No registered species can move in the ${region.kind} region of spawn point "${spawn.id}"`,
        ["spawnPoints", i, "position", "regionId"],
      );
    }
  });

  return { diagnostics, model, navigations };
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
      for (let cell = 0; cell < a.states.length; cell++) {
        if (a.states[cell] !== CellState.walkable) continue;
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
