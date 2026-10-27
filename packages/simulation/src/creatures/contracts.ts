import type { RegionPosition } from "@living-diorama/content-schema";
import type { ActionType, BehaviorType } from "@living-diorama/extension-api";
import type { RouteResult } from "../navigation/pathfinder";
import type { Rng } from "../runtime/rng";

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
  /** Plans a route from the creature to `destination`. A failure emits `path_failed`. */
  planRoute(destination: RegionPosition): RouteResult;
  /** Moves the creature one tick along `path` at its species speed, switching region at portals. */
  walk(path: PathState): "moving" | "arrived";
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

export type ActionStatus =
  { status: "running" } | { status: "done" } | { status: "failed"; reason: string };

/** An action type with its implementation, registered in the `actions` registry. */
export interface ActionProvider extends ActionType {
  /** True when the action is meant to move the creature; the stuck watchdog watches these. */
  readonly moves: boolean;
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

/** Read-only world queries for behaviors. v1 has no senses, so they see the whole world. */
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
  readonly world: WorldQueries;
}

/** A behavior's suggestion. The engine validates it and plans any path itself. */
export interface Proposal {
  action: string;
  params?: unknown;
  utility: number;
}

/** Plain data the engine keeps per creature and behavior, for cooldowns and hysteresis. */
export type BehaviorMemory = Record<string, unknown>;

/** A behavior type with its implementation, registered in the `behaviors` registry. */
export interface BehaviorProvider extends BehaviorType {
  /**
   * Proposes the next action, or null. Called only when the creature needs a decision: its
   * action finished or failed, or the watchdog interrupted it. Changes to `memory` are kept.
   */
  evaluate(observation: CreatureObservation, memory: BehaviorMemory, rng: Rng): Proposal | null;
}

export function isBehaviorProvider(entry: BehaviorType): entry is BehaviorProvider {
  return typeof (entry as Partial<BehaviorProvider>).evaluate === "function";
}
