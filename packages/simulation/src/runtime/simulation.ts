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
import {
  addEntries,
  type ActionCue,
  type Cue,
  type NeedType,
  type Registries,
} from "@living-diorama/extension-api";
import {
  isActionProvider,
  isBehaviorProvider,
  type ActionContext,
  type ActionProvider,
  type ActionResult,
  type ActionStart,
  type ActionStatus,
  type BehaviorMemory,
  type BehaviorProvider,
  type CreatureObservation,
  type PathState,
  type PlaceQueries,
  type PlaceView,
  type Proposal,
  type RunningAction,
  type WorldQueries,
} from "../creatures/contracts";
import { clamp01, speciesNeeds, speciesTraits } from "../creatures/individual";
import { copyKnowledge } from "../creatures/knowledge";
import { PERCEPTION_HZ, perceive, perceptionOffset, VISION_SENSE } from "../creatures/perception";
import { findSpot } from "../creatures/spots";
import type { Pathfinder } from "../navigation/pathfinder";
import { navProfile, profileForSpecies } from "../navigation/profile";
import type { Limit, RouteLegSnapshot, SimulationEvent, SimulationSnapshot } from "../protocol";
import type { ConnectionModel } from "../world/world-model";
import { Rng, type RngState } from "./rng";
import { dayPhaseAt, wrapMinutes, type DayPhase } from "./time-of-day";
import {
  normalizeHeading,
  WorldState,
  type CreatureState,
  type WorldStateOptions,
} from "./world-state";

// The tick loop (roadmap M3 tasks 6–11, ADR 0006 §7–§10, ADR 0018 §7–§9): actions advance every
// tick, needs change on simulation time, behaviors are evaluated only on triggers, locomotion is
// kinematic along planned routes, and a watchdog interrupts walking actions that make no progress.

/** An action that walks for this long without getting PROGRESS_DISTANCE further is stuck. */
const STUCK_SECONDS = 5;
const PROGRESS_DISTANCE = 0.05;
/** Wait before re-evaluating when no proposal could be started. */
const RETRY_SECONDS = 1;
/** A challenger must beat the running behavior's current utility by this much (ADR 0018 §8). */
export const INTERRUPT_MARGIN = 0.15;
/** Absorbs rounding, so that 0.25 beats 0.1 by the margin. */
const UTILITY_EPSILON = 1e-9;
/** Each creature reacts to a day-phase change after a random delay up to this long. */
export const PHASE_REACTION_SECONDS = 30;
const SECONDS_PER_HOUR = 3600;

/**
 * What started an evaluation besides the usual ones (the action ending, the watchdog, a retry,
 * a first decision): a need rising across one of its trigger values, or the day phase changing.
 */
export type DecisionTrigger =
  { kind: "need"; need: string; threshold: number } | { kind: "day_phase"; phase: DayPhase };

/** One behavior evaluation: what was proposed, what was chosen and how starting it went. */
export interface DecisionTrace {
  tick: number;
  creatureId: string;
  position: RegionPosition;
  /** How the previous action ended; absent for a creature's first decision. */
  lastResult?: ActionResult;
  /**
   * Every need and day-phase trigger of this tick, in order: each trigger value a need rose
   * across (needs in declaration order), then the day-phase reaction. Empty for an evaluation
   * started only by the usual triggers.
   */
  triggers: DecisionTrigger[];
  /** The creature's need values at the decision. */
  needs: Record<string, number>;
  /**
   * When evaluated while an action runs: that action, the behavior that owns it and its current
   * utility, which a challenger must beat by `INTERRUPT_MARGIN`.
   */
  running?: { action: string; behavior: string; utility: number };
  /** Every behavior's proposal, with its reason. */
  candidates: { behavior: string; proposal: Proposal | null }[];
  chosen?: { behavior: string; action: string; params?: unknown };
  /** `kept`: evaluated while an action runs, and no challenger beat it. */
  result: "started" | "rejected" | "no_proposal" | "kept";
  reason?: string;
  detail?: Record<string, unknown>;
}

