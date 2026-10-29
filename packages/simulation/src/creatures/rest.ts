import type { RegionPosition } from "@living-diorama/content-schema";
import type { Rng } from "../runtime/rng";
import type { DayPhase } from "../runtime/time-of-day";
import { pathFromRoute } from "./core-actions";
import type {
  ActionContext,
  ActionProvider,
  ActionStart,
  BehaviorMemory,
  BehaviorProvider,
  CatchUpGap,
  CatchUpResult,
  CreatureObservation,
  OpenGroundQueries,
  PathState,
} from "./contracts";
import { isBackedOff } from "./knowledge";
import { tirednessNeed } from "./needs";
import {
  chooseNearestByRoute,
  isIntFrom,
  isPathState,
  isRecord,
  routeNearest,
  type PlaceChoice,
} from "./shared";

// `core:rest` and `core:sleep` (ADR 0018 §13, §14 and amendments). A tired creature, or any
// creature once its sleeping phase draws near, goes to a shelter it knows (its home, unless that
// is much further than the nearest) and sleeps beside it until rested and its waking phase has
// begun, or, napping by day, until fully rested. Knowing no shelter, it first walks out a few
// times, further each time, looking for one, then sleeps in the open, clear of other sleepers
// (issue #122). Starting values, to tune.

const REST = "core:rest";
const SLEEP = "core:sleep";
const SHELTER = "core:shelter";
const NOCTURNAL = "core:nocturnal";
const FOLLOW_PATH = "core:follow_path";
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
/**
 * Knowing no shelter it can reach, a creature walks out this far (straight line, in metres) to
 * look for one, one walk per radius, before it sleeps in the open (issue #122).
 */
export const SHELTER_SEARCH_RADII: readonly number[] = [6, 12, 20];
/** A search walk goes at least this share of its radius, so the effort shows. */
const SEARCH_MIN_SHARE = 0.5;
/** Points drawn for a search walk before that walk is skipped. */
const SEARCH_DRAWS = 8;
/**
 * A search that found nothing is remembered this long after its last walk: woken in the night, or
 * napping the next morning, the creature sleeps in the open at once; the next bedtime searches
 * afresh.
 */
