import type { DayPhase } from "../runtime/time-of-day";
import { pathFromRoute } from "./core-actions";
import type {
  ActionContext,
  ActionProvider,
  ActionStart,
  BehaviorProvider,
  CatchUpGap,
  CatchUpResult,
  CreatureObservation,
  PathState,
} from "./contracts";
import { tirednessNeed } from "./needs";
import {
  chooseNearestByRoute,
  isPathState,
  isRecord,
  routeNearest,
  type PlaceChoice,
} from "./shared";

// `core:rest` and `core:sleep` (ADR 0018 §13, §14 and amendments). A tired creature, or any
// creature once its sleeping phase draws near, goes to a shelter it knows (its home, unless that
// is much further than the nearest) and sleeps beside it until rested and its waking phase has
// begun, or, napping by day, until fully rested. Knowing no shelter, it sleeps where it stands.
// Starting values, to tune.

const REST = "core:rest";
const SLEEP = "core:sleep";
const SHELTER = "core:shelter";
const NOCTURNAL = "core:nocturnal";
const TIREDNESS = tirednessNeed.id;

/** `core:rest` proposes with this plus tiredness plus the night bonus (ADR 0018 §9). */
export const REST_BASE_UTILITY = 0.2;
/** The night bonus in the creature's sleeping phase (ADR 0018 §13). */
export const SLEEPING_PHASE_BONUS = 0.5;
/** The night bonus at the edges of the sleeping phase: dusk and dawn for a diurnal creature. */
export const EDGE_BONUS = 0.2;
/**
 * What `core:rest` returns while its own sleep runs. `core:feed` (0.2 + hunger) beats it by the
 * interruption margin only from hunger 0.9, the trigger at which hunger wakes a sleeper (§13).
 */
export const SLEEP_CONTINUE_UTILITY = 0.95;
/** A night's sleep ends once tiredness is below this and the waking phase has begun. */
export const WAKE_TIREDNESS = 0.1;
/** Home is passed over for a shelter whose route is more than this many times shorter (§14). */
export const HOME_DETOUR_FACTOR = 2;
/** A creature released from the Studio doesn't sleep for this long (ADR 0018 amendments, §13). */
export const RELEASE_GRACE_SECONDS = 10 * 60;
/** How close to its spot at a shelter a creature must stand to start there already asleep. */
const AT_SPOT_METRES = 1e-3;

/** Where a day phase falls in a creature's day (ADR 0018 §13 and amendments, §5). */
export interface SleepCycle {
  /**
   * The creature's waking phase: dawn and day for one that sleeps at night, dusk and night for a
   * nocturnal one. Its first phase is the edge after its sleeping phase.
   */
  waking: boolean;
  /**
   * The creature's sleeping phase: night for one that sleeps at night, day for a nocturnal one.
   * Only there does the night bonus start sleep on its own (ADR 0018 amendments, §13).
   */
  sleeping: boolean;
  /** The night bonus: 0.5 in the sleeping phase, 0.2 at either edge of it, otherwise 0. */
  bonus: number;
}

const DIURNAL: Record<DayPhase, SleepCycle> = {
  dawn: { waking: true, sleeping: false, bonus: EDGE_BONUS },
  day: { waking: true, sleeping: false, bonus: 0 },
  dusk: { waking: false, sleeping: false, bonus: EDGE_BONUS },
  night: { waking: false, sleeping: true, bonus: SLEEPING_PHASE_BONUS },
};
/** The diurnal cycle two phases on: asleep by day, awake from dusk. */
const NOCTURNAL_CYCLE: Record<DayPhase, SleepCycle> = {
  dawn: DIURNAL.dusk,
  day: DIURNAL.night,
  dusk: DIURNAL.dawn,
  night: DIURNAL.day,
};

/** Whether the creature's `core:nocturnal` trait says it sleeps by day. */
export const isNocturnal = (traits: Readonly<Record<string, number>>) =>
  (traits[NOCTURNAL] ?? 0) >= 1;

