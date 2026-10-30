import {
  error,
  warning,
  type AppliedWorldEdit,
  type BlockedWaterExit,
  type Diagnostic,
  type PropFootprint,
  type RegionPosition,
  type RelocatedCreature,
  type Result,
  type WaterExit,
  type WorldEdit,
  type WorldEditOutcome,
} from "@living-diorama/content-schema";
import type { Pathfinder } from "../navigation/pathfinder";
import { profileForSpecies, profileLabel } from "../navigation/profile";
import type { Navigation } from "../navigation/region-graph";
import type { RegionMask } from "../navigation/walkability";
import { applyWorldEdit, assignPlacementIds } from "../world/edit";
import type { WorldModel } from "../world/world-model";
import type { CreatureState, DerivedWorld, WorldState } from "./world-state";

// Planning a world edit against the running world (ADR 0021 §1, §7, §9, §10): applying it to the
// definition, rebuilding everything derived from it, and working out what it would do to the
// creatures and the ways out of the water. Changes nothing, so a dry run (`validate`) is a plan
// that is thrown away; `Simulation.applyEdit` swaps the plan's world in and reconciles creatures.

/** What an edit would do, with the rebuilt world to swap in. */
export interface PlannedEdit {
  /** The edit with every new placement's ID. */
  edit: AppliedWorldEdit;
  inverse: AppliedWorldEdit;
  derived: DerivedWorld;
  /** The generated-ID counter after the edit. */
  nextPropId: number;
  /** Placements that were there before and that the edit moved or scaled (not only turned). */
  changed: ReadonlySet<string>;
  /** Placements that were there before and that the edit removed. */
  removed: ReadonlySet<string>;
  /** Per creature ID, where it would be moved to: those the edit leaves off any walkable cell. */
  relocations: ReadonlyMap<string, RegionPosition>;
  outcome: WorldEditOutcome;
}

const rejected = (diagnostics: Diagnostic[]): Result<never> => ({ ok: false, diagnostics });

/**
 * Plans `edit` (already shape-checked by `parseWorldEdit`) against `state`. Fails, with
 * diagnostics whose paths point into the edit, when the edit doesn't fit the world
 * (`applyWorldEdit`), when the rebuilt world would keep a navigation profile out entirely
 * (`edit_breaks_navigation`), or when a creature it covers has nowhere to go (`no_relocation`).
 */
export function planWorldEdit(state: WorldState, edit: WorldEdit): Result<PlannedEdit> {
  const { model, registries } = state;
  const ids = assignPlacementIds(model.definition, edit, state.nextPropId);
  const applied = applyWorldEdit(model.definition, ids.edit, {
    blockRadius: (id) => registries.props.get(id)?.blockRadius,
    // Props only, so the ground is the one the world has now.
    groundHeight: (x, z) => model.terrain.heightAt(x, z),
  });
  if (!applied.ok) return applied;
  const derived = state.derive(applied.value.world);
  if (!derived.ok) {
    return rejected(
      derived.diagnostics.map((d) =>
        error(
          "edit_breaks_navigation",
          `The edit would break the world: ${d.message} (${d.code})`,
          [],
          "world edit",
        ),
      ),
    );
  }
  const { added, changed, removed } = applied.value;

  const relocations = new Map<string, RegionPosition>();
  const relocated: RelocatedCreature[] = [];
  for (const creature of state.creatures.values()) {
    const before = state.pathfinderFor(creature.speciesId);
    const species = registries.species.get(creature.speciesId);
    const after =
      species && derived.value.pathfinders.get(profileForSpecies(species, registries).key);
    if (!before || !after) continue;
    const { regionId, x, z } = creature.position;
    const was = before.navigation.masks.get(regionId)?.isWalkableAt(x, z) === true;
    if (!was || after.navigation.masks.get(regionId)?.isWalkableAt(x, z)) continue;
    const to = nearestMainCell(after, creature);
    if (!to) {
      return rejected([
        error(
          "no_relocation",
          `Creature "${creature.id}" would be covered and has nowhere it can stand`,
          [],
          "world edit",
        ),
      ]);
    }
    relocations.set(creature.id, to);
    relocated.push({ creatureId: creature.id, from: { ...creature.position }, to: { ...to } });
  }

  const blockedExits = blockedWaterExits(model, state.navigations, derived.value);
  const labels = new Map(state.navigations.map((n) => [n.profile.key, profileLabel(n.profile)]));
  const warnings = [
    ...blockedExits.map(({ exit, profiles }) =>
      warning(
        "water_exit_blocked",
        `The edit blocks ${describeExit(exit)} out of the water for ${[
          ...new Set(profiles.map((key) => labels.get(key) ?? key)),
        ].join(", ")}`,
        [],
        "world edit",
      ),
    ),
    ...newLimits(state, derived.value),
  ];
  const final = derived.value.model.propsById;
  const footprints: PropFootprint[] = [...added, ...changed].flatMap((placementId) => {
    const prop = final.get(placementId);
    if (!prop) return [];
    const { x, z } = prop.transform.position;
    return [{ placementId, center: { x, z }, radius: prop.blockRadius }];
  });
  return {
    ok: true,
    value: {
      edit: ids.edit,
      inverse: applied.value.inverse,
      derived: derived.value,
      nextPropId: ids.next,
      changed: new Set(changed),
      removed: new Set(removed),
      relocations,
      outcome: { footprints, blockedExits, warnings, relocated },
    },
  };
}