/** What the engine derives once per species. */
interface SpeciesProfile {
  behaviors: { id: string; provider: BehaviorProvider | undefined }[];
  needs: readonly NeedType[];
  /** Every registered trait, with defaults; frozen, as actions and behaviors share it. */
  traits: Readonly<Record<string, number>>;
  /** The species' senses before individual variation. */
  senses: Readonly<Record<string, number>>;
  /** Per need ID, the value of its rate trait (1 without one). */
  rateScales: Record<string, number>;
}

/** A behavior's proposal with its scratch memory and random stream. */
interface Evaluation {
  behavior: string;
  proposal: Proposal | null;
  memory: BehaviorMemory;
  rng: RngState;
}
type Chosen = Evaluation & { proposal: Proposal };

const usable = (proposal: Proposal | null | undefined): proposal is Proposal =>
  proposal !== null && proposal !== undefined && Number.isFinite(proposal.utility);

/** A deep copy of plain data (behavior memory). */
function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clonePlain(v as unknown)]),
    ) as T;
  }
  return value;
}

/** A species registered while the world runs, and where its creatures don't fit. */
export interface RegisteredSpecies {
  species: SpeciesDefinition;
  limits: Limit[];
}

export interface SnapshotOptions {
  paused?: boolean;
  /** Adds debug data: remaining routes, need values, knowledge and home. */
  debug?: boolean;
}

export interface SpawnOptions {
  /** Released from the Studio (ADR 0018 amendments, §13). */
  released?: boolean;
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
  readonly tickRateHz: number;
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
  readonly #profiles = new Map<string, SpeciesProfile>();
  /** The action cue each creature showed on its last tick, if any. */
  readonly #actionCues = new Map<string, ActionCue>();
  /** Each creature's perception offset within the scan period. */
  readonly #perceptionOffsets = new Map<string, number>();
  /** Ticks between two perception scans of one creature. */
  readonly #perceptionTicks: number;
  #events: SimulationEvent[] = [];

  private constructor(
    readonly state: WorldState,
    tickRateHz: number,
    onTrace: ((trace: DecisionTrace) => void) | undefined,
  ) {
    this.tickRateHz = tickRateHz;
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
    this.#perceptionTicks = Math.max(1, Math.round(tickRateHz / PERCEPTION_HZ));
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

  /**
   * Adds a creature; it makes its first decision on the next step. `released`: it comes from the
   * Studio, which behaviors see as `releasedAtTick` (ADR 0018 amendments, §13).
   */
  spawn(
    speciesId: string,
    spawnPointId?: string,
    { released = false }: SpawnOptions = {},
  ): Result<CreatureState> {
    const result = this.state.spawn(speciesId, spawnPointId);
    if (result.ok) {
      const creature = result.value;
      if (released) creature.releasedAtTick = this.tick;
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
      this.#actionCues.delete(creatureId);
      this.#perceptionOffsets.delete(creatureId);
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

  /**
   * `debug` adds each walking creature's remaining route (ADR 0007 §10) and its need values,
   * knowledge and home (ADR 0018 §15), for the dev overlays.
   */
  snapshot({ paused = false, debug = false }: SnapshotOptions = {}): SimulationSnapshot {
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
          cues: this.#cues(c),
          ...(debug
            ? {
                ...(this.#paths.has(c.id) ? { route: this.#route(c.id) } : {}),
                needs: { ...c.needs },
                knowledge: copyKnowledge(c.knowledge),
                home: c.home,
              }
            : {}),
        };
      }),
    };
  }