/** Where `phase` falls in the day of a creature that sleeps at night, or by day if nocturnal. */
export function sleepCycle(phase: DayPhase, nocturnal: boolean): SleepCycle {
  return (nocturnal ? NOCTURNAL_CYCLE : DIURNAL)[phase];
}

/** Whether a creature released from the Studio is still in its first 10 minutes. */
export function inReleaseGrace({ creature, tick, tickSeconds }: CreatureObservation): boolean {
  const released = creature.releasedAtTick;
  return released !== undefined && (tick - released) * tickSeconds < RELEASE_GRACE_SECONDS;
}

/**
 * Where to sleep (ADR 0018 §14): home, unless its route is more than twice as long as the route
 * to the nearest known shelter, which then wins without becoming home. Home counts while it still
 * offers shelter and can be reached, also after the creature has forgotten seeing it. Undefined
 * if the creature can reach no shelter it knows.
 */
export function chooseShelter(observation: CreatureObservation): PlaceChoice | undefined {
  const { home, world } = observation;
  const routed = routeNearest(observation, SHELTER);
  const nearest = routed[0];
  if (home === null) return nearest;
  // Home's route, from the candidates already routed if it is among them.
  let length = routed.find((c) => c.placementId === home)?.length;
  if (length === undefined) {
    const place = world.place(home);
    const spot = place && Object.hasOwn(place.affordances, SHELTER) && world.spotAt(place.id);
    length = spot ? world.routeLength(spot) : undefined;
  }
  if (length === undefined) return nearest;
  return !nearest || length <= HOME_DETOUR_FACTOR * nearest.length
    ? { placementId: home, length }
    : nearest;
}

export const restBehavior: BehaviorProvider = {
  id: REST,
  version: "1.0.0",
  dependencies: [
    { registry: "needs", id: TIREDNESS, version: "^1.0.0" },
    { registry: "traits", id: NOCTURNAL, version: "^1.0.0" },
    { registry: "actions", id: SLEEP, version: "^1.0.0" },
  ],
  evaluate(observation) {
    const { action, dayPhase, lastResult, needs, traits } = observation;
    // Asked to continue its own sleep: only real hunger (feed from hunger 0.9) wakes it.
    if (action?.behavior === REST) {
      return { action: action.id, utility: SLEEP_CONTINUE_UTILITY, reason: "continue" };
    }
    if (inReleaseGrace(observation)) return null;
    const tiredness = needs[TIREDNESS] ?? 0;
    const { waking, sleeping, bonus } = sleepCycle(dayPhase, isNocturnal(traits));
    // Only in the sleeping phase does the night bonus alone send a creature to bed, so bedtime
    // follows the start of night. At the edges (dusk and dawn) it only adds to a creature already
    // tired enough to act: one just woken at dawn would otherwise lie down again at once.
    if (!sleeping && tiredness < tirednessNeed.actAt) return null;
    const utility = REST_BASE_UTILITY + tiredness + bonus;
    const why = waking ? "nap" : sleeping ? "night" : "bedtime";
    // A shelter it couldn't get to: sleep where it stands this time.
    const missed =
      lastResult?.action === SLEEP &&
      (lastResult.outcome === "failed" || lastResult.reason === "stuck");
    const shelter = missed ? undefined : chooseShelter(observation);
    return shelter
      ? {
          action: SLEEP,
          params: { placementId: shelter.placementId },
          utility,
          reason: `${why} at ${shelter.placementId}, ${shelter.length.toFixed(1)} m`,
        }
      : { action: SLEEP, params: {}, utility, reason: `${why} where it stands` };
  },
  /**
   * After a gap (ADR 0018 §19): tiredness as `tirednessAfter` has it, and, in the creature's
   * sleeping phase, asleep already: at home if home still offers it shelter it can reach, else at
   * the nearest shelter it knows, else where it stands. Not within the release grace.
   */
  catchUp(observation, gap) {
    const { dayPhase, home, needs, traits, world } = observation;
    const nocturnal = isNocturnal(traits);
    const tiredness = tirednessAfter(needs[TIREDNESS] ?? 0, gap, nocturnal);
    if (tiredness === undefined) return null;
    const result: CatchUpResult = { needs: { [TIREDNESS]: tiredness } };
    if (!sleepCycle(dayPhase, nocturnal).sleeping || inReleaseGrace(observation)) return result;
    const homePlace = home === null ? undefined : world.place(home);
    const atHome =
      homePlace && Object.hasOwn(homePlace.affordances, SHELTER) && world.spotAt(homePlace.id);
    const shelter = atHome ? home : chooseNearestByRoute(observation, SHELTER)?.placementId;
    result.start = shelter
      ? { action: SLEEP, params: { placementId: shelter, asleep: true }, at: shelter }
      : { action: SLEEP, params: { asleep: true } };
    return result;
  },
};

