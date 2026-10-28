import {
  error,
  SIZE_CLASSES,
  type Diagnostic,
  type RegionKind,
  type RegionPosition,
  type Result,
  type SizeClass,
  type SpeciesDefinition,
} from "@living-diorama/content-schema";
import { addEntries, type Registries } from "@living-diorama/extension-api";
import {
  isActionProvider,
  isBehaviorProvider,
  type ActionContext,
  type ActionProvider,
  type ActionResult,
  type ActionStart,
  type BehaviorProvider,
  type CreatureObservation,
  type PathState,
  type Proposal,
  type WorldQueries,
} from "../creatures/contracts";
import type { Pathfinder } from "../navigation/pathfinder";
import { navProfile, profileForSpecies } from "../navigation/profile";
import type { Limit, RouteLegSnapshot, SimulationEvent, SimulationSnapshot } from "../protocol";
import type { ConnectionModel } from "../world/world-model";
import { Rng } from "./rng";
import { dayPhaseAt, wrapMinutes, type DayPhase } from "./time-of-day";
import {
  normalizeHeading,
  WorldState,
  type CreatureState,
  type WorldStateOptions,
} from "./world-state";

// The tick loop (roadmap M3 tasks 6–11, ADR 0006 §7–§10): actions advance every tick,
// behaviors are evaluated only when a creature needs a decision, locomotion is kinematic along
// planned routes, and a watchdog interrupts moving actions that make no progress.

/** A moving action that gets less than PROGRESS_DISTANCE further in this long is stuck. */
const STUCK_SECONDS = 5;
const PROGRESS_DISTANCE = 0.05;
/** Wait before re-evaluating when no proposal could be started. */
const RETRY_SECONDS = 1;

/** One behavior evaluation: what was proposed, what was chosen and how starting it went. */
export interface DecisionTrace {
  tick: number;
  creatureId: string;
  position: RegionPosition;
  /** How the previous action ended; absent for a creature's first decision. */
  lastResult?: ActionResult;
  candidates: { behavior: string; proposal: Proposal | null }[];
  chosen?: { behavior: string; action: string; params?: unknown };
  result: "started" | "rejected" | "no_proposal";
  reason?: string;
  detail?: Record<string, unknown>;
}

/** A species registered while the world runs, and where its creatures don't fit. */
export interface RegisteredSpecies {
  species: SpeciesDefinition;
  limits: Limit[];
}

export interface SnapshotOptions {
  paused?: boolean;
  routes?: boolean;
}

export interface SimulationOptions extends WorldStateOptions {
  /** Default 10. */
  tickRateHz?: number;
  /** Receives every decision, for dev tools. */
  onTrace?: (trace: DecisionTrace) => void;
}

/** Load-time check that every registered action and behavior has code behind it. */
function implementationDiagnostics(registries: Registries): Diagnostic[] {
  return [
    ...registries.actions
      .values()
      .filter((a) => !isActionProvider(a))
      .map((a) =>
        error(
          "no_action_implementation",
          `Action "${a.id}" has no simulation implementation`,
          [],
          `actions/${a.id}`,
        ),
      ),
    ...registries.behaviors
      .values()
      .filter((b) => !isBehaviorProvider(b))
      .map((b) =>
        error(
          "no_behavior_implementation",
          `Behavior "${b.id}" has no simulation implementation`,
          [],
          `behaviors/${b.id}`,
        ),
      ),
  ];
}

export class Simulation {
  readonly tickSeconds: number;
  readonly #stuckTicks: number;
  readonly #retryTicks: number;
  readonly #onTrace: ((trace: DecisionTrace) => void) | undefined;
  readonly #actions = new Map<string, ActionProvider>();
  readonly #behaviors = new Map<string, BehaviorProvider>();
  readonly #connections: ReadonlyMap<string, ConnectionModel>;
  readonly #pathfinders = new Map<string, Pathfinder>();
  readonly #speeds = new Map<string, number>();
  /** The path each creature last walked, kept until its action ends; for debug routes only. */
  readonly #paths = new Map<string, PathState>();
  #events: SimulationEvent[] = [];

