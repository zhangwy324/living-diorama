import type { FoodAffordanceParams, RegionPosition } from "@living-diorama/content-schema";
import type { Rng } from "../runtime/rng";
import { isRecord, pathFromRoute } from "./core-actions";
import type { ActionProvider, BehaviorProvider, CreatureObservation, PathState } from "./contracts";
import { gridCellAt } from "./knowledge";
import { hungerNeed } from "./needs";
import { pickWeighted } from "./wander";

// `core:feed` and `core:eat` (ADR 0018 §11, §12 and amendments). A hungry creature goes to the
// remembered food with the shortest route, stands at its own spot beside it and eats, which
// lowers hunger gradually. Knowing no food, it explores towards grid cells it hasn't visited
// recently, and perception finds food on the way. Starting values, to tune.

const FEED = "core:feed";
const EAT = "core:eat";
const FOLLOW_PATH = "core:follow_path";
const FOOD = "core:food";
const HUNGER = hungerNeed.id;

/** `core:feed` proposes with this plus hunger (ADR 0018 §9). */
export const FEED_BASE_UTILITY = 0.2;
/** How much a whole meal lowers hunger. */
export const MEAL = 0.8;
/** Known food is ranked by straight-line distance and only the nearest few get a route. */
export const PATHED_CANDIDATES = 3;
/** Food a creature failed to reach is skipped for this long. */
const AVOID_SECONDS = 60;
const EXPLORE_ATTEMPTS = 8;
/** An exploration target closer than this is not worth walking to. */
const MIN_EXPLORE_DISTANCE = 4;

interface FeedMemory {
  /** The food the last proposed meal was at, to skip it if the meal failed to get there. */
  target?: string;
  /** Placement ID → tick until which it is skipped. */
  avoid?: Record<string, number>;
}

/** The food the creature remembers, with routes, best first: what `core:feed` chooses from. */
export interface FoodChoice {
  placementId: string;
  /** Route length in metres. */
  length: number;
}

/**
 * The remembered food with the shortest route (ADR 0018 amendments, §10): the nearest
 * `PATHED_CANDIDATES` by straight line, leaving out `skip`, get a route to the creature's spot.
 */
