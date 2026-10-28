import {
  error,
  type Diagnostic,
  type RegionPosition,
  type Result,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import type { ActionResult, BehaviorMemory } from "../creatures/contracts";
import { drawIndividual, speciesNeeds, type IndividualVariation } from "../creatures/individual";
import { emptyKnowledge, type CreatureKnowledge } from "../creatures/knowledge";
import { Pathfinder } from "../navigation/pathfinder";
import { profileForSpecies, type NavProfile } from "../navigation/profile";
import type { Navigation } from "../navigation/region-graph";
import { checkNavigation, checkWorld } from "../world/integrity";
import type { WorldModel } from "../world/world-model";
import { Rng, type RngState } from "./rng";
import { dayPhaseAt, wrapMinutes, type DayPhase } from "./time-of-day";

/**
 * One creature's authoritative state. Plain data only (no classes or closures), so it can be
 * saved and restored later.
 */
export interface CreatureState {
  id: string;
  speciesId: string;
  /** Exact species version this individual was created from (ADR 0003 §5). */
  speciesVersion: string;
  position: RegionPosition;
  /** Radians in [-π, π); 0 faces +Z and π/2 faces +X (world-coordinates.md). */
  heading: number;
  rng: RngState;
  /** The running action, the behavior that chose it and the action's own plain-data state. */
  action?: { id: string; behavior: string; state: unknown; startTick: number };
  lastResult?: ActionResult;
  /** With no action running, behaviors are evaluated at this tick or later. */
  decideAtTick: number;
  /** Per behavior ID. */
  memory: Record<string, BehaviorMemory>;
  /** Structure placements already used, so `first_use_of_structure` fires once each. */
  usedStructures: string[];
  /**
   * Where the creature last made progress, and how many ticks it has walked since without getting
   * further, for the stuck watchdog. Ticks on which it doesn't walk don't count.
   */
  progress: { x: number; z: number; stalledTicks: number };
  /**
   * Need ID → value in [0, 1] (ADR 0018 §1). Only the needs its species' behaviors declare as
   * `needs` dependencies, so a creature that only wanders has none.
   */
  needs: Record<string, number>;
  /** Places seen and cells visited (ADR 0018 §10, §16). */
  knowledge: CreatureKnowledge;
  /** The placement ID of its home (ADR 0018 §14), or null. */
  home: string | null;
  /** Factors drawn once at spawn (ADR 0018 §16). */
  variation: IndividualVariation;
  /**
   * Radians, drawn once at spawn: where around a place it stands to eat or sleep, so creatures at
   * one place spread out (ADR 0018 amendments, §11). 0 is +Z of the place, π/2 is +X.
   */
  spotAngle: number;
  /** Whether its action reported it asleep on the last tick, which selects the need rates. */
  asleep: boolean;
  /** The tick at which it reacts to the last day-phase change (ADR 0018 §7), if still to come. */
  phaseReactionTick?: number;
}

export interface WorldStateOptions {
  worldId: string;
  seed: number;
  /** Most creatures the world holds at once. No limit if omitted. */
  maxCreatures?: number;
  /** The time of day the world starts at, in minutes since local midnight. Default noon. */
  minutes?: number;
}

/** A profile's pathfinder and where its creatures don't fit, as warnings. */
export interface PlannedNavigation {
  pathfinder: Pathfinder;
  limits: Diagnostic[];
}

/** Wraps an angle into [-π, π). */
export function normalizeHeading(angle: number): number {
  const turn = 2 * Math.PI;
  const wrapped = (((angle + Math.PI) % turn) + turn) % turn;
  return wrapped - Math.PI;
}

/**
 * The simulation's world state, built from registered content (roadmap M3 task 3): the world
 * model, one pathfinder per navigation profile, and the creatures in an id-keyed store.
 */
export class WorldState {
  readonly creatures = new Map<string, CreatureState>();
  /** Species that have had a creature in this world, so `species_introduced` fires once each. */
  readonly introducedSpecies = new Set<string>();
  /** Ticks simulated so far. Part of the state, so it is saved and replayed with it. */
  tick = 0;
  /**
   * The time of day, in minutes since local midnight (ADR 0018 §5): an input, set from outside
   * and never advanced by ticks.
   */
  minutes: number;
  /**
   * The day phase as of the last tick. After the time of day is set it may lag `minutes` until
   * the next tick, which takes up the change (and emits `day_phase_changed`).
   */
  dayPhase: DayPhase;
  readonly maxCreatures: number;
  readonly #pathfinders: Map<string, Pathfinder>;
  /** Per profile key, where its creatures don't fit (ADR 0013). */
  readonly #limits: Map<string, Diagnostic[]>;
  /** Per profile key, the errors of a profile that does not work in this world. */
  readonly #failed = new Map<string, Diagnostic[]>();
  readonly #rng: Rng;
  readonly #root: Rng;
  #nextCreature = 1;

  private constructor(
    readonly registries: Registries,
    readonly model: WorldModel,
    pathfinders: Map<string, Pathfinder>,
    limits: Map<string, Diagnostic[]>,
    seed: number,
    maxCreatures: number,
    minutes: number,
  ) {
    this.minutes = wrapMinutes(minutes);
    this.dayPhase = dayPhaseAt(this.minutes);
    this.#pathfinders = pathfinders;
    this.#limits = limits;
    this.maxCreatures = maxCreatures;
    this.#root = Rng.fromSeed(seed);
    this.#rng = this.#root.fork("world");
  }

  /** Builds the state for a registered world. Expects `resolveReferences` to have passed. */
  static create(
    registries: Registries,
    { worldId, seed, maxCreatures = Infinity, minutes = 12 * 60 }: WorldStateOptions,
  ): Result<WorldState> {
    const world = registries.worlds.get(worldId);
    if (!world) {
      return {
        ok: false,
        diagnostics: [error("unknown_world", `World "${worldId}" is not registered`)],
      };
    }
    const check = checkWorld(world, registries);
    const errors = check.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0 || !check.model) return { ok: false, diagnostics: errors };
    const model = check.model;
    const pathfinders = new Map(
      check.navigations.map((nav) => [nav.profile.key, new Pathfinder(model, nav)]),
    );
    return {
      ok: true,
      value: new WorldState(
        registries,
        model,
        pathfinders,
        new Map(check.limits),
        seed,
        maxCreatures,
        minutes,
      ),
    };
  }

  /** The navigation of every profile the world was checked for. */
  get navigations(): Navigation[] {
    return [...this.#pathfinders.values()].map((p) => p.navigation);
  }

  /** The pathfinder for a registered species' navigation profile. */
  pathfinderFor(speciesId: string): Pathfinder | undefined {
    const species = this.registries.species.get(speciesId);
    return species && this.#pathfinders.get(profileForSpecies(species, this.registries).key);
  }

  /**
   * The navigation for a profile, whether a species has it or not, and where its creatures don't
   * fit. If the world has none for the profile yet, it is built and checked like the profiles of
   * the species registered when the world was created (ADR 0012), and errors are returned (and
   * kept, since the world doesn't change). New navigation is only used once passed to
   * `addNavigation`.
   */
  planNavigation(profile: NavProfile): Result<PlannedNavigation> {
    const existing = this.#pathfinders.get(profile.key);
    if (existing) {
      return {
        ok: true,
        value: { pathfinder: existing, limits: this.#limits.get(profile.key) ?? [] },
      };
    }
    const failed = this.#failed.get(profile.key);
    if (failed) return { ok: false, diagnostics: failed };
    const check = checkNavigation(this.model.definition, this.model, profile);
    const errors = check.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      this.#failed.set(profile.key, errors);
      return { ok: false, diagnostics: errors };
    }
    return {
      ok: true,
      value: { pathfinder: new Pathfinder(this.model, check.navigation), limits: check.limits },
    };
  }

  /** Makes navigation from `planNavigation` available to species of its profile. */
  addNavigation({ pathfinder, limits }: PlannedNavigation): void {
    const { key } = pathfinder.navigation.profile;
    if (this.#pathfinders.has(key)) return;
    this.#pathfinders.set(key, pathfinder);
    this.#limits.set(key, limits);
  }

  /**
   * Adds a creature at a spawn point: the given one, or a random one the species can stand on.
   */
  spawn(speciesId: string, spawnPointId?: string): Result<CreatureState> {
    const species = this.registries.species.get(speciesId);
    const pathfinder = this.pathfinderFor(speciesId);
    if (!species || !pathfinder) {
      return failure(error("unknown_species", `Species "${speciesId}" is not registered`));
    }
    if (this.creatures.size >= this.maxCreatures) {
      return failure(
        error(
          "world_full",
          `The world is full (${this.maxCreatures} creatures). Remove one to add another.`,
        ),
      );
    }
    const standable = this.model.definition.spawnPoints.filter((p) =>
      pathfinder.navigation.masks
        .get(p.position.regionId)
        ?.isWalkableAt(p.position.x, p.position.z),
    );
    const spawn =
      spawnPointId === undefined
        ? this.#rng.pick(standable)
        : standable.find((p) => p.id === spawnPointId);
    if (!spawn) {
      return failure(
        error(
          "no_spawn_point",
          spawnPointId === undefined
            ? `No spawn point is walkable for "${speciesId}"`
            : `Spawn point "${spawnPointId}" does not exist or is not walkable for "${speciesId}"`,
        ),
      );
    }
    const id = `creature-${this.#nextCreature++}`;
    const rng = this.#root.fork(id).state;
    const individual = drawIndividual(
      rng,
      speciesNeeds(species, this.registries),
      species,
      this.registries,
    );
    const creature: CreatureState = {
      id,
      speciesId,
      speciesVersion: species.version,
      position: { ...spawn.position },
      heading: normalizeHeading(spawn.heading),
      rng,
      decideAtTick: this.tick,
      memory: {},
      usedStructures: [],
      progress: { x: spawn.position.x, z: spawn.position.z, stalledTicks: 0 },
      needs: individual.needs,
      knowledge: emptyKnowledge(),
      home: null,
      variation: individual.variation,
      spotAngle: individual.spotAngle,
      asleep: false,
    };
    this.creatures.set(id, creature);
    return { ok: true, value: creature };
  }

  /** Takes a creature out of the world. */
  despawn(creatureId: string): Result<CreatureState> {
    const creature = this.creatures.get(creatureId);
    if (!creature) {
      return failure(error("unknown_creature", `There is no creature "${creatureId}"`));
    }
    this.creatures.delete(creatureId);
    return { ok: true, value: creature };
  }
}

const failure = (diagnostic: Diagnostic): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic],
});
