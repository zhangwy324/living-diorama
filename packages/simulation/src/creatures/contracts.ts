import type { RegionPosition } from "@living-diorama/content-schema";
import type { ActionCue, ActionType, BehaviorType } from "@living-diorama/extension-api";
import type { RouteResult } from "../navigation/pathfinder";
import type { ActionEvent } from "../protocol";
import type { Rng } from "../runtime/rng";
import type { DayPhase } from "../runtime/time-of-day";
import type { CreatureKnowledge } from "./knowledge";

// The code contracts behind action and behavior registry entries (ADR 0006 §7, §8). Like
// surface providers, an implementation is a registered entry with extra methods; an entry
// registered without them is reported when the simulation is created.

/** How a creature's previous action ended. */
export interface ActionResult {
  action: string;
  outcome: "done" | "failed" | "interrupted";
  reason?: string;
}

/** A path being walked. Plain data, stored in the action's state. */
export interface PathState {
  /** Waypoints still to reach, in order; the creature starts from where it stands. */
  points: PathPoint[];
  /** Index of the waypoint being walked to. */
  next: number;
}

/** A waypoint. `connectionId` is set on the first waypoint after a portal crossing. */
export interface PathPoint extends RegionPosition {
  connectionId?: string;
}

/**
 * A prop placement as behaviors and actions see it (ADR 0018 §10–§11). Engine code finds places
 * by their affordances, never by their prop type.
 */
export interface PlaceView {
  /** Placement ID. */
  readonly id: string;
  /** World position. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** In world metres, scale applied. */
  readonly blockRadius: number;
  /** Affordance ID → params, parsed by the affordance type's schema. */
  readonly affordances: Readonly<Record<string, unknown>>;
}

/** Queries about places that behaviors and actions share. */
export interface PlaceQueries {
  /** The prop placement with this ID, or undefined. */
  place(placementId: string): PlaceView | undefined;
  /**
   * Where the creature stands to use a place (ADR 0018 §11 and amendments): at its own angle
   * around the place, just clear of it (block radius + creature radius + 0.3 m), or else the
   * nearest walkable point it can reach close to there. Undefined if there is none or no such
   * place.
   */
  spotAt(placementId: string): RegionPosition | undefined;
}

/** What an action may do to the world. The engine applies every change itself. */
export interface ActionContext extends PlaceQueries {
  readonly tick: number;
  readonly tickSeconds: number;
  readonly position: Readonly<RegionPosition>;
  /** The day phase as of this tick (ADR 0018 §5). */
  readonly dayPhase: DayPhase;
  /** The creature's needs, ID → value in [0, 1]. Change them through `adjustNeed`. */
  readonly needs: Readonly<Record<string, number>>;
  /** Every registered trait: the species' value or the registry default. */
  readonly traits: Readonly<Record<string, number>>;
  /** Plans a route from the creature to `destination`. A failure emits `path_failed`. */
  planRoute(destination: RegionPosition): RouteResult;
  /**
   * Moves the creature one tick along `path` at its species speed, switching region at portals.
   * Only ticks on which an action walks count towards the stuck watchdog, and an action's cue is
   * hidden on them. Any call counts as walking, also on a path already walked to its end (which
   * moves nothing), so an action that has arrived should stop calling it.
   */
  walk(path: PathState): "moving" | "arrived";
  /**
   * Changes one of the creature's needs by `delta`, clamped to [0, 1], at once (ADR 0018
   * amendments, §11). A need the creature doesn't have is ignored.
   */
  adjustNeed(id: string, delta: number): void;
  /**
   * Turns the creature to face world point (x, z) at once, e.g. the food it eats. Does nothing if
   * it stands there. Walking turns it to its direction of travel again.
   */
  face(x: number, z: number): void;
  /** Emits an event about the creature; the engine adds the tick and the creature ID. */
  emit(event: ActionEvent): void;
  /** The placement ID of the creature's home (ADR 0018 §14), or null if it has none. */
  readonly home: string | null;
  /**
   * Makes the prop placement `placementId` the creature's home and emits `new_home_selected`.
   * Does nothing if there is no such placement or it is home already.
   */
  setHome(placementId: string): void;
}

export type ActionStart =
  | {
      ok: true;
      /** The action's own state: plain data, so it can be saved. */
      state: unknown;
      /** Extra facts for the decision trace, e.g. the planned route. */
      detail?: Record<string, unknown>;
    }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

/** What an action reports about the creature on each step, besides its progress. */
export interface StepReport {
  /** The creature slept this tick, so its needs change at their asleep rates. */
  asleep?: boolean;
  /**
   * The cue the creature shows this tick. Shown only if it is the action type's declared `cue`
   * and the action didn't walk this tick (ADR 0018 amendments, §15).
   */
  cue?: ActionCue;
}

export type ActionStatus = (
  { status: "running" } | { status: "done" } | { status: "failed"; reason: string }
) &
  StepReport;

/** An action type with its implementation, registered in the `actions` registry. */
export interface ActionProvider extends ActionType {
  /** Checks preconditions and params, and returns the initial state. */
  start(params: unknown, context: ActionContext): ActionStart;
  /** Advances one tick. `state` is the value `start` returned, changed in place. */
  step(state: unknown, context: ActionContext): ActionStatus;
  /**
   * Called when the engine ends the action before `step` reported it finished: a challenger
   * outranked it (`outranked`) or the watchdog stopped it (`stuck`). For what an action must
   * do when cut short, e.g. a sleeper emitting `woke_up`. Not called on despawn.
   */
  interrupted?(state: unknown, context: ActionContext, reason: string): void;
}

