import {
  error,
  type Diagnostic,
  type RegionPosition,
  type Result,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import { Pathfinder } from "../navigation/pathfinder";
import { profileForSpecies } from "../navigation/profile";
import { checkWorld } from "../world/integrity";
import type { WorldModel } from "../world/world-model";
import { Rng, type RngState } from "./rng";

/**
 * One creature's authoritative state. Plain data only (no classes or closures), so it can be
 * saved and restored later; the M3 actions and behaviors add their own fields.
 */
export interface CreatureState {
  id: string;
  speciesId: string;
  /** Exact species version this individual was created from (ADR 0003 §5). */
  speciesVersion: string;
  position: RegionPosition;
  /** Radians in [-π, π), 0 facing +x (world-coordinates.md). */
  heading: number;
  rng: RngState;
}

export interface WorldStateOptions {
  worldId: string;
  seed: number;
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
  readonly #pathfinders: ReadonlyMap<string, Pathfinder>;
  readonly #rng: Rng;
  readonly #root: Rng;
  #nextCreature = 1;

  private constructor(
    readonly registries: Registries,
    readonly model: WorldModel,
    pathfinders: ReadonlyMap<string, Pathfinder>,
    seed: number,
  ) {
    this.#pathfinders = pathfinders;
    this.#root = Rng.fromSeed(seed);
    this.#rng = this.#root.fork("world");
  }

  /** Builds the state for a registered world. Expects `resolveReferences` to have passed. */
  static create(registries: Registries, { worldId, seed }: WorldStateOptions): Result<WorldState> {
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
    return { ok: true, value: new WorldState(registries, model, pathfinders, seed) };
  }

  /** The pathfinder for a registered species' navigation profile. */
  pathfinderFor(speciesId: string): Pathfinder | undefined {
    const species = this.registries.species.get(speciesId);
    return species && this.#pathfinders.get(profileForSpecies(species, this.registries).key);
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
    const creature: CreatureState = {
      id,
      speciesId,
      speciesVersion: species.version,
      position: { ...spawn.position },
      heading: normalizeHeading(spawn.heading),
      rng: this.#root.fork(id).state,
    };
    this.creatures.set(id, creature);
    return { ok: true, value: creature };
  }
}

const failure = (diagnostic: Diagnostic): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic],
});