export function chooseFood(
  { creature, knowledge, world }: CreatureObservation,
  skip: (placementId: string) => boolean = () => false,
): FoodChoice | undefined {
  const here = creature.position;
  const nearest = (knowledge.places[FOOD] ?? [])
    .flatMap(({ placementId }) => {
      const place = skip(placementId) ? undefined : world.place(placementId);
      return place && Object.hasOwn(place.affordances, FOOD)
        ? [{ placementId, distance: Math.hypot(place.x - here.x, place.z - here.z) }]
        : [];
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, PATHED_CANDIDATES);
  let best: FoodChoice | undefined;
  for (const { placementId } of nearest) {
    const spot = world.spotAt(placementId);
    const length = spot && world.routeLength(spot);
    if (length !== undefined && (!best || length < best.length)) best = { placementId, length };
  }
  return best;
}

/**
 * A random reachable point, preferring one in a grid cell the creature hasn't visited recently
 * (ADR 0018 amendments, §11), else the one whose cell it visited longest ago.
 */
export function explorationTarget(
  { creature, knowledge, world }: CreatureObservation,
  rng: Rng,
): RegionPosition | undefined {
  const regions = world.reachableRegions();
  const visited = new Map(knowledge.recentCells.map((c) => [`${c.x},${c.z}`, c.tick]));
  const here = creature.position;
  let best: { point: RegionPosition; tick: number } | undefined;
  for (let attempt = 0; attempt < EXPLORE_ATTEMPTS; attempt++) {
    const regionId = pickWeighted(regions, rng);
    const point = regionId === undefined ? undefined : world.randomWalkablePoint(regionId, rng);
    if (!point) return best?.point;
    if (Math.hypot(point.x - here.x, point.z - here.z) < MIN_EXPLORE_DISTANCE) continue;
    const cell = gridCellAt(point.x, point.z);
    const tick = visited.get(`${cell.x},${cell.z}`);
    if (tick === undefined) return point;
    if (!best || tick < best.tick) best = { point, tick };
  }
  return best?.point;
}

export const feedBehavior: BehaviorProvider = {
  id: FEED,
  version: "1.0.0",
  dependencies: [
    { registry: "needs", id: HUNGER, version: "^1.0.0" },
    { registry: "actions", id: EAT, version: "^1.0.0" },
    { registry: "actions", id: FOLLOW_PATH, version: "^1.0.0" },
  ],
  evaluate(observation, memory, rng) {
    const hunger = observation.needs[HUNGER] ?? 0;
    const utility = FEED_BASE_UTILITY + hunger;
    const { action, lastResult, tick, tickSeconds } = observation;
    // Asked to continue its own meal or search: say how much it still matters, even once hunger
    // has fallen below actAt mid-meal, so a wander can't cut the meal short.
    if (action?.behavior === FEED) return { action: action.id, utility, reason: "continue" };
    if (hunger < hungerNeed.actAt) return null;

    const state = memory as FeedMemory;
    const avoid = Object.fromEntries(
      Object.entries(state.avoid ?? {}).filter(([, until]) => until > tick),
    );
    const missed =
      lastResult?.action === EAT &&
      (lastResult.outcome === "failed" || lastResult.reason === "stuck");
    if (state.target !== undefined && missed) {
      avoid[state.target] = tick + Math.round(AVOID_SECONDS / tickSeconds);
    }
    state.avoid = avoid;
    delete state.target;

    const food = chooseFood(observation, (id) => Object.hasOwn(avoid, id));
    if (food) {
      state.target = food.placementId;
      return {
        action: EAT,
        params: { placementId: food.placementId },
        utility,
        reason: `food ${food.placementId}, ${food.length.toFixed(1)} m`,
      };
    }
    const destination = explorationTarget(observation, rng);
    return destination
      ? { action: FOLLOW_PATH, params: { destination }, utility, reason: "explore for food" }
      : null;
  },
};

interface EatState {
  placementId: string;
  path: PathState;
  /** Set once the creature stands at its spot; it then stops walking. */
  arrived: boolean;
  /** Ticks of eating left. */
  ticksLeft: number;
  /** Hunger lowered per tick of eating, so a whole meal lowers it by `MEAL`. */
  perTick: number;
}

/**
 * Walks to the creature's spot at `params.placementId`, a place offering `core:food`, then eats
 * for the place's `eatSeconds`, lowering hunger a little every tick: a meal cut short counts in
 * part. Emits `ate` when the meal is finished.
 */
export const eatAction: ActionProvider = {
  id: EAT,
  version: "1.0.0",
  cue: "eating",
  start(params, context) {
    const placementId = isRecord(params) ? params.placementId : undefined;
    if (typeof placementId !== "string") {
      return { ok: false, reason: "invalid_params", detail: { expected: "{ placementId }" } };
    }
    const food = context.place(placementId)?.affordances[FOOD] as FoodAffordanceParams | undefined;
    if (!food) return { ok: false, reason: "not_food", detail: { placementId } };
    const spot = context.spotAt(placementId);
    if (!spot) return { ok: false, reason: "no_spot", detail: { placementId } };
    const route = context.planRoute(spot);
    if (!route.ok) return { ok: false, reason: route.reason, detail: { placementId } };
    const path = pathFromRoute(route.route);
    const ticks = Math.max(1, Math.round(food.eatSeconds / context.tickSeconds));
    const state: EatState = {
      placementId,
      path,
      arrived: path.points.length === 0,
      ticksLeft: ticks,
      perTick: MEAL / ticks,
    };
    return { ok: true, state, detail: { placementId, length: route.route.length } };
  },
  step(state, context) {
    const eat = state as EatState;
    if (!eat.arrived) {
      eat.arrived = context.walk(eat.path) === "arrived";
      return { status: "running" };
    }
    context.adjustNeed(HUNGER, -eat.perTick);
    eat.ticksLeft--;
    if (eat.ticksLeft > 0) return { status: "running", cue: "eating" };
    context.emit({ type: "ate", placementId: eat.placementId, hunger: context.needs[HUNGER] ?? 0 });
    return { status: "done", cue: "eating" };
  },
};