export const SEARCH_FORGET_SECONDS = 12 * 60 * 60;
/** Clearance between the bodies of two creatures asleep in the open, in metres. */
export const SLEEPER_GAP = 0.3;
/** How far from where it stands a creature looks for a clear place to lie down, in metres. */
export const OPEN_SPOT_RADII: readonly number[] = [3, 6];
/** Points drawn per radius when looking for a clear place to lie down. */
const OPEN_SPOT_DRAWS = 12;
/** How many times a creature about to lie down in the open moves away from a sleeper. */
export const OPEN_SPOT_MOVES = 3;

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
 * The known shelters the creature failed to reach lately, left out until their back-off ends
 * (issue #161). `core:sleep` records the failures in its knowledge, as `core:eat` does for food.
 */
function backedOffShelters({ knowledge, tick }: CreatureObservation): Set<string> {
  return new Set(
    (knowledge.places[SHELTER] ?? []).flatMap((p) => (isBackedOff(p, tick) ? [p.placementId] : [])),
  );
}

/**
 * Where to sleep (ADR 0018 §14): home, unless its route is more than twice as long as the route
 * to the nearest known shelter, which then wins without becoming home. Home counts while it still
 * offers shelter and can be reached, also after the creature has forgotten seeing it. A shelter
 * backed off after failed trips is left out, home too (issue #161); a forgotten home carries no
 * failures. Undefined if the creature can reach no shelter it knows.
 */
export function chooseShelter(
  observation: CreatureObservation,
  backedOff: ReadonlySet<string> = backedOffShelters(observation),
): PlaceChoice | undefined {
  const { home, world } = observation;
  const routed = routeNearest(observation, SHELTER, (id) => backedOff.has(id));
  const nearest = routed[0];
  if (home === null || backedOff.has(home)) return nearest;
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

/**
 * Where to lie down in the open (issue #122): `here` if no other sleeper is too close to it, else
 * the first point drawn within `OPEN_SPOT_RADII` that the creature can reach and that is clear of
 * them. Undefined if none of the draws is.
 */
export function clearSpot(
  queries: OpenGroundQueries,
  here: RegionPosition,
  rng: Rng,
): RegionPosition | undefined {
  if (!queries.sleeperNear(here, SLEEPER_GAP)) return here;
  for (const radius of OPEN_SPOT_RADII) {
    for (let draw = 0; draw < OPEN_SPOT_DRAWS; draw++) {
      const point = queries.randomWalkablePointWithin(radius, rng);
      if (point && !queries.sleeperNear(point, SLEEPER_GAP)) return point;
    }
  }
  return undefined;
}

/** `core:rest`'s memory: the search walks of this bedtime (issue #122). */
interface RestMemory extends BehaviorMemory {
  /** Search walks started so far. */
  searches?: number;
  /** The tick the last one started. */
  searchedAtTick?: number;
}

/** How many search walks the creature has made this bedtime, from its memory (or a save). */
function searchesMade(memory: RestMemory, { tick, tickSeconds }: CreatureObservation): number {
  const { searches, searchedAtTick } = memory;
  if (!isIntFrom(searches, 0) || !isIntFrom(searchedAtTick, 0)) return 0;
  return (tick - searchedAtTick) * tickSeconds > SEARCH_FORGET_SECONDS ? 0 : searches;
}

/**
 * The next search walk's destination (issue #122): a point the creature can reach within the next
 * radius of `SHELTER_SEARCH_RADII`, at least half that far away. A radius with no such point is
 * skipped. Records the walk in `memory`; undefined once every radius is used.
 */
function nextSearch(
  observation: CreatureObservation,
  memory: RestMemory,
  rng: Rng,
): { destination: RegionPosition; index: number } | undefined {
  const { creature, world } = observation;
  const here = creature.position;
  const made = searchesMade(memory, observation);
  for (const [k, radius] of SHELTER_SEARCH_RADII.entries()) {
    if (k < made) continue;
    const index = k + 1;
    for (let draw = 0; draw < SEARCH_DRAWS; draw++) {
      const point = world.randomWalkablePointWithin(radius, rng);
      if (!point) break;
      if (Math.hypot(point.x - here.x, point.z - here.z) >= SEARCH_MIN_SHARE * radius) {
        memory.searches = index;
        memory.searchedAtTick = observation.tick;
        return { destination: point, index };
      }
    }
  }
  return undefined;
}

export const restBehavior: BehaviorProvider = {
  id: REST,
  version: "1.0.0",
  dependencies: [
    { registry: "needs", id: TIREDNESS, version: "^1.0.0" },
    { registry: "traits", id: NOCTURNAL, version: "^1.0.0" },
    { registry: "actions", id: SLEEP, version: "^1.0.0" },
    { registry: "actions", id: FOLLOW_PATH, version: "^1.0.0" },
  ],
  evaluate(observation, memory, rng) {
    const { action, dayPhase, lastResult, needs, traits } = observation;
    // Asked to continue its own sleep, or a search for shelter: only real hunger (feed from
    // hunger 0.9) wakes it.
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
    // A shelter it couldn't get to, just now, or lately so that every shelter it could go to is
    // still backed off (issue #161): sleep in the open this time, without searching.
    const failed =
      lastResult?.action === SLEEP &&
      (lastResult.outcome === "failed" || lastResult.reason === "stuck");
    const backedOff = backedOffShelters(observation);
    const shelter = failed ? undefined : chooseShelter(observation, backedOff);
    const missed = failed || (!shelter && backedOff.size > 0);
    const rest = memory as RestMemory;
    if (!shelter && !missed) {
      // Knowing none, it walks out to look for one, a few times, further each time (issue #122).
      const search = nextSearch(observation, rest, rng);
      if (search) {
        return {
          action: FOLLOW_PATH,
          params: { destination: search.destination },
          utility,
          reason: `${why}: looking for shelter (${search.index}/${SHELTER_SEARCH_RADII.length})`,
        };
      }
    }
    // Finding a shelter ends the search; sleeping in the open, it remembers having searched.
    if (shelter) {
      delete rest.searches;
      delete rest.searchedAtTick;
    }
    return shelter
      ? {
          action: SLEEP,
          params: { placementId: shelter.placementId },
          utility,
          reason: `${why} at ${shelter.placementId}, ${shelter.length.toFixed(1)} m`,
        }
      : { action: SLEEP, params: {}, utility, reason: `${why} in the open` };
  },
  /**
   * After a gap (ADR 0018 §19): tiredness as `tirednessAfter` has it, and, in the creature's
   * sleeping phase, asleep already: at home if home still offers it shelter it can reach, else at
   * the nearest shelter it knows, else in the open: where it stands, or close by if a creature
   * placed before it sleeps too close (issue #122). Not within the release grace. Back-off after
   * failed shelter trips doesn't count here (issue #161): catch-up places the creature, it doesn't
   * walk.
   */
  catchUp(observation, gap, rng) {
    const { creature, dayPhase, home, needs, traits, world } = observation;
    const nocturnal = isNocturnal(traits);
    const tiredness = tirednessAfter(needs[TIREDNESS] ?? 0, gap, nocturnal);
    if (tiredness === undefined) return null;
    const result: CatchUpResult = { needs: { [TIREDNESS]: tiredness } };
    if (!sleepCycle(dayPhase, nocturnal).sleeping || inReleaseGrace(observation)) return result;
    const homePlace = home === null ? undefined : world.place(home);
    const atHome =
      homePlace && Object.hasOwn(homePlace.affordances, SHELTER) && world.spotAt(homePlace.id);
    const shelter = atHome ? home : chooseNearestByRoute(observation, SHELTER)?.placementId;
    if (shelter) {
      result.start = { action: SLEEP, params: { placementId: shelter, asleep: true }, at: shelter };
      return result;
    }
    // Crowded everywhere it looked, it lies down where it stands after all.
    const spot = clearSpot(world, creature.position, rng);
    const moved = spot && spot !== creature.position ? { at: { ...spot } } : {};
    result.start = { action: SLEEP, params: { asleep: true }, ...moved };
    return result;
  },
};

interface SleepState {
  /** The shelter it sleeps beside, or null to sleep where it stands. */
  placementId: string | null;
  /**
   * The heading it lies down at, drawn from its own stream at the start: it settles beside the
   * shelter facing any way, as animals lie around a tree, not facing the shelter.
   */
  heading: number;
  path: PathState;
  /** Set once the creature stands at its spot; it then stops walking. */
  arrived: boolean;
  /** Set once it has fallen asleep (`fell_asleep` emitted). */
  asleep: boolean;
  /**
   * In the open: how many times it has moved away from a sleeper too close to where it was about
   * to lie down (at most `OPEN_SPOT_MOVES`).
   */
  moves: number;
  /**
   * A nap: started in the waking phase, so it ends only at tiredness 0. Cleared for good once
   * the waking phase ends, so a nap that runs into the evening becomes the night's sleep.
   */
  nap: boolean;
}

/**
 * Walks to the creature's spot at `params.placementId`, a place offering `core:shelter`, or,
 * without one, stays where it is, unless another creature sleeps too close there: it then walks to
 * a clear point close by, up to `OPEN_SPOT_MOVES` times, checked until it lies down; turns in
 * place to a resting heading drawn from its own stream (any way, not towards the shelter); then
 * sleeps there. Checked every tick: a night's sleep ends
 * once tiredness is below 0.1 and the creature's waking phase has begun, a nap once tiredness
 * reaches 0. Emits `fell_asleep` on lying down and `woke_up` on waking, also when interrupted. The
 * first shelter a creature sleeps at becomes its home. Records in the creature's knowledge whether
 * it reached its spot at a shelter: no spot or route there, stuck on the way, or arrived (issue
 * #161, as `core:eat` does). With `params.asleep` true it starts already there and asleep, for
 * catch-up (`startAsleep`).
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
      const state: SleepState = {
        placementId: null,
        heading: restingHeading(context),
        path: { points: [], next: 0 },
        arrived: true,
        asleep: false,
        moves: 0,
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
    const route = spot && context.planRoute(spot);
    if (!route?.ok) {
      context.noteReach(SHELTER, placementId, "no_route");
      return { ok: false, reason: route?.reason ?? "no_spot", detail: { placementId } };
    }
    const path = pathFromRoute(route.route);
    const state: SleepState = {
      placementId,
      heading: restingHeading(context),
      path,
      arrived: path.points.length === 0,
      asleep: false,
      moves: 0,
      nap: waking,
    };
    if (state.arrived) context.noteReach(SHELTER, placementId, "reached");
    return { ok: true, state, detail: { placementId, length: route.route.length } };
  },
  step(state, context) {
    const sleep = state as SleepState;
    if (!sleep.arrived) {
      sleep.arrived = context.walk(sleep.path) === "arrived";
      if (sleep.arrived && sleep.placementId !== null) {
        context.noteReach(SHELTER, sleep.placementId, "reached");
      }
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
      if (sleep.placementId === null && movedAway(sleep, context)) return { status: "running" };
      // Turns in place to its resting heading before lying down.
      if (context.turnTo(sleep.heading) === "turning") return { status: "running" };
      sleep.asleep = true;
      context.emit({ type: "fell_asleep", placementId: sleep.placementId, tiredness });
      if (sleep.placementId !== null && context.home === null) context.setHome(sleep.placementId);
    }
    return { status: "running", asleep: true, cue: "sleeping" };
  },
  interrupted(state, context, reason) {
    const sleep = state as SleepState;
    if (reason === "stuck" && !sleep.arrived && sleep.placementId !== null) {
      context.noteReach(SHELTER, sleep.placementId, "stuck");
    }
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
    const { placementId, heading, path, arrived, asleep, moves, nap } = state;
    return (
      (placementId === null || (typeof placementId === "string" && exists(placementId))) &&
      Number.isFinite(heading) &&
      isPathState(path) &&
      typeof arrived === "boolean" &&
      typeof asleep === "boolean" &&
      isIntFrom(moves, 0) &&
      typeof nap === "boolean"
    );
  },
};

/**
 * In the open, about to lie down: if another sleeper is too close, sets off for a clear point
 * close by and returns true, at most `OPEN_SPOT_MOVES` times (issue #122). Creatures lie down one
 * at a time within a tick, so of two settling on the same point at once the second sees the first.
 */
function movedAway(sleep: SleepState, context: ActionContext): boolean {
  if (sleep.moves >= OPEN_SPOT_MOVES || !context.sleeperNear(context.position, SLEEPER_GAP)) {
    return false;
  }
  sleep.moves++;
  const spot = clearSpot(context, context.position, context.rng);
  const route = spot && context.planRoute(spot);
  if (!route?.ok) return true;
  sleep.path = pathFromRoute(route.route);
  sleep.arrived = sleep.path.points.length === 0;
  return true;
}

/**
 * Sleep already under way, for catch-up only (ADR 0018 §19; `not_catching_up` otherwise). At a
 * shelter `placementId`, the creature must already stand at its spot there, where the engine
 * placed it (`not_at_spot` otherwise); without one it sleeps where it stands. It is asleep from
 * the start, at a resting heading of its own with no turn, so it emits no `fell_asleep`; a
 * shelter becomes its home if it has none, as on falling asleep there.
 */
function startAsleep(placementId: unknown, waking: boolean, context: ActionContext): ActionStart {
  if (!context.catchingUp) return { ok: false, reason: "not_catching_up" };
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
    if (context.home === null) context.setHome(place.id);
  }
  const state: SleepState = {
    placementId: typeof placementId === "string" ? placementId : null,
    heading: restingHeading(context),
    path: { points: [], next: 0 },
    arrived: true,
    asleep: true,
    moves: 0,
    nap: waking,
  };
  // Catching up, the turn is done at once.
  context.turnTo(state.heading);
  return {
    ok: true,
    state,
    asleep: true,
    detail: { placementId: state.placementId, asleep: true },
  };
}

/** A uniformly random heading to lie down at, from the creature's own stream. */
function restingHeading(context: ActionContext): number {
  return context.rng.range(-Math.PI, Math.PI);
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