  /**
   * What the creature shows (ADR 0018 §15): its action's cue while that action isn't walking,
   * then each need's cue from the value the need declares.
   */
  #cues(creature: CreatureState): Cue[] {
    const cues: Cue[] = [];
    const action = this.#actionCues.get(creature.id);
    if (action) cues.push(action);
    for (const need of this.#profile(creature.speciesId).needs) {
      if (need.cue && (creature.needs[need.id] ?? 0) >= need.cue.from) cues.push(need.cue.cue);
    }
    return cues;
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
   * one event from the old phase to the new. Each creature reacts to it as a decision trigger
   * (ADR 0018 §7) after its own random delay of up to 30 s, so they don't all decide at once.
   * The delay comes from a stream forked off the creature's own, so its behaviors' sequence
   * doesn't shift.
   */
  #dayPhaseChanged(from: DayPhase, to: DayPhase) {
    this.state.dayPhase = to;
    this.#emit({ type: "day_phase_changed", tick: this.tick, from, to });
    for (const creature of this.state.creatures.values()) {
      const delay = new Rng(creature.rng)
        .fork(`day-phase@${this.tick}`)
        .range(0, PHASE_REACTION_SECONDS);
      creature.phaseReactionTick = this.tick + Math.round(delay * this.tickRateHz);
    }
  }

  /** What the engine derives once per species: its behaviors, needs and traits. */
  #profile(speciesId: string): SpeciesProfile {
    let profile = this.#profiles.get(speciesId);
    if (!profile) {
      const { registries } = this.state;
      const species = registries.species.get(speciesId);
      // Spawning already checked that the species is registered.
      if (!species) throw new Error(`Species "${speciesId}" is not registered`);
      const traits = Object.freeze(speciesTraits(species, registries));
      const needs = speciesNeeds(species, registries);
      profile = {
        behaviors: species.behaviors.map((id) => ({ id, provider: this.#behaviors.get(id) })),
        needs,
        traits,
        senses: species.senses,
        rateScales: Object.fromEntries(
          needs.map((n) => [n.id, n.rateTrait === undefined ? 1 : (traits[n.rateTrait] ?? 1)]),
        ),
      };
      this.#profiles.set(speciesId, profile);
    }
    return profile;
  }

  /**
   * One creature's tick: its action steps, its needs change, and its behaviors are evaluated on
   * a trigger. With an action running, a trigger may interrupt it (ADR 0018 §8).
   */
  #stepCreature(creature: CreatureState) {
    const profile = this.#profile(creature.speciesId);
    this.#perceive(creature, profile);
    const before = profile.needs.length > 0 ? { ...creature.needs } : undefined;
    const running = creature.action;
    let cue: ActionCue | undefined;
    let asleep = false;
    if (running) {
      const provider = this.#actions.get(running.id);
      const activity = { walked: false };
      const status: ActionStatus = provider
        ? provider.step(running.state, this.#actionContext(creature, profile, activity))
        : { status: "failed", reason: "unknown_action" };
      asleep = status.asleep === true;
      if (status.status === "running") {
        // Standing still to eat or sleep is not being stuck (ADR 0018 amendments).
        if (activity.walked) this.#watch(creature, profile, running.id);
        else if (status.cue !== undefined && status.cue === provider?.cue) cue = status.cue;
      } else {
        this.#finish(
          creature,
          status.status === "done"
            ? { action: running.id, outcome: "done" }
            : { action: running.id, outcome: "failed", reason: status.reason },
        );
      }
    }
    creature.asleep = asleep;

    const triggers = before ? this.#integrateNeeds(creature, profile, before) : [];
    if (creature.phaseReactionTick !== undefined && this.tick >= creature.phaseReactionTick) {
      delete creature.phaseReactionTick;
      triggers.push({ kind: "day_phase", phase: this.state.dayPhase });
    }
    // Several triggers on one tick make one evaluation, which records them all.
    if (triggers.length > 0) {
      if (creature.action) this.#reconsider(creature, profile, triggers);
      else creature.decideAtTick = Math.min(creature.decideAtTick, this.tick);
    }
    if (!creature.action && this.tick >= creature.decideAtTick) {
      this.#decide(creature, profile, triggers);
    }
    // An action's cue shows while that action still runs after this tick.
    if (cue !== undefined && creature.action === running) this.#actionCues.set(creature.id, cue);
    else this.#actionCues.delete(creature.id);
  }

  /**
   * Perception (ADR 0018 §10): once a second, at a tick offset of its own, the creature notes the
   * places within sight or touch and the grid cell it is in. The engine writes its knowledge,
   * since behaviors see only copies.
   */
  #perceive(creature: CreatureState, profile: SpeciesProfile) {
    const period = this.#perceptionTicks;
    let offset = this.#perceptionOffsets.get(creature.id);
    if (offset === undefined) {
      offset = perceptionOffset(creature.id, period);
      this.#perceptionOffsets.set(creature.id, offset);
    }
    if ((this.tick + offset) % period !== 0) return;
    const vision = profile.senses[VISION_SENSE];
    perceive({
      knowledge: creature.knowledge,
      x: creature.position.x,
      z: creature.position.z,
      vision:
        vision === undefined ? undefined : vision * (creature.variation.senses[VISION_SENSE] ?? 1),
      tick: this.tick,
      propsByAffordance: this.state.model.propsByAffordance,
      affordance: (id) => this.state.registries.affordances.get(id),
    });
  }

  /**
   * Needs change on simulation time at their awake or asleep rate, scaled by the rate trait and
   * the individual's variation, and stay in [0, 1]. Returns every trigger value a need rose across
   * this tick (`before < t && now >= t`, so the trigger at 1 fires though 1 is the cap).
   */
  #integrateNeeds(
    creature: CreatureState,
    profile: SpeciesProfile,
    before: Readonly<Record<string, number>>,
  ): DecisionTrigger[] {
    const hours = this.tickSeconds / SECONDS_PER_HOUR;
    const triggers: DecisionTrigger[] = [];
    for (const need of profile.needs) {
      const perHour = creature.asleep ? need.perHour.asleep : need.perHour.awake;
      const scale = (profile.rateScales[need.id] ?? 1) * (creature.variation.needs[need.id] ?? 1);
      const now = clamp01((creature.needs[need.id] ?? 0) + perHour * scale * hours);
      creature.needs[need.id] = now;
      const was = before[need.id] ?? 0;
      for (const threshold of need.triggers) {
        if (was < threshold && now >= threshold) {
          triggers.push({ kind: "need", need: need.id, threshold });
        }
      }
    }
    return triggers;
  }

  #finish(creature: CreatureState, result: ActionResult) {
    creature.lastResult = result;
    delete creature.action;
    this.#paths.delete(creature.id);
    creature.decideAtTick = this.tick;
  }

  /**
   * The stuck watchdog: interrupts an action that walks but has made no progress for a while.
   * Called only on ticks on which the action walked.
   */
  #watch(creature: CreatureState, profile: SpeciesProfile, actionId: string) {
    const { x, z } = creature.position;
    const anchor = creature.progress;
    if (Math.hypot(x - anchor.x, z - anchor.z) >= PROGRESS_DISTANCE) {
      creature.progress = { x, z, stalledTicks: 0 };
      return;
    }
    const ticksStuck = ++anchor.stalledTicks;
    if (ticksStuck < this.#stuckTicks) return;
    this.#emit({
      type: "creature_stuck",
      tick: this.tick,
      creatureId: creature.id,
      position: { ...creature.position },
      ticksStuck,
    });
    if (creature.action) this.#interrupted(creature, profile, creature.action, "stuck");
    this.#finish(creature, { action: actionId, outcome: "interrupted", reason: "stuck" });
  }

  /**
   * Lets the running action react to being cut short (`ActionProvider.interrupted`), and wakes
   * the creature: whatever replaces the action reports its own state from the next tick.
   */
  #interrupted(
    creature: CreatureState,
    profile: SpeciesProfile,
    action: { id: string; state: unknown },
    reason: string,
  ) {
    this.#actions
      .get(action.id)
      ?.interrupted?.(action.state, this.#actionContext(creature, profile), reason);
    creature.asleep = false;
  }

  /** What a behavior sees: copies, so evaluating changes nothing about the creature. */
  #observation(
    creature: CreatureState,
    profile: SpeciesProfile,
    action?: RunningAction,
  ): CreatureObservation {
    return {
      tick: this.tick,
      tickSeconds: this.tickSeconds,
      creature: {
        id: creature.id,
        speciesId: creature.speciesId,
        position: { ...creature.position },
        heading: creature.heading,
        ...(creature.releasedAtTick === undefined
          ? {}
          : { releasedAtTick: creature.releasedAtTick }),
      },
      ...(creature.lastResult ? { lastResult: { ...creature.lastResult } } : {}),
      ...(action ? { action } : {}),
      dayPhase: this.state.dayPhase,
      needs: { ...creature.needs },
      traits: profile.traits,
      senses: Object.fromEntries(
        Object.entries(profile.senses).map(([id, value]) => [
          id,
          value * (creature.variation.senses[id] ?? 1),
        ]),
      ),
      knowledge: copyKnowledge(creature.knowledge),
      home: creature.home,
      world: this.#queries(creature),
    };
  }

  /**
   * Evaluates every behavior of the species on its own copy of its memory and of the creature's
   * random stream, so a behavior that isn't chosen leaves no trace (ADR 0018 §8 amendments).
   */
  #evaluate(
    creature: CreatureState,
    profile: SpeciesProfile,
    observation: CreatureObservation,
  ): Evaluation[] {
    return profile.behaviors.map(({ id, provider }) => {
      const memory = clonePlain(creature.memory[id] ?? {});
      const rng: RngState = { words: [...creature.rng.words], key: creature.rng.key };
      const proposal = provider?.evaluate(observation, memory, new Rng(rng)) ?? null;
      return { behavior: id, proposal, memory, rng };
    });
  }

  /** The highest usable proposal, the first on a tie, leaving out `excluded`'s. */
  #best(evaluated: Evaluation[], excluded?: string): Chosen | undefined {
    let best: Chosen | undefined;
    for (const e of evaluated) {
      if (e.behavior === excluded || !usable(e.proposal)) continue;
      if (!best || e.proposal.utility > best.proposal.utility)
        best = { ...e, proposal: e.proposal };
    }
    return best;
  }

  /** Keeps the chosen behavior's memory and random-stream use. */
  #commit(creature: CreatureState, chosen: Chosen) {
    creature.memory[chosen.behavior] = chosen.memory;
    creature.rng = chosen.rng;
  }

  /**
   * Moves the creature's random stream on by one draw when an evaluation commits nothing, so the
   * next evaluation (a retry or another trigger) doesn't replay the same draws.
   */
  #advance(creature: CreatureState) {
    new Rng(creature.rng).nextUint32();
  }

  #traceBase(creature: CreatureState, triggers: DecisionTrigger[]) {
    return {
      tick: this.tick,
      creatureId: creature.id,
      position: { ...creature.position },
      ...(creature.lastResult ? { lastResult: { ...creature.lastResult } } : {}),
      triggers,
      needs: { ...creature.needs },
    };
  }

  /** Starts the chosen proposal's action, if its behavior declared it and it can start. */
  #start(creature: CreatureState, profile: SpeciesProfile, { behavior, proposal }: Chosen) {
    const provider = this.#actions.get(proposal.action);
    // A behavior may only start actions it declared as dependencies.
    const declared = profile.behaviors
      .find((b) => b.id === behavior)
      ?.provider?.dependencies?.some((d) => d.registry === "actions" && d.id === proposal.action);
    const start: ActionStart = !provider
      ? { ok: false, reason: "unknown_action" }
      : !declared
        ? { ok: false, reason: "undeclared_action" }
        : provider.start(proposal.params, this.#actionContext(creature, profile));
    if (start.ok) {
      creature.action = {
        id: proposal.action,
        behavior,
        state: start.state,
        startTick: this.tick,
      };
      creature.progress = { x: creature.position.x, z: creature.position.z, stalledTicks: 0 };
    }
    return start;
  }

  /** A decision with no action running (ADR 0006 §8): the highest proposal wins. */
  #decide(creature: CreatureState, profile: SpeciesProfile, triggers: DecisionTrigger[]) {
    const evaluated = this.#evaluate(creature, profile, this.#observation(creature, profile));
    const best = this.#best(evaluated);
    const trace: DecisionTrace = {
      ...this.#traceBase(creature, triggers),
      candidates: evaluated.map(({ behavior, proposal }) => ({ behavior, proposal })),
      result: "no_proposal",
    };
    if (!best) {
      this.#advance(creature);
      creature.decideAtTick = this.tick + this.#retryTicks;
      this.#onTrace?.(trace);
      return;
    }
    this.#commit(creature, best);
    const { action, params } = best.proposal;
    trace.chosen = { behavior: best.behavior, action, ...(params === undefined ? {} : { params }) };
    const start = this.#start(creature, profile, best);
    if (start.ok) {
      trace.result = "started";
    } else {
      creature.lastResult = { action, outcome: "failed", reason: start.reason };
      creature.decideAtTick = this.tick + this.#retryTicks;
      trace.result = "rejected";
      trace.reason = start.reason;
    }
    if (start.detail) trace.detail = start.detail;
    this.#onTrace?.(trace);
  }

  /**
   * A trigger while an action runs (ADR 0018 §8 and amendments). Every behavior is evaluated.
   * The behavior that owns the action proposes its current utility, which sets the bar (0 if it
   * proposes nothing), and its proposals never challenge. The best other proposal replaces the
   * action only if it beats the bar by `INTERRUPT_MARGIN` and starts; the old action then ends as
   * `interrupted` (`outranked`). A challenger that fails to start leaves the action running.
   */
  #reconsider(creature: CreatureState, profile: SpeciesProfile, triggers: DecisionTrigger[]) {
    const running = creature.action;
    if (!running || !profile.behaviors.some((b) => b.id !== running.behavior)) return;
    const observation = this.#observation(creature, profile, {
      id: running.id,
      behavior: running.behavior,
      startTick: running.startTick,
    });
    const evaluated = this.#evaluate(creature, profile, observation);
    const own = evaluated.find((e) => e.behavior === running.behavior)?.proposal;
    const bar = usable(own) ? own.utility : 0;
    const best = this.#best(evaluated, running.behavior);
    const trace: DecisionTrace = {
      ...this.#traceBase(creature, triggers),
      running: { action: running.id, behavior: running.behavior, utility: bar },
      candidates: evaluated.map(({ behavior, proposal }) => ({ behavior, proposal })),
      result: "kept",
    };
    if (!best || best.proposal.utility - bar < INTERRUPT_MARGIN - UTILITY_EPSILON) {
      this.#advance(creature);
      this.#onTrace?.(trace);
      return;
    }
    this.#commit(creature, best);
    const { action, params } = best.proposal;
    trace.chosen = { behavior: best.behavior, action, ...(params === undefined ? {} : { params }) };
    const start = this.#start(creature, profile, best);
    if (start.ok) {
      this.#interrupted(creature, profile, running, "outranked");
      this.#paths.delete(creature.id);
      creature.lastResult = { action: running.id, outcome: "interrupted", reason: "outranked" };
      trace.result = "started";
    } else {
      // The running action carries on, but the chosen behavior learns its proposal failed.
      creature.lastResult = { action, outcome: "failed", reason: start.reason };
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

  /** `activity` records whether the action walked this tick, for the watchdog and cues. */
  #actionContext(
    creature: CreatureState,
    profile: SpeciesProfile,
    activity?: { walked: boolean },
  ): ActionContext {
    return {
      ...this.#placeQueries(creature),
      tick: this.tick,
      tickSeconds: this.tickSeconds,
      get position() {
        return creature.position;
      },
      dayPhase: this.state.dayPhase,
      get needs() {
        return creature.needs;
      },
      traits: profile.traits,
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
      walk: (path) => {
        if (activity) activity.walked = true;
        return this.#walk(creature, profile, path);
      },
      adjustNeed: (id, delta) => {
        if (!Object.hasOwn(creature.needs, id) || !Number.isFinite(delta)) return;
        creature.needs[id] = clamp01((creature.needs[id] ?? 0) + delta);
      },
      face: (x, z) => {
        const dx = x - creature.position.x;
        const dz = z - creature.position.z;
        if (Math.hypot(dx, dz) > 1e-9) creature.heading = normalizeHeading(Math.atan2(dx, dz));
      },
      emit: (event) => this.#emit({ ...event, tick: this.tick, creatureId: creature.id }),
      get home() {
        return creature.home;
      },
      setHome: (placementId) => {
        const previous = creature.home;
        if (placementId === previous || !this.state.model.propsById.has(placementId)) return;
        creature.home = placementId;
        this.#emit({
          type: "new_home_selected",
          tick: this.tick,
          creatureId: creature.id,
          placementId,
          previous,
        });
      },
    };
  }

  /** A prop placement as behaviors and actions see it. Its affordances are frozen. */
  #placeView(placementId: string): PlaceView | undefined {
    const prop = this.state.model.propsById.get(placementId);
    if (!prop) return undefined;
    const { x, y, z } = prop.transform.position;
    return { id: prop.id, x, y, z, blockRadius: prop.blockRadius, affordances: prop.affordances };
  }

  /** Place lookups and the creature's own spot at a place (ADR 0018 §11). */
  #placeQueries(creature: CreatureState): PlaceQueries {
    return {
      place: (placementId) => this.#placeView(placementId),
      spotAt: (placementId) => {
        const place = this.#placeView(placementId);
        if (!place) return undefined;
        const pathfinder = this.#pathfinder(creature);
        return findSpot({
          place,
          radius: pathfinder.navigation.profile.radius,
          angle: creature.spotAngle,
          masks: pathfinder.navigation.masks,
          reachable: pathfinder.reachableCells(creature.position),
        });
      },
    };
  }

  /**
   * What behaviors may query: cells the creature can reach from where it stands, places, and
   * route lengths.
   */
  #queries(creature: CreatureState): WorldQueries {
    const pathfinder = this.#pathfinder(creature);
    const reachable = pathfinder.reachableCells(creature.position);
    const { masks } = pathfinder.navigation;
    const here = creature.position;
    /** Per distance asked for, the reachable cells whose centres lie within it. */
    const near = new Map<number, { regionId: string; cell: number }[]>();
    const point = (regionId: string, cell: number, rng: Rng): RegionPosition | undefined => {
      const mask = masks.get(regionId);
      if (!mask) return undefined;
      // Anywhere inside the cell, kept off its edges so the point stays in it.
      const { x, z } = mask.center(cell);
      const spread = mask.cellSize * 0.9;
      return {
        regionId,
        x: x + (rng.next() - 0.5) * spread,
        z: z + (rng.next() - 0.5) * spread,
      };
    };
    return {
      ...this.#placeQueries(creature),
      routeLength: (destination) => {
        const result = pathfinder.findRoute(creature.position, destination);
        return result.ok ? result.route.length : undefined;
      },
      reachableRegions: () =>
        [...reachable].flatMap(([regionId, cells]) => {
          const mask = masks.get(regionId);
          return cells.length > 0 && mask
            ? [{ regionId, walkableArea: cells.length * mask.cellSize * mask.cellSize }]
            : [];
        }),
      randomWalkablePoint: (regionId, rng) => {
        const cell = rng.pick(reachable.get(regionId) ?? []);
        return cell === undefined ? undefined : point(regionId, cell, rng);
      },
      randomWalkablePointWithin: (maxDistance, rng) => {
        let cells = near.get(maxDistance);
        if (!cells) {
          cells = [];
          for (const [regionId, list] of reachable) {
            const mask = masks.get(regionId);
            if (!mask) continue;
            for (const cell of list) {
              const { x, z } = mask.center(cell);
              if (Math.hypot(x - here.x, z - here.z) <= maxDistance) cells.push({ regionId, cell });
            }
          }
          near.set(maxDistance, cells);
        }
        const picked = rng.pick(cells);
        return picked && point(picked.regionId, picked.cell, rng);
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
   * Locomotion (roadmap M3 task 8): kinematic movement along the path at the species speed,
   * slowed by any need at 1 that declares an `atMax` speed factor (ADR 0018 §18).
   * Heading follows the direction of travel; height is never stored, it always comes from the
   * current region's surface. On a portal crossing the region changes on the shared cell edge.
   */
  #walk(creature: CreatureState, profile: SpeciesProfile, path: PathState): "moving" | "arrived" {
    this.#paths.set(creature.id, path);
    const kind = this.state.model.regions.get(creature.position.regionId)?.kind;
    const speed = kind ? this.#speed(creature.speciesId, kind) : 0;
    let budget = speed * atMaxSpeedFactor(creature, profile) * this.tickSeconds;
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

/** The product of the speed factors of the creature's needs that are at 1 (ADR 0018 §18). */
function atMaxSpeedFactor(creature: CreatureState, profile: SpeciesProfile): number {
  let factor = 1;
  for (const need of profile.needs) {
    const speedFactor = need.atMax?.speedFactor;
    if (speedFactor !== undefined && (creature.needs[need.id] ?? 0) >= 1) factor *= speedFactor;
  }
  return factor;
}