interface SleepState {
  /** The shelter it sleeps beside, or null to sleep where it stands. */
  placementId: string | null;
  /** Where the shelter stands, to face it. */
  x: number;
  z: number;
  path: PathState;
  /** Set once the creature stands at its spot; it then stops walking. */
  arrived: boolean;
  /** Set once it has fallen asleep (`fell_asleep` emitted). */
  asleep: boolean;
  /**
   * A nap: started in the waking phase, so it ends only at tiredness 0. Cleared for good once
   * the waking phase ends, so a nap that runs into the evening becomes the night's sleep.
   */
  nap: boolean;
}

/**
 * Walks to the creature's spot at `params.placementId`, a place offering `core:shelter`, or,
 * without one, stays where it is; then sleeps there. Checked every tick: a night's sleep ends
 * once tiredness is below 0.1 and the creature's waking phase has begun, a nap once tiredness
 * reaches 0. Emits `fell_asleep` on arriving and `woke_up` on waking, also when interrupted. The
 * first shelter a creature sleeps at becomes its home. With `params.asleep` true it starts already
 * there and asleep, for catch-up (`startAsleep`).
 */
export const sleepAction: ActionProvider = {
  id: SLEEP,
  version: "1.0.0",
  cue: "sleeping",
  start(params, context) {
    if (!isRecord(params)) {
      return { ok: false, reason: "invalid_params", detail: { expected: "{ placementId? }" } };
    }
    const { waking } = sleepCycle(context.dayPhase, isNocturnal(context.traits));
    const { placementId } = params;
    if (params.asleep === true) return startAsleep(placementId, waking, context);
    if (placementId === undefined) {
      const { x, z } = context.position;
      const state: SleepState = {
        placementId: null,
        x,
        z,
        path: { points: [], next: 0 },
        arrived: true,
        asleep: false,
        nap: waking,
      };
      return { ok: true, state, detail: { placementId: null } };
    }
    if (typeof placementId !== "string") {
      return { ok: false, reason: "invalid_params", detail: { expected: "{ placementId? }" } };
    }
    const place = context.place(placementId);
    if (!place || !Object.hasOwn(place.affordances, SHELTER)) {
      return { ok: false, reason: "not_shelter", detail: { placementId } };
    }
    const spot = context.spotAt(placementId);
    if (!spot) return { ok: false, reason: "no_spot", detail: { placementId } };
    const route = context.planRoute(spot);
    if (!route.ok) return { ok: false, reason: route.reason, detail: { placementId } };
    const path = pathFromRoute(route.route);
    const state: SleepState = {
      placementId,
      x: place.x,
      z: place.z,
      path,
      arrived: path.points.length === 0,
      asleep: false,
      nap: waking,
    };
    return { ok: true, state, detail: { placementId, length: route.route.length } };
  },
  step(state, context) {
    const sleep = state as SleepState;
    if (!sleep.arrived) {
      sleep.arrived = context.walk(sleep.path) === "arrived";
      return { status: "running" };
    }
    const { waking } = sleepCycle(context.dayPhase, isNocturnal(context.traits));
    if (!waking) sleep.nap = false;
    const tiredness = context.needs[TIREDNESS] ?? 0;
    const rested = sleep.nap ? tiredness <= 0 : waking && tiredness < WAKE_TIREDNESS;
    if (rested) {
      // Arriving already rested (dawn came on the way), it doesn't lie down at all.
      if (sleep.asleep) context.emit({ type: "woke_up", reason: "rested", tiredness });
      return { status: "done" };
    }
    if (!sleep.asleep) {
      sleep.asleep = true;
      if (sleep.placementId !== null) context.face(sleep.x, sleep.z);
      context.emit({ type: "fell_asleep", placementId: sleep.placementId, tiredness });
      if (sleep.placementId !== null && context.home === null) context.setHome(sleep.placementId);
    }
    return { status: "running", asleep: true, cue: "sleeping" };
  },
  interrupted(state, context) {
    const sleep = state as SleepState;
    if (sleep.asleep) {
      context.emit({
        type: "woke_up",
        reason: "interrupted",
        tiredness: context.needs[TIREDNESS] ?? 0,
      });
    }
  },
  checkState(state, exists) {
    if (!isRecord(state)) return false;
    const { placementId, x, z, path, arrived, asleep, nap } = state;
    return (
      (placementId === null || (typeof placementId === "string" && exists(placementId))) &&
      Number.isFinite(x) &&
      Number.isFinite(z) &&
      isPathState(path) &&
      typeof arrived === "boolean" &&
      typeof asleep === "boolean" &&
      typeof nap === "boolean"
    );
  },
};