export function isActionProvider(entry: ActionType): entry is ActionProvider {
  const candidate = entry as Partial<ActionProvider>;
  return typeof candidate.start === "function" && typeof candidate.step === "function";
}

/** A region the creature can get to from where it stands. */
export interface ReachableRegion {
  regionId: string;
  /** Walkable area the creature can reach in this region, in square metres. */
  walkableArea: number;
}

/**
 * Read-only world queries for behaviors. What a creature knows of places comes from
 * `observation.knowledge`, which perception fills (ADR 0018 §10); `place` only looks one up.
 */
export interface WorldQueries extends PlaceQueries {
  /**
   * Regions with walkable area the creature can reach from where it stands, its own included. A
   * creature too big for a bridge or a gap never sees what lies beyond it (ADR 0013).
   */
  reachableRegions(): readonly ReachableRegion[];
  /**
   * A uniformly random point on a cell of the region the creature can reach, or undefined if it
   * can reach none.
   */
  randomWalkablePoint(regionId: string, rng: Rng): RegionPosition | undefined;
  /**
   * A uniformly random point on a cell the creature can reach, in any region, whose centre lies
   * within `maxDistance` metres (straight line) of the creature; undefined if there is none.
   */
  randomWalkablePointWithin(maxDistance: number, rng: Rng): RegionPosition | undefined;
  /**
   * The length in metres of the route the creature would walk to `destination`, or undefined if
   * it has none. Plans a route, so a behavior should ask for a few candidates only. Emits nothing.
   */
  routeLength(destination: RegionPosition): number | undefined;
}

/** The action a creature is running and the behavior that chose it. */
export interface RunningAction {
  readonly id: string;
  readonly behavior: string;
  readonly startTick: number;
}

/** What a behavior sees. Copies, so a behavior cannot change the creature through it. */
export interface CreatureObservation {
  readonly tick: number;
  readonly tickSeconds: number;
  readonly creature: {
    readonly id: string;
    readonly speciesId: string;
    readonly position: Readonly<RegionPosition>;
    readonly heading: number;
    /** The tick it was released from the Studio at, if it was (ADR 0018 amendments, §13). */
    readonly releasedAtTick?: number;
  };
  /**
   * How the creature's last action ended, or how the last action chosen for it failed to start,
   * also when that was a challenger and the running action carried on (ADR 0018 §8).
   */
  readonly lastResult?: Readonly<ActionResult>;
  /**
   * The running action, when behaviors are evaluated on a trigger while it runs (ADR 0018 §8).
   * The behavior that owns it is asked for its current utility, which challengers must beat.
   */
  readonly action?: RunningAction;
  readonly dayPhase: DayPhase;
  /** The creature's needs, ID → value in [0, 1]: those its species' behaviors depend on. */
  readonly needs: Readonly<Record<string, number>>;
  /** Every registered trait: the species' value or the registry default. */
  readonly traits: Readonly<Record<string, number>>;
  /** The senses the species has, with this individual's variation applied. */
  readonly senses: Readonly<Record<string, number>>;
  readonly knowledge: Readonly<CreatureKnowledge>;
  /** The placement ID of the creature's home, or null if it has none. */
  readonly home: string | null;
  readonly world: WorldQueries;
}

/** A behavior's suggestion. The engine validates it and plans any path itself. */
export interface Proposal {
  action: string;
  params?: unknown;
  utility: number;
  /** Why, in a few words, for decision traces. */
  reason?: string;
}

/** Plain data the engine keeps per creature and behavior, for cooldowns and hysteresis. */
export type BehaviorMemory = Record<string, unknown>;

/** A behavior type with its implementation, registered in the `behaviors` registry. */
export interface BehaviorProvider extends BehaviorType {
  /**
   * Proposes the next action, or null. Called only on a trigger: the creature's action finished,
   * failed or was interrupted, a need rose across a trigger value, or the day phase changed
   * (ADR 0006 §8, ADR 0018 §7). A behavior that reads a need declares it as a `needs`
   * dependency, which also gives the creature the need.
   *
   * - **Continuing.** While an action runs, `observation.action` names it and the behavior that
   *   owns it. The owner is asked for its utility for continuing that action, and its proposal
   *   is used only as that bar, never to replace the action. An owner that returns null sets the
   *   bar to 0, so any other proposal of at least 0.15 interrupts its action.
   * - **Memory.** Each behavior gets its own copy of `memory`, and changes to it are kept only
   *   if the behavior is chosen. Nothing written while not chosen survives, so cooldowns and
   *   anything a behavior must not forget come from the observation (its `lastResult`, running
   *   `action`, `knowledge` or the tick), not from memory alone.
   * - **Random draws.** Every behavior in one evaluation starts from the same position of the
   *   creature's stream, so they see the same draws. Only the chosen behavior's use advances the
   *   stream; an evaluation that chooses nothing advances it by one draw.
   */
  evaluate(observation: CreatureObservation, memory: BehaviorMemory, rng: Rng): Proposal | null;
}

export function isBehaviorProvider(entry: BehaviorType): entry is BehaviorProvider {
  return typeof (entry as Partial<BehaviorProvider>).evaluate === "function";
}