  private constructor(
    readonly state: WorldState,
    tickRateHz: number,
    onTrace: ((trace: DecisionTrace) => void) | undefined,
  ) {
    this.tickSeconds = 1 / tickRateHz;
    this.#stuckTicks = Math.round(STUCK_SECONDS * tickRateHz);
    this.#retryTicks = Math.max(1, Math.round(RETRY_SECONDS * tickRateHz));
    this.#onTrace = onTrace;
    for (const a of state.registries.actions.values()) {
      if (isActionProvider(a)) this.#actions.set(a.id, a);
    }
    for (const b of state.registries.behaviors.values()) {
      if (isBehaviorProvider(b)) this.#behaviors.set(b.id, b);
    }
    this.#connections = new Map(state.model.connections.map((c) => [c.id, c]));
  }

  /** Builds a simulation of a registered world. Expects `resolveReferences` to have passed. */
  static create(registries: Registries, options: SimulationOptions): Result<Simulation> {
    const tickRateHz = options.tickRateHz ?? 10;
    if (!(tickRateHz > 0) || !Number.isFinite(tickRateHz)) {
      throw new RangeError(`tickRateHz must be positive, got ${tickRateHz}`);
    }
    if (options.minutes !== undefined && !Number.isFinite(options.minutes)) {
      throw new RangeError(`The time of day must be a finite number, got ${options.minutes}`);
    }
    const missing = implementationDiagnostics(registries);
    if (missing.length > 0) return { ok: false, diagnostics: missing };
    const state = WorldState.create(registries, options);
    if (!state.ok) return state;
    return { ok: true, value: new Simulation(state.value, tickRateHz, options.onTrace) };
  }

  get tick(): number {
    return this.state.tick;
  }