/**
 * Sleep already under way, for catch-up only (ADR 0018 §19; `not_catching_up` otherwise). At a
 * shelter `placementId`, the creature must already stand at its spot there, where the engine
 * placed it (`not_at_spot` otherwise); without one it sleeps where it stands. It is asleep from
 * the start, so it emits no `fell_asleep`; a shelter becomes its home if it has none, as on
 * falling asleep there.
 */
function startAsleep(placementId: unknown, waking: boolean, context: ActionContext): ActionStart {
  if (!context.catchingUp) return { ok: false, reason: "not_catching_up" };
  let { x, z } = context.position;
  if (placementId !== undefined) {
    const place = typeof placementId === "string" ? context.place(placementId) : undefined;
    if (!place || !Object.hasOwn(place.affordances, SHELTER)) {
      return { ok: false, reason: "not_shelter", detail: { placementId } };
    }
    // Only where the creature already stands at its spot: catch-up puts it there first.
    const spot = context.spotAt(place.id);
    const here = context.position;
    const there =
      spot !== undefined &&
      spot.regionId === here.regionId &&
      Math.hypot(spot.x - here.x, spot.z - here.z) <= AT_SPOT_METRES;
    if (!there) return { ok: false, reason: "not_at_spot", detail: { placementId } };
    ({ x, z } = place);
    context.face(place.x, place.z);
    if (context.home === null) context.setHome(place.id);
  }
  const state: SleepState = {
    placementId: typeof placementId === "string" ? placementId : null,
    x,
    z,
    path: { points: [], next: 0 },
    arrived: true,
    asleep: true,
    nap: waking,
  };
  return { ok: true, state, detail: { placementId: state.placementId, asleep: true } };
}

/**
 * Tiredness after a gap (ADR 0018 §19): it falls at the asleep rate through the creature's
 * sleeping phase and rises at the awake rate through the rest, and a creature whose sleeping
 * phase ended during the gap starts its waking phase rested (0).
 */
export function tirednessAfter(
  tiredness: number,
  gap: CatchUpGap,
  nocturnal: boolean,
): number | undefined {
  const awake = gap.needRate(TIREDNESS, false);
  const asleep = gap.needRate(TIREDNESS, true);
  if (awake === undefined || asleep === undefined) return undefined;
  let value = tiredness;
  let slept = false;
  for (const { phase, hours } of gap.phases) {
    const { waking, sleeping } = sleepCycle(phase, nocturnal);
    if (waking && slept) value = 0;
    slept = sleeping;
    value = Math.min(1, Math.max(0, value + hours * (sleeping ? asleep : awake)));
  }
  return value;
}
