import {
  error,
  type CreatureSave,
  type Diagnostic,
  type Result,
  type RngStateSave,
  type WorldSave,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import type { ActionProvider, BehaviorProvider } from "../creatures/contracts";
import type { CatchUpSkip } from "./catch-up";
import type { WorldModel } from "../world/world-model";
import { clonePlain } from "./plain";
import type { RngState } from "./rng";
import type { CreatureState } from "./world-state";

// Checking a parsed world save against the running world before it is restored (ADR 0019 §7).
// The schema checks each field; this checks what it can't: that the save belongs to this world,
// that its fields agree with each other, and that its creatures' species and placements are still
// there. A save that doesn't belong is discarded whole; within one that does, creatures and
// placement references that no longer fit are dropped and reported. Nothing here throws on
// content.

// The save schema repeats the simulation's state types by shape, since `content-schema` can't
// import the simulation. These fail to compile if the two drift apart. The types must be identical,
// which is stricter than assignable both ways: that would miss an optional field only one has.
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type SaveMatchesState = [
  Assert<Identical<CreatureState, CreatureSave>>,
  Assert<Identical<RngState, RngStateSave>>,
];

/** Why a creature in a save was left out of the restored world. */
export type DroppedCreatureReason = "species_missing" | "species_major_mismatch";

export interface DroppedCreature {
  creatureId: string;
  speciesId: string;
  /** The species version the creature was created from. */
  speciesVersion: string;
  reason: DroppedCreatureReason;
  /** The version registered now, for `species_major_mismatch`. */
  registeredVersion?: string;
}

/** Where a pruned placement reference was. */
export type PrunedReference = "home" | "knowledge" | "used_structures";

export interface PrunedPlacement {
  creatureId: string;
  placementId: string;
  where: PrunedReference;
}

/**
 * Why a saved running action was dropped: no action of its ID is registered (`unknown_action`), or
 * its state fails the action's `checkState`, e.g. naming a placement no longer in the world
 * (`invalid_state`).
 */
export type DroppedActionReason = "unknown_action" | "invalid_state";

export interface DroppedAction {
  creatureId: string;
  actionId: string;
  reason: DroppedActionReason;
}

/** A behavior's catch-up that had no effect on a creature. */
export interface CatchUpFailure {
  creatureId: string;
  behavior: string;
  /**
   * `hook_failed`: its `catchUp` hook threw, so nothing it would have set was.
   * `undeclared_need` or `invalid_need`: it set `need`, which it doesn't declare, or to a value
   * that isn't a finite number; that need was left alone. `no_spot`: the creature has no spot it
   * can reach at the placement the hook named. Otherwise why the action it asked for failed to
   * start (`start_failed` if it threw); the creature was placed awake then.
   * `interrupted_failed`: the `interrupted` hook of the action it was running threw as catch-up
   * dropped that action; the action was dropped all the same.
   */
  reason: string;
  /** The need, for `undeclared_need` and `invalid_need`. */
  need?: string;
}

/** What catch-up did for the time the world was away (ADR 0018 §19, ADR 0019 §5, §6). */
export interface CatchUpReport {
  /** Whether it ran. If not, the world resumed exactly as saved and only the time of day moved. */
  applied: boolean;
  /** Why it didn't run; absent when it did. */
  skipped?: CatchUpSkip;
  /** The gap it covered, in milliseconds, capped at 12 hours; 0 when it didn't run. */
  gapMs: number;
  /** Behaviors whose catch-up had no effect, per creature. */
  failures: CatchUpFailure[];
}

/** What restoring a save kept out of the world. */
export interface RestoreReport {
  /**
   * Wall-clock time between the save and the restore, in milliseconds; 0 if the clock went
   * backwards.
   */
  gapMs: number;
  droppedCreatures: DroppedCreature[];
  /**
   * Home, knowledge and used-structure entries naming placements no longer in the world.
   * Behavior memory is pruned by its behavior's `forgetPlacements` and isn't listed.
   */
  prunedPlacements: PrunedPlacement[];
  /**
   * Running actions dropped because their action is missing or their saved state is unusable;
   * those creatures decide afresh. Catch-up drops every running action besides, unreported.
   */
  droppedActions: DroppedAction[];
  catchUp: CatchUpReport;
}

/** A save that passed `checkSave`: the creatures to restore and what was left out. */
export interface CheckedSave {
  creatures: CreatureState[];
  droppedCreatures: DroppedCreature[];
  prunedPlacements: PrunedPlacement[];
  droppedActions: DroppedAction[];
}

const CREATURE_NUMBER = /^creature-(\d+)$/;

const major = (version: string) => version.split(".")[0];

/**
 * Checks `save` (already parsed by `parseWorldSave`) against the running world. Fails, so the
 * caller starts a fresh world, when the save is of another world or world version, or when its
 * fields disagree: a creature whose species isn't in `species` at its exact version, or a creature
 * number at or above `nextCreature`. Otherwise returns copies of the creatures that still fit,
 * each at its species' registered version, with placement references the world no longer has
 * pruned. A behavior whose `forgetPlacements` throws loses that memory. A running action whose
 * action isn't registered, or whose state fails the action's `checkState` (or it throws), is
 * dropped, and the creature decides afresh on its next tick. Doesn't change `save`.
 */
export function checkSave(
  save: WorldSave,
  model: WorldModel,
  registries: Registries,
  behaviors: ReadonlyMap<string, BehaviorProvider>,
  actions: ReadonlyMap<string, ActionProvider>,
): Result<CheckedSave> {
  const { id, version } = model.definition;
  if (save.world.id !== id || save.world.version !== version) {
    return discard(
      "save_world_mismatch",
      `The save is of world "${save.world.id}" ${save.world.version}, not "${id}" ${version}`,
      ["world"],
    );
  }
  for (const [index, creature] of save.creatures.entries()) {
    const path = ["creatures", index];
    if (save.species[creature.speciesId] !== creature.speciesVersion) {
      return discard(
        "save_inconsistent",
        `Creature "${creature.id}" is of ${creature.speciesId} ${creature.speciesVersion}, ` +
          `which the save's species list doesn't name at that version`,
        [...path, "speciesVersion"],
      );
    }
    const number = CREATURE_NUMBER.exec(creature.id)?.[1];
    if (number !== undefined && Number(number) >= save.nextCreature) {
      return discard(
        "save_inconsistent",
        `Creature "${creature.id}" is not below the next creature number ${save.nextCreature}`,
        [...path, "id"],
      );
    }
  }

  const placements = new Set([
    ...model.propsById.keys(),
    ...model.definition.structures.map((s) => s.id),
  ]);
  const exists = (placementId: string) => placements.has(placementId);
  const creatures: CreatureState[] = [];
  const droppedCreatures: DroppedCreature[] = [];
  const prunedPlacements: PrunedPlacement[] = [];
  const droppedActions: DroppedAction[] = [];
  for (const saved of save.creatures) {
    const { id: creatureId, speciesId, speciesVersion } = saved;
    const species = registries.species.get(speciesId);
    if (!species || major(species.version) !== major(speciesVersion)) {
      droppedCreatures.push({
        creatureId,
        speciesId,
        speciesVersion,
        ...(species
          ? { reason: "species_major_mismatch", registeredVersion: species.version }
          : { reason: "species_missing" }),
      });
      continue;
    }
    const creature: CreatureState = clonePlain(saved);
    // The same major version is the same species (ADR 0003 §5), so the creature now is of the
    // registered version; otherwise its next save would list two versions of one species.
    creature.speciesVersion = species.version;
    const pruned = (placementId: string, where: PrunedReference) =>
      prunedPlacements.push({ creatureId, placementId, where });
    if (creature.home !== null && !exists(creature.home)) {
      pruned(creature.home, "home");
      creature.home = null;
    }
    for (const [affordance, known] of Object.entries(creature.knowledge.places)) {
      creature.knowledge.places[affordance] = known.filter(({ placementId }) => {
        if (!exists(placementId)) pruned(placementId, "knowledge");
        return exists(placementId);
      });
    }
    creature.usedStructures = creature.usedStructures.filter((placementId) => {
      if (!exists(placementId)) pruned(placementId, "used_structures");
      return exists(placementId);
    });
    const action = creature.action;
    const reason = action && checkAction(action, actions.get(action.id), exists);
    if (action && reason) {
      droppedActions.push({ creatureId, actionId: action.id, reason });
      delete creature.action;
      creature.lastResult = { action: action.id, outcome: "interrupted", reason };
      creature.decideAtTick = save.tick;
      creature.asleep = false;
    }
    // A behavior that fails on a saved memory loses that memory rather than failing the restore.
    creature.memory = Object.fromEntries(
      Object.entries(creature.memory).filter(([behavior, memory]) => {
        try {
          behaviors.get(behavior)?.forgetPlacements?.(memory, exists);
          return true;
        } catch {
          return false;
        }
      }),
    );
    creatures.push(creature);
  }
  return { ok: true, value: { creatures, droppedCreatures, prunedPlacements, droppedActions } };
}

/** Why a saved running action can't carry on, or undefined if it can. */
function checkAction(
  action: { state: unknown },
  provider: ActionProvider | undefined,
  exists: (placementId: string) => boolean,
): DroppedActionReason | undefined {
  if (!provider) return "unknown_action";
  try {
    return provider.checkState === undefined || provider.checkState(action.state, exists)
      ? undefined
      : "invalid_state";
  } catch {
    return "invalid_state";
  }
}

const discard = (code: string, message: string, path: (string | number)[]): Result<never> => ({
  ok: false,
  diagnostics: [error(code, message, path, "world save")] satisfies Diagnostic[],
});