  /**
   * Registers a species and its appearance image while the world runs (ADR 0012), validated and
   * resolved like pack content. The image asset has the ID `species.appearance` and the species'
   * version. A species with a new navigation profile gets its navigation built and checked like
   * the world's at creation. Nothing is registered if anything fails. On success, `limits` says
   * where its creatures don't fit, e.g. a bridge too narrow for them (ADR 0013).
   */
  registerSpecies(input: unknown, appearanceUrl: string): Result<RegisteredSpecies> {
    const { registries } = this.state;
    const checked = registries.species.validate(input);
    if (!checked.ok) return checked;
    const species = checked.value;
    // A profile is only meaningful once the capabilities resolve; `addEntries` reports them.
    const known = Object.keys(species.capabilities).every((id) => registries.capabilities.has(id));
    const navigation = known
      ? this.state.planNavigation(profileForSpecies(species, registries))
      : undefined;
    if (navigation && !navigation.ok) return navigation;
    const added = addEntries(registries, [
      { registry: "species", input },
      {
        registry: "assets",
        input: {
          id: species.appearance,
          version: species.version,
          kind: "image",
          url: appearanceUrl,
        },
      },
    ]);
    if (!added.ok) return added;
    if (!navigation) throw new Error(`"${species.id}" was registered with unknown capabilities`);
    this.state.addNavigation(navigation.value);
    return {
      ok: true,
      value: { species, limits: navigation.value.limits.map((d) => this.#limit(d)) },
    };
  }

  /**
   * Where creatures of `sizeClass` with these capabilities wouldn't fit, without registering
   * anything (ADR 0015 §8): the warnings a species of that profile would be registered with, or
   * the errors that would reject it. A profile the world has no navigation for yet gets it built
   * and kept, so asking again, or registering a species of it later, reuses it. Fails only for a
   * size class or capability that doesn't exist.
   */
  checkLimits(sizeClass: SizeClass, capabilities: Record<string, number>): Result<Limit[]> {
    const { registries } = this.state;
    const diagnostics: Diagnostic[] = [];
    if (!Object.hasOwn(SIZE_CLASSES, sizeClass)) {
      diagnostics.push(
        error("unknown_size_class", `There is no size class "${String(sizeClass)}"`),
      );
    }
    for (const id of Object.keys(capabilities)) {
      if (!registries.capabilities.has(id)) {
        diagnostics.push(error("unknown_capability", `Capability "${id}" is not registered`));
      }
    }
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    const planned = this.state.planNavigation(
      navProfile(sizeClass, Object.keys(capabilities), registries),
    );
    if (!planned.ok) return { ok: true, value: planned.diagnostics.map((d) => this.#limit(d)) };
    this.state.addNavigation(planned.value);
    return { ok: true, value: planned.value.limits.map((d) => this.#limit(d)) };
  }

  /** A diagnostic with the structure its path points into, if any, and that structure's name. */
  #limit(diagnostic: Diagnostic): Limit {
    const [root, index] = diagnostic.path;
    const placement =
      root === "structures" && typeof index === "number"
        ? this.state.model.definition.structures[index]
        : undefined;
    const structure = placement && this.state.registries.structures.get(placement.structure);
    return structure
      ? { ...diagnostic, structure: { id: placement.id, name: structure.name } }
      : { ...diagnostic };
  }

  /** Adds a creature; it makes its first decision on the next step. */
  spawn(speciesId: string, spawnPointId?: string): Result<CreatureState> {
    const result = this.state.spawn(speciesId, spawnPointId);
    if (result.ok) {
      const creature = result.value;
      const base = { tick: this.tick, creatureId: creature.id, speciesId };
      this.#emit({ ...base, type: "creature_spawned", regionId: creature.position.regionId });
      if (!this.state.introducedSpecies.has(speciesId)) {
        this.state.introducedSpecies.add(speciesId);
        this.#emit({ ...base, type: "species_introduced" });
      }
    }
    return result;
  }

  /** Takes a creature out of the world, ending whatever it was doing. */
  despawn(creatureId: string): Result<CreatureState> {
    const result = this.state.despawn(creatureId);
    if (result.ok) {
      const creature = result.value;
      this.#paths.delete(creatureId);
      this.#emit({
        type: "creature_despawned",
        tick: this.tick,
        creatureId,
        speciesId: creature.speciesId,
        regionId: creature.position.regionId,
      });
    }
    return result;
  }

  /**
   * Sets the time of day, in minutes since local midnight (ADR 0018 §5). The next step takes up
   * the change, so a run replays from its commands; a new day phase is announced then.
   */
  setTimeOfDay(minutes: number): void {
    if (!Number.isFinite(minutes)) {
      throw new RangeError(`The time of day must be a finite number, got ${minutes}`);
    }
    this.state.minutes = wrapMinutes(minutes);
  }

  /** Advances one tick. Returns the events emitted since the previous step, spawns included. */
  step(): SimulationEvent[] {
    const phase = dayPhaseAt(this.state.minutes);
    if (phase !== this.state.dayPhase) this.#dayPhaseChanged(this.state.dayPhase, phase);
    for (const creature of this.state.creatures.values()) this.#stepCreature(creature);
    this.state.tick++;
    const events = this.#events;
    this.#events = [];
    return events;
  }

  /** `routes` adds each walking creature's remaining route, for debug overlays (ADR 0007 §10). */
  snapshot({ paused = false, routes = false }: SnapshotOptions = {}): SimulationSnapshot {
    const { model } = this.state;
    return {
      tick: this.tick,
      timeMs: this.tick * this.tickSeconds * 1000,
      paused,
      timeOfDay: this.state.minutes,
      creatures: [...this.state.creatures.values()].map((c) => {
        const { regionId, x, z } = c.position;
        const y = model.regions.get(regionId)?.surface.heightAt(x, z) ?? NaN;
        return {
          id: c.id,
          speciesId: c.speciesId,
          position: { regionId, x, z },
          world: { x, y, z },
          heading: c.heading,
          ...(c.action ? { currentAction: c.action.id } : {}),
          ...(routes && this.#paths.has(c.id) ? { route: this.#route(c.id) } : {}),
        };
      }),
    };
  }

  #route(creatureId: string): RouteLegSnapshot[] {
    const path = this.#paths.get(creatureId);
    const legs: RouteLegSnapshot[] = [];
    for (const { regionId, x, z } of path?.points.slice(path.next) ?? []) {
      const y = this.state.model.regions.get(regionId)?.surface.heightAt(x, z) ?? NaN;
      const leg = legs.at(-1);
      if (leg?.regionId === regionId) leg.points.push({ x, y, z });
      else legs.push({ regionId, points: [{ x, y, z }] });
    }
    return legs;
  }

  #emit(event: SimulationEvent) {
    this.#events.push(event);
  }

  /**
   * The day phase changed since the last tick, by however many phases the time of day jumped:
   * one event from the old phase to the new. This is where a phase change becomes a decision
   * trigger (ADR 0018 §7).
   */
  #dayPhaseChanged(from: DayPhase, to: DayPhase) {
    this.state.dayPhase = to;
    this.#emit({ type: "day_phase_changed", tick: this.tick, from, to });
  }

  #stepCreature(creature: CreatureState) {
    const running = creature.action;
    if (running) {
      const provider = this.#actions.get(running.id);
      const status = provider
        ? provider.step(running.state, this.#actionContext(creature))
        : { status: "failed" as const, reason: "unknown_action" };
      if (status.status === "running") {
        if (provider?.moves) this.#watch(creature, running.id);
      } else {
        this.#finish(
          creature,
          status.status === "done"
            ? { action: running.id, outcome: "done" }
            : { action: running.id, outcome: "failed", reason: status.reason },
        );
      }
    }
    if (!creature.action && this.tick >= creature.decideAtTick) this.#decide(creature);
  }

