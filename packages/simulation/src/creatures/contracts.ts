import type { RegionPosition } from "@living-diorama/content-schema";
import type { ActionCue, ActionType, BehaviorType } from "@living-diorama/extension-api";
import type { RouteResult } from "../navigation/pathfinder";
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

/** What an action may do to the world. The engine applies every change itself. */
export interface ActionContext {
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
   * Only ticks on which an action walks count towards the stuck watchdog.
   */
  walk(path: PathState): "moving" | "arrived";
  /**
   * Changes one of the creature's needs by `delta`, clamped to [0, 1], at once (ADR 0018
   * amendments, §11). A need the creature doesn't have is ignored.
   */
  adjustNeed(id: string, delta: number): void;
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

/** Read-only world queries for behaviors. Perception (ADR 0018 §10) narrows them from PR 4a. */
export interface WorldQueries {
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
  };
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
   * (ADR 0006 §8, ADR 0018 §7). Every behavior is evaluated on its own copy of `memory` and of
   * the creature's random stream; only the chosen behavior's changes to them are kept. A behavior
   * that reads a need declares it as a `needs` dependency, which also gives the creature the need.
   */
  evaluate(observation: CreatureObservation, memory: BehaviorMemory, rng: Rng): Proposal | null;
}

export function isBehaviorProvider(entry: BehaviorType): entry is BehaviorProvider {
  return typeof (entry as Partial<BehaviorProvider>).evaluate === "function";
}
