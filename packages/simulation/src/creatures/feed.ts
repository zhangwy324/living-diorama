import type { FoodAffordanceParams, RegionPosition } from "@living-diorama/content-schema";
import type { Rng } from "../runtime/rng";
import { pathFromRoute } from "./core-actions";
import type { ActionProvider, BehaviorProvider, CreatureObservation, PathState } from "./contracts";
import { gridCellAt, isBackedOff } from "./knowledge";
import { hungerNeed } from "./needs";
import { VISION_SENSE } from "./perception";
import { chooseNearestByRoute, isIntFrom, isPathState, isRecord } from "./shared";

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
const EXPLORE_ATTEMPTS = 8;
/** An exploration target closer than this is not worth walking to. */
const MIN_EXPLORE_DISTANCE = 4;
/**
 * An exploration leg ends within this many times the creature's vision range, so a hungry
 * explorer decides again often and goes for food it has seen on the way.
 */
const EXPLORE_VISION_FACTOR = 2;
/** The shortest reach of an exploration leg. */
const MIN_EXPLORE_RANGE = 8;
/** The reach of an exploration leg for a creature without vision. */
const BLIND_EXPLORE_RANGE = 12;

/** How far an exploration leg may reach: twice the vision range, at least 8 m; 12 m blind. */
export function explorationRange(senses: Readonly<Record<string, number>>): number {
  const vision = senses[VISION_SENSE];
  return vision === undefined
    ? BLIND_EXPLORE_RANGE
    : Math.max(MIN_EXPLORE_RANGE, EXPLORE_VISION_FACTOR * vision);
}

/**
 * A random reachable point within `explorationRange`, preferring one in a grid cell the creature
 * hasn't visited recently (ADR 0018 amendments, §11), else the one whose cell it visited longest
 * ago.
 */
export function explorationTarget(
  { creature, knowledge, senses, world }: CreatureObservation,
  rng: Rng,
): RegionPosition | undefined {
  const range = explorationRange(senses);
  const visited = new Map(knowledge.recentCells.map((c) => [`${c.x},${c.z}`, c.tick]));
  const here = creature.position;
  let best: { point: RegionPosition; tick: number } | undefined;
  for (let attempt = 0; attempt < EXPLORE_ATTEMPTS; attempt++) {
    const point = world.randomWalkablePointWithin(range, rng);
    if (!point) continue;
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
  evaluate(observation, _memory, rng) {
    const hunger = observation.needs[HUNGER] ?? 0;
    const utility = FEED_BASE_UTILITY + hunger;
    const { action, knowledge, tick } = observation;
    // Asked to continue its own meal or search: say how much it still matters, even once hunger
    // has fallen below actAt mid-meal, so a wander can't cut the meal short.
    if (action?.behavior === FEED) return { action: action.id, utility, reason: "continue" };
    if (hunger < hungerNeed.actAt) return null;

    // Food the creature failed to reach lately is left out until its back-off ends; `core:eat`
    // records the failures in its knowledge (ADR 0018 amendments, §11).
    const backedOff = new Set(
      (knowledge.places[FOOD] ?? []).flatMap((p) => (isBackedOff(p, tick) ? [p.placementId] : [])),
    );
    const food = chooseNearestByRoute(observation, FOOD, (id) => backedOff.has(id));
    if (food) {
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
  // Back from a gap, the creature is taken to have eaten (ADR 0018 §19): integrating hunger over
  // hours away would leave every creature starving.
  catchUp({ needs }, _gap, rng) {
    return Object.hasOwn(needs, HUNGER)
      ? { needs: { [HUNGER]: rng.range(0, hungerNeed.actAt) } }
      : null;
  },
};

interface EatState {
  placementId: string;
  /** Where the food stands, to face it while eating. */
  x: number;
  z: number;
  path: PathState;
  /** Set once the creature stands at its spot; it then stops walking. */
  arrived: boolean;
  /** Ticks of eating left. */
  ticksLeft: number;
  /** Hunger lowered per tick of eating, so a whole meal lowers it by `MEAL`. */
  perTick: number;
}

/**
 * Walks to the creature's spot at `params.placementId`, a place offering `core:food`, turns in
 * place to face the food (`ActionContext.face`, no cue while turning), then eats facing it
 * for the place's `eatSeconds`, lowering hunger a little every tick: a meal cut short counts in
 * part. Emits `ate` when the meal is finished. Records in the creature's knowledge whether it
 * reached its spot: no spot or route there, stuck on the way, or arrived (ADR 0018 amendments,
 * §11).
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
    const place = context.place(placementId);
    const food = place?.affordances[FOOD] as FoodAffordanceParams | undefined;
    if (!place || !food) return { ok: false, reason: "not_food", detail: { placementId } };
    const spot = context.spotAt(placementId);
    const route = spot && context.planRoute(spot);
    if (!route?.ok) {
      context.noteReach(FOOD, placementId, "no_route");
      return { ok: false, reason: route?.reason ?? "no_spot", detail: { placementId } };
    }
    const path = pathFromRoute(route.route);
    const ticks = Math.max(1, Math.round(food.eatSeconds / context.tickSeconds));
    const state: EatState = {
      placementId,
      x: place.x,
      z: place.z,
      path,
      arrived: path.points.length === 0,
      ticksLeft: ticks,
      perTick: MEAL / ticks,
    };
    if (state.arrived) context.noteReach(FOOD, placementId, "reached");
    return { ok: true, state, detail: { placementId, length: route.route.length } };
  },
  step(state, context) {
    const eat = state as EatState;
    if (!eat.arrived) {
      eat.arrived = context.walk(eat.path) === "arrived";
      if (eat.arrived) context.noteReach(FOOD, eat.placementId, "reached");
      return { status: "running" };
    }
    // Turns to the food before the meal starts, and keeps facing it while eating.
    if (context.face(eat.x, eat.z) === "turning") return { status: "running" };
    context.adjustNeed(HUNGER, -eat.perTick);
    eat.ticksLeft--;
    // The share of the meal eaten, from the state alone: ticksLeft × perTick is the meal still left,
    // so this is the share of the meal's ticks done, which holds only while perTick = MEAL / ticks.
    const cueProgress = 1 - (eat.ticksLeft * eat.perTick) / MEAL;
    if (eat.ticksLeft > 0) return { status: "running", cue: "eating", cueProgress };
    context.emit({ type: "ate", placementId: eat.placementId, hunger: context.needs[HUNGER] ?? 0 });
    return { status: "done", cue: "eating" };
  },
  target(state) {
    return (state as EatState).placementId;
  },
  interrupted(state, context, reason) {
    const eat = state as EatState;
    if (reason === "stuck" && !eat.arrived) context.noteReach(FOOD, eat.placementId, "stuck");
  },
  checkState(state, exists) {
    if (!isRecord(state)) return false;
    const { placementId, x, z, path, arrived, ticksLeft, perTick } = state;
    return (
      typeof placementId === "string" &&
      exists(placementId) &&
      Number.isFinite(x) &&
      Number.isFinite(z) &&
      isPathState(path) &&
      typeof arrived === "boolean" &&
      isIntFrom(ticksLeft, 1) &&
      typeof perTick === "number" &&
      perTick > 0 &&
      Number.isFinite(perTick)
    );
  },
};