  #finish(creature: CreatureState, result: ActionResult) {
    creature.lastResult = result;
    delete creature.action;
    this.#paths.delete(creature.id);
    creature.decideAtTick = this.tick;
  }

  /** The stuck watchdog: interrupts a moving action that has made no progress for a while. */
  #watch(creature: CreatureState, actionId: string) {
    const { x, z } = creature.position;
    const anchor = creature.progress;
    if (Math.hypot(x - anchor.x, z - anchor.z) >= PROGRESS_DISTANCE) {
      creature.progress = { x, z, tick: this.tick };
      return;
    }
    const ticksStuck = this.tick - anchor.tick;
    if (ticksStuck < this.#stuckTicks) return;
    this.#emit({
      type: "creature_stuck",
      tick: this.tick,
      creatureId: creature.id,
      position: { ...creature.position },
      ticksStuck,
    });
    this.#finish(creature, { action: actionId, outcome: "interrupted", reason: "stuck" });
  }

  #decide(creature: CreatureState) {
    const tick = this.tick;
    const species = this.state.registries.species.get(creature.speciesId);
    const rng = new Rng(creature.rng);
    const observation: CreatureObservation = {
      tick,
      tickSeconds: this.tickSeconds,
      creature: {
        id: creature.id,
        speciesId: creature.speciesId,
        position: { ...creature.position },
        heading: creature.heading,
      },
      ...(creature.lastResult ? { lastResult: { ...creature.lastResult } } : {}),
      world: this.#queries(creature),
    };
    const candidates = (species?.behaviors ?? []).map((behavior) => {
      const provider = this.#behaviors.get(behavior);
      const memory = (creature.memory[behavior] ??= {});
      return { behavior, proposal: provider?.evaluate(observation, memory, rng) ?? null };
    });
    let best: { behavior: string; proposal: Proposal } | undefined;
    for (const { behavior, proposal } of candidates) {
      if (!proposal || !Number.isFinite(proposal.utility)) continue;
      if (!best || proposal.utility > best.proposal.utility) best = { behavior, proposal };
    }
    const trace: DecisionTrace = {
      tick,
      creatureId: creature.id,
      position: { ...creature.position },
      ...(creature.lastResult ? { lastResult: { ...creature.lastResult } } : {}),
      candidates,
      result: "no_proposal",
    };
    if (!best) {
      creature.decideAtTick = tick + this.#retryTicks;
      this.#onTrace?.(trace);
      return;
    }

    const { action, params } = best.proposal;
    trace.chosen = { behavior: best.behavior, action, ...(params === undefined ? {} : { params }) };
    const provider = this.#actions.get(action);
    // A behavior may only start actions it declared as dependencies.
    const declared = this.#behaviors
      .get(best.behavior)
      ?.dependencies?.some((d) => d.registry === "actions" && d.id === action);
    const start: ActionStart = !provider
      ? { ok: false, reason: "unknown_action" }
      : !declared
        ? { ok: false, reason: "undeclared_action" }
        : provider.start(params, this.#actionContext(creature));
    if (start.ok) {
      creature.action = { id: action, state: start.state, startTick: tick };
      creature.progress = { x: creature.position.x, z: creature.position.z, tick };
      trace.result = "started";
    } else {
      creature.lastResult = { action, outcome: "failed", reason: start.reason };
      creature.decideAtTick = tick + this.#retryTicks;
      trace.result = "rejected";
      trace.reason = start.reason;
    }
    if (start.detail) trace.detail = start.detail;
    this.#onTrace?.(trace);
  }

  #pathfinder(creature: CreatureState): Pathfinder {
    let pathfinder = this.#pathfinders.get(creature.speciesId);
    if (!pathfinder) {
      pathfinder = this.state.pathfinderFor(creature.speciesId);
      // Spawning already checked that the species is registered.
      if (!pathfinder) throw new Error(`No pathfinder for "${creature.speciesId}"`);
      this.#pathfinders.set(creature.speciesId, pathfinder);
    }
    return pathfinder;
  }

  #actionContext(creature: CreatureState): ActionContext {
    return {
      tick: this.tick,
      tickSeconds: this.tickSeconds,
      get position() {
        return creature.position;
      },
      planRoute: (destination) => {
        const result = this.#pathfinder(creature).findRoute(creature.position, destination);
        if (!result.ok) {
          this.#emit({
            type: "path_failed",
            tick: this.tick,
            creatureId: creature.id,
            from: { ...creature.position },
            to: { regionId: destination.regionId, x: destination.x, z: destination.z },
            reason: result.reason,
          });
        }
        return result;
      },
      walk: (path) => this.#walk(creature, path),
    };
  }

  /** What wander may choose from: only cells the creature can reach from where it stands. */
  #queries(creature: CreatureState): WorldQueries {
    const pathfinder = this.#pathfinder(creature);
    const reachable = pathfinder.reachableCells(creature.position);
    const { masks } = pathfinder.navigation;
    return {
      reachableRegions: () =>
        [...reachable].flatMap(([regionId, cells]) => {
          const mask = masks.get(regionId);
          return cells.length > 0 && mask
            ? [{ regionId, walkableArea: cells.length * mask.cellSize * mask.cellSize }]
            : [];
        }),
      randomWalkablePoint: (regionId, rng) => {
        const mask = masks.get(regionId);
        const cell = rng.pick(reachable.get(regionId) ?? []);
        if (!mask || cell === undefined) return undefined;
        // Anywhere inside the cell, kept off its edges so the point stays in it.
        const { x, z } = mask.center(cell);
        const spread = mask.cellSize * 0.9;
        return {
          regionId,
          x: x + (rng.next() - 0.5) * spread,
          z: z + (rng.next() - 0.5) * spread,
        };
      },
    };
  }

  /** Metres per second: base speed times the best locomotion factor for this region kind. */
  #speed(speciesId: string, kind: RegionKind): number {
    const key = `${speciesId}|${kind}`;
    let speed = this.#speeds.get(key);
    if (speed === undefined) {
      const { registries } = this.state;
      const species = registries.species.get(speciesId);
      let factor = 0;
      for (const [capability, f] of Object.entries(species?.capabilities ?? {})) {
        const rule = registries.capabilities.get(capability)?.locomotion;
        if (rule?.regionKinds.includes(kind)) factor = Math.max(factor, f);
      }
      speed = (species?.baseSpeed ?? 0) * factor;
      this.#speeds.set(key, speed);
    }
    return speed;
  }

  /**
   * Locomotion (roadmap M3 task 8): kinematic movement along the path at the species speed.
   * Heading follows the direction of travel; height is never stored, it always comes from the
   * current region's surface. On a portal crossing the region changes on the shared cell edge.
   */
  #walk(creature: CreatureState, path: PathState): "moving" | "arrived" {
    this.#paths.set(creature.id, path);
    const kind = this.state.model.regions.get(creature.position.regionId)?.kind;
    let budget = kind ? this.#speed(creature.speciesId, kind) * this.tickSeconds : 0;
    while (budget > 0) {
      const target = path.points[path.next];
      if (!target) break;
      const here = creature.position;
      const dx = target.x - here.x;
      const dz = target.z - here.z;
      const distance = Math.hypot(dx, dz);
      if (distance > 1e-9) creature.heading = normalizeHeading(Math.atan2(dx, dz));
      const travel = Math.min(budget, distance);
      budget -= travel;
      const arrived = travel >= distance;
      const x = arrived ? target.x : here.x + (dx * travel) / distance;
      const z = arrived ? target.z : here.z + (dz * travel) / distance;
      if (target.regionId === here.regionId) {
        creature.position = { regionId: here.regionId, x, z };
      } else {
        // A crossing runs between two cell centres; past halfway the creature is in the next region.
        const previous = path.points[path.next - 1] ?? here;
        const half = Math.hypot(target.x - previous.x, target.z - previous.z) / 2;
        const pastHalf = distance - travel <= half;
        this.#place(
          creature,
          x,
          z,
          pastHalf ? target.regionId : here.regionId,
          pastHalf ? here.regionId : target.regionId,
          target.connectionId,
        );
      }
      if (!arrived) break;
      path.next++;
    }
    return path.next >= path.points.length ? "arrived" : "moving";
  }

  /**
   * Moves to (x, z) in `preferred`, or in `other` if only that region is walkable there. That
   * only happens exactly on the shared edge, which belongs to whichever cell `floor` picks.
   */
  #place(
    creature: CreatureState,
    x: number,
    z: number,
    preferred: string,
    other: string,
    connectionId: string | undefined,
  ) {
    const masks = this.#pathfinder(creature).navigation.masks;
    const regionId =
      !masks.get(preferred)?.isWalkableAt(x, z) && masks.get(other)?.isWalkableAt(x, z)
        ? other
        : preferred;
    const from = creature.position.regionId;
    creature.position = { regionId, x, z };
    if (regionId !== from) this.#enteredRegion(creature, from, regionId, connectionId ?? "");
  }

  #enteredRegion(creature: CreatureState, from: string, to: string, connectionId: string) {
    const base = { tick: this.tick, creatureId: creature.id };
    this.#emit({
      ...base,
      type: "entered_region",
      fromRegionId: from,
      toRegionId: to,
      connectionId,
    });
    // Structures are found through ownership, never by name (ADR 0004 §4).
    const structureId =
      this.#connections.get(connectionId)?.structureId ??
      this.state.model.regions.get(to)?.structureId;
    if (structureId === undefined || creature.usedStructures.includes(structureId)) return;
    creature.usedStructures.push(structureId);
    this.#emit({ ...base, type: "first_use_of_structure", structureId, connectionId });
  }
}