/**
 * The nearest walkable cell centre, to where the creature stands, in the main walkable area (the
 * largest connected piece) of its own region, else of the nearest region its profile can move in
 * (ADR 0021 §7). Ties go to the lower cell, then the region first by ID. Undefined if there is
 * none.
 */
function nearestMainCell(
  pathfinder: Pathfinder,
  { position }: CreatureState,
): RegionPosition | undefined {
  const { masks, profile } = pathfinder.navigation;
  const nearestIn = (mask: RegionMask | undefined) => {
    if (!mask || !profile.maxSlopeByKind.has(mask.region.kind)) return undefined;
    let best: { cell: number; distance: number } | undefined;
    for (const cell of mask.components()[0] ?? []) {
      const c = mask.center(cell);
      const distance = Math.hypot(c.x - position.x, c.z - position.z);
      if (!best || distance < best.distance || (distance === best.distance && cell < best.cell)) {
        best = { cell, distance };
      }
    }
    return best && { regionId: mask.region.id, ...mask.center(best.cell), distance: best.distance };
  };
  let found = nearestIn(masks.get(position.regionId));
  if (!found) {
    for (const regionId of [...masks.keys()].sort()) {
      if (regionId === position.regionId) continue;
      const candidate = nearestIn(masks.get(regionId));
      if (candidate && (!found || candidate.distance < found.distance)) found = candidate;
    }
  }
  return found && { regionId: found.regionId, x: found.x, z: found.z };
}

/**
 * The ways out of the water that some profile could use before the edit and can't after it
 * (ADR 0021 §9): a connection from a water region to a land region (one-way out, or two-way) whose
 * portal is no longer usable, or a bank between a water and a land region with no jump left
 * anywhere along it. A bank that keeps a single jump isn't blocked. Sorted by exit, profiles by
 * key.
 */
function blockedWaterExits(
  model: WorldModel,
  before: readonly Navigation[],
  after: DerivedWorld,
): BlockedWaterExit[] {
  const kind = (regionId: string) => model.regions.get(regionId)?.kind;
  const isLand = (regionId: string) => {
    const k = kind(regionId);
    return k !== undefined && k !== "water";
  };
  const exits = new Map<string, BlockedWaterExit & { profiles: string[] }>();
  const block = (key: string, exit: WaterExit, profile: string) => {
    let found = exits.get(key);
    if (!found) exits.set(key, (found = { exit, profiles: [] }));
    found.profiles.push(profile);
  };
  for (const old of before) {
    const { key } = old.profile;
    const now = after.pathfinders.get(key)?.navigation;
    if (!now) continue;
    for (const connection of model.connections) {
      const out =
        (kind(connection.from) === "water" && isLand(connection.to)) ||
        (connection.bidirectional && kind(connection.to) === "water" && isLand(connection.from));
      if (!out || !old.portals.get(connection.id)?.usable) continue;
      if (now.portals.get(connection.id)?.usable) continue;
      const exit: WaterExit = { kind: "connection", connectionId: connection.id };
      block(`connection|${connection.id}`, exit, key);
    }
    const banks = new Set(now.banks.map((b) => `${b.waterRegionId}|${b.landRegionId}`));
    for (const bank of old.banks) {
      const pair = `${bank.waterRegionId}|${bank.landRegionId}`;
      if (banks.has(pair)) continue;
      const exit: WaterExit = {
        kind: "bank",
        waterRegion: bank.waterRegionId,
        landRegion: bank.landRegionId,
      };
      block(`bank|${pair}`, exit, key);
    }
  }
  return [...exits.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, { exit, profiles }]) => ({ exit, profiles: profiles.sort() }));
}

function describeExit(exit: WaterExit): string {
  return exit.kind === "connection"
    ? `connection "${exit.connectionId}"`
    : `the bank from "${exit.waterRegion}" to "${exit.landRegion}"`;
}

/**
 * Where a profile's creatures newly don't fit after the edit (ADR 0013), e.g. a region that now
 * splits: the rebuilt world's limits that the world before had no limit of the same code at the
 * same place for. Messages count cells, so they are not compared. Profiles that differ only in
 * capabilities that don't move them get the same message; it is given once.
 */
function newLimits(state: WorldState, after: DerivedWorld): Diagnostic[] {
  const found: Diagnostic[] = [];
  const given = new Set<string>();
  for (const [key, limits] of after.limits) {
    const old = new Set((state.limits.get(key) ?? []).map((d) => `${d.code}|${d.path.join(".")}`));
    for (const d of limits) {
      if (old.has(`${d.code}|${d.path.join(".")}`) || given.has(d.message)) continue;
      given.add(d.message);
      found.push(warning(d.code, d.message, [], "world edit"));
    }
  }
  return found;
}
