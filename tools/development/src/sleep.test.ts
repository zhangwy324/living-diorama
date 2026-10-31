import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  chooseShelter,
  emptyKnowledge,
  isFailingShelter,
  minutesAfter,
  OPEN_SPOT_MOVES,
  recordReach,
  rememberPlace,
  restBehavior,
  Rng,
  SEARCH_AFTER_SHELTER_FAILURES,
  SEARCH_FORGET_SECONDS,
  SHELTER_SEARCH_RADII,
  SLEEP_CONTINUE_UTILITY,
  SLEEPER_GAP,
  sleepAction,
  sleepCycle,
  tirednessNeed,
  WAKE_TIREDNESS,
  type ActionContext,
  type ActionProvider,
  type BehaviorProvider,
  type CreatureObservation,
  type CreatureState,
  type DayPhase,
  type DecisionTrace,
  type ReachOutcome,
  type SimulationEvent,
  type SpotOptions,
  type WorldQueries,
} from "@living-diorama/simulation";
import type { Registries } from "@living-diorama/extension-api";
import { beforeAll, describe, expect, it } from "vitest";
import { registerFarShelter } from "./fixtures/far-shelter";
import { createSimulation } from "./simulation-run";

// Shelter, sleep and home (ADR 0018 §13, §14 and amendments, PR 5a): `core:rest` and `core:sleep`.

const SHELTER = "core:shelter";
const HUNGER = "core:hunger";
const MOSSLING = "hollow:mossling";
const TIREDNESS = "core:tiredness";
const NOCTURNAL = "core:nocturnal";

// ---- core:rest -------------------------------------------------------------------------------

interface Stub {
  places: Record<string, { x: number; z: number }>;
  /** Route length per placement; undefined means no route. */
  routes?: Record<string, number | undefined>;
  /** `randomWalkablePointWithin`: undefined, the default, means no point. */
  within?: (maxDistance: number) => { x: number; z: number } | undefined;
  /** Places that no longer offer shelter. */
  bare?: string[];
  /** Places with no spot clear of other sleepers left (issue #158). */
  full?: string[];
}

function observe(
  stub: Stub,
  {
    tiredness = 0.5,
    dayPhase = "day",
    nocturnal = 0,
    knowledge = emptyKnowledge(),
    ...rest
  }: Partial<CreatureObservation> & { tiredness?: number; nocturnal?: number } = {},
): CreatureObservation {
  const world: WorldQueries = {
    place: (id) => {
      const p = stub.places[id];
      const affordances = stub.bare?.includes(id) ? {} : { [SHELTER]: {} };
      return p && { id, ...p, y: 0, blockRadius: 0, affordances };
    },
    spotAt: (id, options) =>
      options?.clearOfSleepers !== undefined && stub.full?.includes(id)
        ? undefined
        : stub.places[id] && { regionId: id, ...stub.places[id]! },
    routeLength: (destination) => stub.routes?.[destination.regionId],
    reachableRegions: () => [],
    randomWalkablePoint: () => undefined,
    randomWalkablePointWithin: (maxDistance) => {
      const point = stub.within?.(maxDistance);
      return point && { regionId: "r", ...point };
    },
    sleeperNear: () => false,
  };
  return {
    tick: 100_000,
    tickSeconds: 0.1,
    creature: { id: "c", speciesId: "s", position: { regionId: "r", x: 0, z: 0 }, heading: 0 },
    dayPhase,
    needs: { [TIREDNESS]: tiredness, [HUNGER]: 0.1 },
    traits: { [NOCTURNAL]: nocturnal },
    senses: {},
    knowledge,
    home: null,
    world,
    ...rest,
  };
}

function knowing(...ids: string[]) {
  const knowledge = emptyKnowledge();
  for (const id of ids) rememberPlace(knowledge, SHELTER, id, 0, 4);
  return knowledge;
}

const evaluate = (observation: CreatureObservation) =>
  restBehavior.evaluate(observation, {}, Rng.fromSeed(1));

describe("core:rest", () => {
  const phases: DayPhase[] = ["dawn", "day", "dusk", "night"];

  it("maps phases to a waking phase and a night bonus, flipped for nocturnal creatures", () => {
    expect(phases.map((p) => sleepCycle(p, false))).toEqual([
      { waking: true, sleeping: false, bonus: 0.2 },
      { waking: true, sleeping: false, bonus: 0 },
      { waking: false, sleeping: false, bonus: 0.2 },
      { waking: false, sleeping: true, bonus: 0.5 },
    ]);
    expect(phases.map((p) => sleepCycle(p, true))).toEqual([
      { waking: false, sleeping: false, bonus: 0.2 },
      { waking: false, sleeping: true, bonus: 0.5 },
      { waking: true, sleeping: false, bonus: 0.2 },
      { waking: true, sleeping: false, bonus: 0 },
    ]);
  });

  it.each([
    // phase, nocturnal, tiredness, utility (null: no proposal)
    ["dawn", 0, 0.3, null],
    ["day", 0, 0.3, null],
    ["dusk", 0, 0.3, null],
    ["dusk", 0, 0.89, null],
    ["night", 0, 0.3, 1.0],
    ["night", 0, 0, 0.7],
    ["dawn", 0, 0.9, 1.3],
    ["day", 0, 0.9, 1.1],
    ["dusk", 0, 0.9, 1.3],
    ["night", 0, 0.9, 1.6],
    ["dawn", 1, 0.3, null],
    ["dawn", 1, 0.9, 1.3],
    ["day", 1, 0.3, 1.0],
    ["dusk", 1, 0.3, null],
    ["night", 1, 0.3, null],
    ["night", 1, 0.95, 1.15],
  ] as const)("at %s (nocturnal %i), tiredness %f: utility %s", (phase, nocturnal, t, utility) => {
    const proposal = evaluate(
      observe({ places: {} }, { dayPhase: phase, nocturnal, tiredness: t }),
    );
    if (utility === null) expect(proposal).toBeNull();
    else {
      expect(proposal?.action).toBe("core:sleep");
      expect(proposal?.utility).toBeCloseTo(utility, 9);
    }
  });

  it("while its own sleep runs, returns 0.95, which hunger beats by the margin only from 0.9", () => {
    const proposal = evaluate(
      observe(
        { places: {} },
        { dayPhase: "night", action: { id: "core:sleep", behavior: "core:rest", startTick: 0 } },
      ),
    );
    expect(proposal).toEqual({
      action: "core:sleep",
      utility: SLEEP_CONTINUE_UTILITY,
      reason: "continue",
    });
    // core:feed proposes 0.2 + hunger; the interruption margin is 0.15.
    expect(0.2 + 0.9 - SLEEP_CONTINUE_UTILITY).toBeGreaterThanOrEqual(0.15 - 1e-9);
    expect(0.2 + 0.8 - SLEEP_CONTINUE_UTILITY).toBeLessThan(0.15);
  });

  it("knowing no shelter, or none it can reach, with nowhere to search, sleeps in the open", () => {
    expect(evaluate(observe({ places: {} }, { dayPhase: "night" }))).toMatchObject({
      action: "core:sleep",
      params: {},
    });
    const unreachable = observe({ places: { t: { x: 3, z: 0 } } }, { knowledge: knowing("t") });
    expect(evaluate({ ...unreachable, dayPhase: "night" })).toMatchObject({ params: {} });
  });

  it("knowing no shelter, walks out to look for one three times, further each time", () => {
    const asked: number[] = [];
    // Every draw lands at the edge of the radius asked for.
    const stub: Stub = { places: {}, within: (d) => (asked.push(d), { x: d, z: 0 }) };
    const memory = {};
    const proposals = [0, 1, 2, 3].map((k) =>
      restBehavior.evaluate(
        observe(stub, { dayPhase: "night", tick: 100_000 + k * 600 }),
        memory,
        Rng.fromSeed(1),
      ),
    );
    expect(asked).toEqual(SHELTER_SEARCH_RADII);
    expect(proposals.slice(0, 3)).toEqual(
      SHELTER_SEARCH_RADII.map((d, k) => ({
        action: "core:follow_path",
        params: { destination: { regionId: "r", x: d, z: 0 } },
        utility: 1.2,
        reason: `night: looking for shelter (${k + 1}/3)`,
      })),
    );
    expect(proposals[3]).toMatchObject({
      action: "core:sleep",
      params: {},
      reason: "night in the open",
    });
    // Sleeping in the open, it remembers having searched, so woken later in the night (or
    // napping the next morning) it lies down again at once.
    expect(memory).toEqual({ searches: 3, searchedAtTick: 101_200 });
    const later = restBehavior.evaluate(
      observe(stub, { dayPhase: "night", tick: 101_200 + 4 * 36_000 }),
      memory,
      Rng.fromSeed(1),
    );
    expect(later).toMatchObject({ action: "core:sleep", params: {} });
    expect(asked).toEqual(SHELTER_SEARCH_RADII);
  });

  it("skips a search walk that would go less than half its radius", () => {
    // Every point drawn is 4 m away: enough for the 6 m search only.
    const stub: Stub = { places: {}, within: () => ({ x: 4, z: 0 }) };
    const memory = {};
    const first = restBehavior.evaluate(
      observe(stub, { dayPhase: "night" }),
      memory,
      Rng.fromSeed(1),
    );
    expect(first).toMatchObject({
      action: "core:follow_path",
      reason: "night: looking for shelter (1/3)",
    });
    const next = restBehavior.evaluate(
      observe(stub, { dayPhase: "night" }),
      memory,
      Rng.fromSeed(1),
    );
    expect(next).toMatchObject({ action: "core:sleep", params: {} });
  });

  it("searches afresh once its last search is more than 12 hours old", () => {
    const stub: Stub = { places: {}, within: (d) => ({ x: d, z: 0 }) };
    const ticks = SEARCH_FORGET_SECONDS * 10;
    const now = 1_000_000;
    const search = (searchedAtTick: number) =>
      restBehavior.evaluate(
        observe(stub, { dayPhase: "night", tick: now }),
        { searches: 3, searchedAtTick },
        Rng.fromSeed(1),
      );
    expect(SEARCH_FORGET_SECONDS).toBe(12 * 3600);
    expect(search(now - ticks)).toMatchObject({ action: "core:sleep" });
    expect(search(now - ticks - 1)).toMatchObject({
      action: "core:follow_path",
      reason: "night: looking for shelter (1/3)",
    });
  });

  it("goes to a shelter seen while searching", () => {
    const memory = {};
    const stub: Stub = {
      places: { t: { x: 3, z: 0 } },
      routes: { t: 4 },
      within: (d) => ({ x: d, z: 0 }),
    };
    restBehavior.evaluate(observe(stub, { dayPhase: "night" }), memory, Rng.fromSeed(1));
    const seen = observe(stub, { dayPhase: "night", knowledge: knowing("t") });
    expect(restBehavior.evaluate(seen, memory, Rng.fromSeed(1))).toMatchObject({
      action: "core:sleep",
      params: { placementId: "t" },
    });
    expect(memory).toEqual({});
  });

  it("while its own search walk runs, returns 0.95 to continue it", () => {
    const action = { id: "core:follow_path", behavior: "core:rest", startTick: 0 };
    expect(evaluate(observe({ places: {} }, { dayPhase: "night", action }))).toEqual({
      action: "core:follow_path",
      utility: SLEEP_CONTINUE_UTILITY,
      reason: "continue",
    });
  });

  it.each([
    { action: "core:sleep", outcome: "interrupted", reason: "stuck" },
    { action: "core:sleep", outcome: "failed", reason: "no_spot" },
  ] as const)(
    "sleeps in the open, without searching, after its last sleep ended $outcome",
    (lastResult) => {
      const stub: Stub = {
        places: { t: { x: 3, z: 0 } },
        routes: { t: 4 },
        within: (d) => ({ x: d, z: 0 }),
      };
      const observation = observe(stub, { dayPhase: "night", knowledge: knowing("t"), lastResult });
      expect(evaluate(observation)).toMatchObject({ action: "core:sleep", params: {} });
      // Otherwise, the shelter.
      const fine = observe(stub, { dayPhase: "night", knowledge: knowing("t") });
      expect(evaluate(fine)).toMatchObject({ params: { placementId: "t" } });
    },
  );

  it("prefers home unless its route is more than twice the nearest shelter's", () => {
    const stub: Stub = {
      places: { home: { x: 0, z: 9 }, near: { x: 2, z: 0 } },
      routes: { home: 10, near: 5 },
    };
    const options = { dayPhase: "night" as const, knowledge: knowing("near", "home") };
    expect(chooseShelter(observe(stub, options))).toEqual({ placementId: "near", length: 5 });
    expect(chooseShelter(observe(stub, { ...options, home: "home" }))).toEqual({
      placementId: "home",
      length: 10,
    });
    // Home has been forgotten from knowledge, but still counts.
    const forgot = observe(stub, { ...options, knowledge: knowing("near"), home: "home" });
    expect(chooseShelter(forgot)?.placementId).toBe("home");
    // More than twice as far: nap at the nearer.
    stub.routes!.home = 10.5;
    expect(chooseShelter(observe(stub, { ...options, home: "home" }))?.placementId).toBe("near");
    // Home out of reach.
    stub.routes!.home = undefined;
    expect(chooseShelter(observe(stub, { ...options, home: "home" }))?.placementId).toBe("near");
  });

  describe("with sleepers at a shelter (issue #158)", () => {
    const stub = (full: string[]): Stub => ({
      places: { home: { x: 0, z: 4 }, near: { x: 2, z: 0 } },
      routes: { home: 4, near: 2 },
      full,
    });
    const options = { dayPhase: "night" as const, knowledge: knowing("near", "home") };

    it("passes a full shelter over, home included, without moving house", () => {
      expect(chooseShelter(observe(stub([]), { ...options, home: "home" }))).toEqual({
        placementId: "home",
        length: 4,
      });
      expect(chooseShelter(observe(stub(["home"]), { ...options, home: "home" }))).toEqual({
        placementId: "near",
        length: 2,
      });
      expect(evaluate(observe(stub(["home"]), { ...options, home: "home" }))).toMatchObject({
        action: "core:sleep",
        params: { placementId: "near" },
      });
      expect(
        evaluate(observe(stub(["home"]), { ...options, home: "home" }))?.params,
      ).not.toHaveProperty("newHome");
      expect(chooseShelter(observe(stub(["near"]), options))).toEqual({
        placementId: "home",
        length: 4,
      });
    });

    it("with every shelter it knows full, looks for another, as knowing none", () => {
      const full = { ...stub(["home", "near"]), within: () => ({ x: 5, z: 0 }) };
      const observation = observe(full, { ...options, home: "home" });
      expect(chooseShelter(observation)).toBeUndefined();
      expect(evaluate(observation)).toMatchObject({ action: "core:follow_path" });
    });

    it("catching up, puts it to bed at the spot clear of sleepers, or in the open if all are full", () => {
      const gap = {
        ms: 3_600_000,
        phases: [{ phase: "night" as const, hours: 1 }],
        needRate: () => 0,
      };
      const rng = Rng.fromSeed(1);
      const start = (full: string[]) =>
        restBehavior.catchUp!(observe(stub(full), { ...options, home: "home" }), gap, rng)?.start;
      expect(start([])).toEqual({
        action: "core:sleep",
        params: { placementId: "home", asleep: true },
        at: { regionId: "home", x: 0, z: 4 },
      });
      expect(start(["home"])).toEqual({
        action: "core:sleep",
        params: { placementId: "near", asleep: true },
        at: { regionId: "near", x: 2, z: 0 },
      });
      expect(start(["home", "near"])).toEqual({ action: "core:sleep", params: { asleep: true } });
    });
  });

  describe("after failed trips to a shelter (issue #161)", () => {
    const TICK = 100_000;
    /** Records a failed trip to `id` at `tick`, as `core:sleep` does through `noteReach`. */
    const fail = (
      knowledge: ReturnType<typeof emptyKnowledge>,
      id: string,
      outcome: Exclude<ReachOutcome, "reached"> = "stuck",
      tick = TICK,
    ) =>
      recordReach(knowledge, SHELTER, id, outcome, {
        tick,
        tickSeconds: 0.1,
        cell: { x: 0, z: 0 },
      });
    const stub = (): Stub => ({
      places: { home: { x: 0, z: 4 }, near: { x: 2, z: 0 }, far: { x: 6, z: 0 } },
      routes: { home: 5, near: 3, far: 8 },
      // Somewhere to search, so a search would show.
      within: (d) => ({ x: d, z: 0 }),
    });

    it("passes over a backed-off shelter for the next one, home included", () => {
      const knowledge = knowing("near", "far", "home");
      fail(knowledge, "near");
      const options = { dayPhase: "night" as const, knowledge, home: "home" };
      // Home is no more than twice the next shelter's route: home.
      expect(chooseShelter(observe(stub(), options))?.placementId).toBe("home");
      // Home backed off too: the next shelter.
      fail(knowledge, "home", "no_route");
      expect(chooseShelter(observe(stub(), options))?.placementId).toBe("far");
      expect(evaluate(observe(stub(), options))).toMatchObject({
        action: "core:sleep",
        params: { placementId: "far" },
      });
    });

    it("with every shelter it knows backed off, sleeps in the open without searching", () => {
      const knowledge = knowing("near", "home");
      fail(knowledge, "near");
      fail(knowledge, "home");
      const memory = {};
      const proposal = restBehavior.evaluate(
        observe(stub(), { dayPhase: "night", knowledge, home: "home" }),
        memory,
        Rng.fromSeed(1),
      );
      expect(proposal).toMatchObject({
        action: "core:sleep",
        params: {},
        reason: "night in the open",
      });
      expect(memory).toEqual({});
    });

    it("tries the shelter again once its back-off ends, longer after each failure", () => {
      const knowledge = knowing("near");
      // Nowhere to search, so failing twice (issue #171) still sleeps in the open.
      const at = (tick: number) =>
        evaluate(observe({ ...stub(), within: undefined }, { dayPhase: "night", knowledge, tick }))
          ?.params;
      // Stuck once: 30 s, 300 ticks.
      fail(knowledge, "near");
      expect(at(TICK + 299)).toEqual({});
      expect(at(TICK + 300)).toEqual({ placementId: "near" });
      // Stuck again on that try: 60 s.
      fail(knowledge, "near", "stuck", TICK + 300);
      expect(at(TICK + 899)).toEqual({});
      expect(at(TICK + 900)).toEqual({ placementId: "near" });
      // Reaching it clears the failures.
      recordReach(knowledge, SHELTER, "near", "reached", {
        tick: TICK + 900,
        tickSeconds: 0.1,
        cell: { x: 0, z: 0 },
      });
      expect(knowledge.places[SHELTER]![0]!.failures).toBeUndefined();
    });

    it("a forgotten home has no failures, so it still counts", () => {
      const knowledge = knowing("near");
      fail(knowledge, "near");
      const observation = observe(stub(), { dayPhase: "night", knowledge, home: "home" });
      expect(chooseShelter(observation)?.placementId).toBe("home");
    });
  });

  describe("after failing again and again (issue #171)", () => {
    const TICK = 100_000;
    /** Fails `id` `times` times, long enough ago that it is no longer backed off. */
    const failOften = (
      knowledge: ReturnType<typeof emptyKnowledge>,
      id: string,
      times = SEARCH_AFTER_SHELTER_FAILURES,
      tick = TICK - 50_000,
    ) => {
      for (let k = 0; k < times; k++) {
        recordReach(knowledge, SHELTER, id, k % 2 ? "no_route" : "stuck", {
          tick,
          tickSeconds: 0.1,
          cell: { x: 0, z: 0 },
        });
      }
    };
    const stub = (): Stub => ({
      places: { home: { x: 0, z: 4 }, near: { x: 2, z: 0 }, far: { x: 6, z: 0 } },
      routes: { home: 5, near: 3, far: 8 },
      within: (d) => ({ x: d, z: 0 }),
    });
    const stuck = { action: "core:sleep", outcome: "interrupted", reason: "stuck" } as const;

    it("after a failed trip, searches if every shelter it knows has failed twice", () => {
      const knowledge = knowing("home");
      failOften(knowledge, "home", 1);
      const night = { dayPhase: "night" as const, knowledge, home: "home", lastResult: stuck };
      // Failed once: in the open, without searching (issue #161).
      expect(evaluate(observe(stub(), night))).toMatchObject({ params: {} });
      failOften(knowledge, "home", 1);
      expect(evaluate(observe(stub(), night))).toMatchObject({
        action: "core:follow_path",
        reason: "night: looking for shelter (1/3)",
      });
      // One it knows hasn't failed: in the open, without searching.
      rememberPlace(knowledge, SHELTER, "near", 0, 4);
      expect(evaluate(observe(stub(), night))).toMatchObject({ params: {} });
    });

    it("with every shelter backed off and failing, searches instead of sleeping in the open", () => {
      const knowledge = knowing("near", "home");
      failOften(knowledge, "near", 2, TICK);
      failOften(knowledge, "home", 2, TICK);
      const memory = {};
      expect(
        restBehavior.evaluate(
          observe(stub(), { dayPhase: "night", knowledge, home: "home" }),
          memory,
          Rng.fromSeed(1),
        ),
      ).toMatchObject({ action: "core:follow_path", params: { destination: { x: 6 } } });
      expect(memory).toMatchObject({ searches: 1, searchedAtTick: TICK });
    });

    it("a forgotten home hasn't failed, so it doesn't search", () => {
      const knowledge = knowing("near");
      failOften(knowledge, "near");
      const observation = observe(stub(), {
        dayPhase: "night",
        knowledge,
        home: "home",
        lastResult: stuck,
      });
      expect(evaluate(observation)).toMatchObject({ params: {} });
    });

    it("a backed-off place that no longer offers shelter doesn't stop the search", () => {
      const knowledge = knowing("near");
      failOften(knowledge, "near", 1, TICK);
      const proposal = (bare: string[]) =>
        evaluate(observe({ ...stub(), bare }, { dayPhase: "night", knowledge }));
      expect(proposal([])).toMatchObject({ params: {}, reason: "night in the open" });
      expect(proposal(["near"])).toMatchObject({ action: "core:follow_path" });
    });

    it("passes a failing shelter over for one that isn't, home included, and moves house", () => {
      const knowledge = knowing("near", "far", "home");
      failOften(knowledge, "near");
      failOften(knowledge, "home");
      const options = { dayPhase: "night" as const, knowledge, home: "home" };
      expect(evaluate(observe(stub(), options))).toMatchObject({
        action: "core:sleep",
        params: { placementId: "far", newHome: true },
      });
      // Only failing ones left: the nearest by route, home no more than any other.
      const failing = knowing("near", "home");
      failOften(failing, "near");
      failOften(failing, "home");
      expect(evaluate(observe(stub(), { ...options, knowledge: failing }))).toMatchObject({
        params: { placementId: "near", newHome: true },
      });
      // Home failing once only: home as before, no move.
      const once = knowing("near", "home");
      failOften(once, "home", 1);
      expect(evaluate(observe(stub(), { ...options, knowledge: once }))?.params).toEqual({
        placementId: "home",
      });
    });

    it("catching up, puts it to bed at a shelter that isn't failing, or in the open (issue #175)", () => {
      const gap = {
        ms: 3_600_000,
        phases: [{ phase: "night" as const, hours: 1 }],
        needRate: () => 0,
      };
      const start = (knowledge: ReturnType<typeof emptyKnowledge>, full: string[] = []) =>
        restBehavior.catchUp!(
          observe({ ...stub(), full }, { dayPhase: "night", knowledge, home: "home" }),
          gap,
          Rng.fromSeed(1),
        )?.start;
      const atHome = {
        action: "core:sleep",
        params: { placementId: "home", asleep: true },
        at: { regionId: "home", x: 0, z: 4 },
      };
      const atFar = {
        action: "core:sleep",
        params: { placementId: "far", asleep: true },
        at: { regionId: "far", x: 6, z: 0 },
      };
      const inTheOpen = { action: "core:sleep", params: { asleep: true } };
      // Home not failing: home, as before, even with a failing shelter nearer.
      const fine = knowing("near", "far", "home");
      failOften(fine, "near");
      failOften(fine, "home", 1);
      expect(start(fine)).toEqual(atHome);
      // Home failing: the nearest shelter that isn't, recording nothing and keeping home.
      const knowledge = knowing("near", "far", "home");
      failOften(knowledge, "near");
      failOften(knowledge, "home");
      const before = structuredClone(knowledge);
      expect(start(knowledge)).toEqual(atFar);
      expect(knowledge).toEqual(before);
      // The same for the same knowledge.
      expect(start(knowledge)).toEqual(start(structuredClone(before)));
      // Every other shelter failing or full: in the open, not at a failing one.
      expect(start(knowledge, ["far"])).toEqual(inTheOpen);
      const allFailing = knowing("near", "home");
      failOften(allFailing, "near");
      failOften(allFailing, "home");
      expect(start(allFailing)).toEqual(inTheOpen);
      expect(isFailingShelter(allFailing, "home")).toBe(true);
      expect(isFailingShelter(fine, "home")).toBe(false);
    });

    it("trying a failing shelter again doesn't end the search", () => {
      const knowledge = knowing("home");
      failOften(knowledge, "home");
      const memory = { searches: 1, searchedAtTick: TICK - 100 };
      restBehavior.evaluate(
        observe(stub(), { dayPhase: "night", knowledge, home: "home" }),
        memory,
        Rng.fromSeed(1),
      );
      expect(memory).toEqual({ searches: 1, searchedAtTick: TICK - 100 });
    });
  });

  it("doesn't rest in the first 10 minutes after a Studio release", () => {
    const at = (ticksSince: number) =>
      evaluate(
        observe(
          { places: {} },
          {
            dayPhase: "night",
            creature: {
              id: "c",
              speciesId: "s",
              position: { regionId: "r", x: 0, z: 0 },
              heading: 0,
              releasedAtTick: 100_000 - ticksSince,
            },
          },
        ),
      );
    expect(at(0)).toBeNull();
    expect(at(5_999)).toBeNull();
    expect(at(6_000)).toMatchObject({ action: "core:sleep" });
  });
});

// ---- core:sleep ------------------------------------------------------------------------------

function sleepContext({
  phase = "night" as DayPhase,
  tiredness = 0.5,
  nocturnal = 0,
  // Other sleepers, each too close within 1 m; and the points `randomWalkablePointWithin` draws.
  sleepers = [] as { x: number; z: number }[],
  points = [] as { x: number; z: number }[],
  // Ticks each walk is still on its way before it arrives.
  movingTicks = 0,
  // The spots round the tree, in the order `spotAt` tries them (issue #158).
  spots = [{ x: 1.2, z: 0 }] as { x: number; z: number }[],
} = {}) {
  const reaches: { affordanceId: string; placementId: string; outcome: ReachOutcome }[] = [];
  let moving = movingTicks;
  const turned: number[] = [];
  const turning: ("turning" | "facing")[] = [];
  const emitted: unknown[] = [];
  const homes: string[] = [];
  let walked = 0;
  let position = { regionId: "r", x: 0, z: 0 };
  const near = (p: { x: number; z: number }) =>
    sleepers.some((s) => Math.hypot(s.x - p.x, s.z - p.z) < 1);
  const context = {
    catchingUp: false,
    tick: 0,
    tickSeconds: 0.1,
    get position() {
      return position;
    },
    dayPhase: phase,
    needs: { [TIREDNESS]: tiredness, [HUNGER]: 0.2 },
    randomWalkablePointWithin: () => {
      const point = points.shift();
      return point && { regionId: "r", ...point };
    },
    sleeperNear: (p: { x: number; z: number }) => near(p),
    traits: { [NOCTURNAL]: nocturnal },
    place: (id: string) =>
      id === "tree"
        ? { id, x: 2, y: 0, z: 0, blockRadius: 0.35, affordances: { [SHELTER]: {} } }
        : id === "rock"
          ? { id, x: 2, y: 0, z: 0, blockRadius: 0.5, affordances: {} }
          : undefined,
    spotAt: (_id: string, options?: SpotOptions) => {
      const spot = spots.find((s) => options?.clearOfSleepers === undefined || !near(s));
      return spot && { regionId: "r", ...spot };
    },
    planRoute: (to: { x: number; z: number }) => {
      const { x, z } = position;
      return {
        ok: true as const,
        route: {
          legs: [{ regionId: "r", points: [{ x, z }, to] }],
          length: Math.hypot(to.x - x, to.z - z),
        },
      };
    },
    // Arrives at once, at the end of the path, unless `movingTicks` holds it up.
    walk: (path: { points: { x: number; z: number }[] }) => {
      walked++;
      if (moving > 0) {
        moving--;
        return "moving" as const;
      }
      const end = path.points.at(-1);
      if (end) position = { regionId: "r", x: end.x, z: end.z };
      return "arrived" as const;
    },
    adjustNeed: () => {},
    heading: 0,
    rng: Rng.fromSeed(1),
    // Turns complete at once unless a test queues ticks of turning.
    turnTo: (heading: number) => {
      turned.push(heading);
      return turning.shift() ?? ("facing" as const);
    },
    face: () => "facing" as const,
    emit: (event: unknown) => emitted.push(event),
    home: null as string | null,
    setHome: (id: string) => homes.push(id),
    noteReach: (affordanceId: string, placementId: string, outcome: ReachOutcome) =>
      reaches.push({ affordanceId, placementId, outcome }),
  } satisfies ActionContext;
  return {
    context,
    emitted,
    homes,
    reaches,
    sleepers,
    walked: () => walked,
    turned,
    turning,
    at: () => position,
  };
}

describe("core:sleep", () => {
  it("only starts at a shelter, or with no place at all", () => {
    const { context } = sleepContext();
    expect(sleepAction.start({ placementId: "rock" }, context)).toMatchObject({
      ok: false,
      reason: "not_shelter",
    });
    expect(sleepAction.start(null, context)).toMatchObject({ ok: false, reason: "invalid_params" });
    expect(sleepAction.start({}, context)).toMatchObject({ ok: true });
  });

  it("walks to the shelter, then falls asleep, takes it as home and stops walking", () => {
    const { context, emitted, homes, walked } = sleepContext({ tiredness: 0.6 });
    const start = sleepAction.start({ placementId: "tree" }, context);
    if (!start.ok) throw new Error("start failed");
    expect(sleepAction.step(start.state, context)).toEqual({ status: "running" });
    expect(emitted).toEqual([]);
    for (let t = 0; t < 5; t++) {
      expect(sleepAction.step(start.state, context)).toEqual({
        status: "running",
        asleep: true,
        cue: "sleeping",
      });
    }
    expect(walked()).toBe(1);
    expect(emitted).toEqual([{ type: "fell_asleep", placementId: "tree", tiredness: 0.6 }]);
    expect(homes).toEqual(["tree"]);
  });

  it("turns in place to a resting heading of its own before lying down", () => {
    const { context, emitted, turned, turning } = sleepContext({ tiredness: 0.6 });
    const start = sleepAction.start({ placementId: "tree" }, context);
    if (!start.ok) throw new Error("start failed");
    const { heading } = start.state as { heading: number };
    expect(heading).toBeGreaterThanOrEqual(-Math.PI);
    expect(heading).toBeLessThan(Math.PI);
    turning.push("turning", "turning");
    // Walks there, then turns for two ticks, not yet asleep and with no cue.
    for (let t = 0; t < 3; t++) {
      expect(sleepAction.step(start.state, context)).toEqual({ status: "running" });
    }
    expect(emitted).toEqual([]);
    expect(sleepAction.step(start.state, context)).toMatchObject({ asleep: true });
    expect(emitted).toEqual([expect.objectContaining({ type: "fell_asleep" })]);
    // Always towards its drawn heading, not the shelter (which stands at +X, heading π/2).
    expect(turned).toEqual([heading, heading, heading]);
  });

  it("draws each night's resting heading from the creature's stream, the same for its seed", () => {
    const headings = (seed: number) => {
      const { context } = sleepContext();
      context.rng = Rng.fromSeed(seed);
      return [0, 1, 2].map(() => {
        const start = sleepAction.start({ placementId: "tree" }, context);
        if (!start.ok) throw new Error("start failed");
        return (start.state as { heading: number }).heading;
      });
    };
    const nights = headings(5);
    expect(new Set(nights).size).toBe(3);
    expect(headings(5)).toEqual(nights);
    expect(headings(6)).not.toEqual(nights);
  });

  it("doesn't change an existing home", () => {
    const { context, homes } = sleepContext();
    context.home = "elsewhere";
    const start = sleepAction.start({ placementId: "tree" }, context);
    if (!start.ok) throw new Error("start failed");
    sleepAction.step(start.state, context);
    sleepAction.step(start.state, context);
    expect(homes).toEqual([]);
  });

  it("with newHome, takes the shelter as home on falling asleep there (issue #171)", () => {
    const { context, homes } = sleepContext();
    context.home = "elsewhere";
    expect(sleepAction.start({ placementId: "tree", newHome: 1 }, context)).toMatchObject({
      ok: false,
      reason: "invalid_params",
    });
    const start = sleepAction.start({ placementId: "tree", newHome: true }, context);
    if (!start.ok) throw new Error("start failed");
    // Walking there, it doesn't move house yet.
    sleepAction.step(start.state, context);
    expect(homes).toEqual([]);
    sleepAction.step(start.state, context);
    sleepAction.step(start.state, context);
    expect(homes).toEqual(["tree"]);
  });

  it("sleeps through the night and wakes once rested and its waking phase has begun", () => {
    const { context, emitted } = sleepContext({ tiredness: 0.5 });
    const start = sleepAction.start({}, context);
    if (!start.ok) throw new Error("start failed");
    expect(sleepAction.step(start.state, context).status).toBe("running");
    // Rested in the night: sleeps on.
    context.needs[TIREDNESS] = 0;
    expect(sleepAction.step(start.state, context).status).toBe("running");
    // Dawn, still tired: sleeps on.
    context.dayPhase = "dawn";
    context.needs[TIREDNESS] = 0.15;
    expect(sleepAction.step(start.state, context).status).toBe("running");
    context.needs[TIREDNESS] = 0.09;
    expect(sleepAction.step(start.state, context)).toEqual({ status: "done" });
    expect(emitted.at(-1)).toEqual({ type: "woke_up", reason: "rested", tiredness: 0.09 });
  });

  it("arriving already rested in its waking phase, doesn't lie down at all", () => {
    const { context, emitted, homes } = sleepContext({ tiredness: 0.3 });
    const start = sleepAction.start({ placementId: "tree" }, context);
    if (!start.ok) throw new Error("start failed");
    // Dawn comes on the way, by when it is rested.
    context.dayPhase = "dawn";
    context.needs[TIREDNESS] = 0.05;
    expect(sleepAction.step(start.state, context)).toEqual({ status: "running" });
    expect(sleepAction.step(start.state, context)).toEqual({ status: "done" });
    expect(emitted).toEqual([]);
    expect(homes).toEqual([]);
  });

  it("ends a daytime nap only at tiredness 0", () => {
    const { context } = sleepContext({ phase: "day", tiredness: 0.95 });
    const start = sleepAction.start({}, context);
    if (!start.ok) throw new Error("start failed");
    expect(sleepAction.step(start.state, context).status).toBe("running");
    context.needs[TIREDNESS] = 0.05;
    expect(sleepAction.step(start.state, context).status).toBe("running");
    context.needs[TIREDNESS] = 0;
    expect(sleepAction.step(start.state, context).status).toBe("done");
  });

  it("turns a nap that runs into the evening into the night's sleep", () => {
    const { context } = sleepContext({ phase: "day", tiredness: 0.95 });
    const start = sleepAction.start({}, context);
    if (!start.ok) throw new Error("start failed");
    sleepAction.step(start.state, context);
    context.dayPhase = "dusk";
    sleepAction.step(start.state, context);
    context.dayPhase = "night";
    context.needs[TIREDNESS] = 0;
    expect(sleepAction.step(start.state, context).status).toBe("running");
    context.dayPhase = "dawn";
    expect(sleepAction.step(start.state, context).status).toBe("done");
  });

  it("for a nocturnal creature, the waking phase is dusk and night", () => {
    const { context } = sleepContext({ phase: "day", tiredness: 0.3, nocturnal: 1 });
    const start = sleepAction.start({}, context);
    if (!start.ok) throw new Error("start failed");
    context.needs[TIREDNESS] = 0.05;
    expect(sleepAction.step(start.state, context).status).toBe("running");
    context.dayPhase = "dusk";
    expect(sleepAction.step(start.state, context).status).toBe("done");
  });

  it("emits woke_up when interrupted, only if it had fallen asleep", () => {
    const { context, emitted } = sleepContext();
    const start = sleepAction.start({ placementId: "tree" }, context);
    if (!start.ok) throw new Error("start failed");
    sleepAction.step(start.state, context);
    sleepAction.interrupted?.(start.state, context, "outranked");
    expect(emitted).toEqual([]);
    sleepAction.step(start.state, context);
    sleepAction.interrupted?.(start.state, context, "outranked");
    expect(emitted.at(-1)).toEqual({ type: "woke_up", reason: "interrupted", tiredness: 0.5 });
  });

  it("in the open, walks to a clear point first if another sleeper lies too close", () => {
    const { context, emitted, at } = sleepContext({
      sleepers: [{ x: 0, z: 0.5 }],
      // Too close as well, then clear.
      points: [
        { x: 0.5, z: 0 },
        { x: 2, z: 1 },
      ],
    });
    const start = sleepAction.start({}, context);
    if (!start.ok) throw new Error("start failed");
    expect(sleepAction.step(start.state, context)).toEqual({ status: "running" });
    expect(start.state).toMatchObject({ moves: 1, arrived: false });
    expect(sleepAction.step(start.state, context)).toEqual({ status: "running" });
    expect(at()).toMatchObject({ x: 2, z: 1 });
    expect(sleepAction.step(start.state, context)).toMatchObject({ asleep: true });
    expect(emitted).toEqual([{ type: "fell_asleep", placementId: null, tiredness: 0.5 }]);
  });

  it("in the open, moves away at most three times, then lies down anyway", () => {
    // Sleepers everywhere it could go.
    const sleepers = [0, 1, 2, 3].map((x) => ({ x, z: 0 }));
    const points = [1, 2, 3].map((x) => ({ x, z: 0 }));
    const { context, at } = sleepContext({ sleepers, points });
    const start = sleepAction.start({}, context);
    if (!start.ok) throw new Error("start failed");
    let status;
    for (let t = 0; t < 10 && !status?.asleep; t++) status = sleepAction.step(start.state, context);
    expect(status).toMatchObject({ asleep: true });
    expect(start.state).toMatchObject({ moves: OPEN_SPOT_MOVES });
    expect(at()).toMatchObject({ x: 0, z: 0 });
  });

  describe("with other sleepers at the shelter (issue #158)", () => {
    const SPOTS = [
      { x: 1.2, z: 0 },
      { x: 2, z: 1.2 },
    ];
    const asleep = (state: unknown, context: ActionContext) => {
      let status;
      for (let t = 0; t < 10 && !status?.asleep; t++) status = sleepAction.step(state, context);
      expect(status).toMatchObject({ asleep: true });
    };

    it("lies down at the first spot clear of them", () => {
      const { context, emitted, homes, at } = sleepContext({
        spots: SPOTS,
        sleepers: [{ x: 1.2, z: 0.2 }],
      });
      const start = sleepAction.start({ placementId: "tree" }, context);
      if (!start.ok) throw new Error("start failed");
      asleep(start.state, context);
      expect(at()).toMatchObject({ x: 2, z: 1.2 });
      expect(start.state).toMatchObject({ placementId: "tree", moves: 0 });
      expect(emitted).toEqual([{ type: "fell_asleep", placementId: "tree", tiredness: 0.5 }]);
      expect(homes).toEqual(["tree"]);
    });

    it("heads for the next clear spot if one lies down near its own before it does", () => {
      const { context, homes, reaches, sleepers, at } = sleepContext({
        spots: SPOTS,
        movingTicks: 2,
      });
      const start = sleepAction.start({ placementId: "tree" }, context);
      if (!start.ok) throw new Error("start failed");
      sleepAction.step(start.state, context);
      sleepers.push({ x: 1.3, z: 0 });
      sleepAction.step(start.state, context);
      expect((start.state as { path: { points: unknown[] } }).path.points.at(-1)).toMatchObject({
        x: 2,
        z: 1.2,
      });
      asleep(start.state, context);
      expect(at()).toMatchObject({ x: 2, z: 1.2 });
      expect(reaches).toEqual([{ affordanceId: SHELTER, placementId: "tree", outcome: "reached" }]);
      expect(homes).toEqual(["tree"]);
    });

    it("moves on from its spot if one lies down near it while it turns", () => {
      const { context, sleepers, turning, at } = sleepContext({ spots: SPOTS });
      turning.push("turning");
      const start = sleepAction.start({ placementId: "tree" }, context);
      if (!start.ok) throw new Error("start failed");
      sleepAction.step(start.state, context);
      sleepAction.step(start.state, context);
      expect(at()).toMatchObject({ x: 1.2, z: 0 });
      sleepers.push({ x: 1.2, z: 0.5 });
      asleep(start.state, context);
      expect(at()).toMatchObject({ x: 2, z: 1.2 });
      expect(start.state).toMatchObject({ placementId: "tree" });
    });

    it("finding the shelter full at the start, sleeps in the open near it, noting nothing", () => {
      const { context, emitted, homes, reaches, at } = sleepContext({
        sleepers: [{ x: 1.2, z: 0 }],
        points: [{ x: 4, z: 0 }],
      });
      const start = sleepAction.start({ placementId: "tree", newHome: true }, context);
      if (!start.ok) throw new Error("start failed");
      expect(start.detail).toMatchObject({ placementId: "tree", full: true });
      expect(start.state).toMatchObject({ placementId: null, newHome: false });
      asleep(start.state, context);
      // Off to its spot at the tree, then clear of the sleeper there.
      expect(at()).toMatchObject({ x: 4, z: 0 });
      expect(start.state).toMatchObject({ moves: 1 });
      expect(emitted).toEqual([{ type: "fell_asleep", placementId: null, tiredness: 0.5 }]);
      expect(homes).toEqual([]);
      expect(reaches).toEqual([]);
    });

    it("finding it full on the way, sleeps in the open near it, noting nothing", () => {
      const { context, emitted, homes, reaches, sleepers, at } = sleepContext({
        spots: SPOTS,
        movingTicks: 1,
        points: [{ x: 4, z: 0 }],
      });
      context.home = "old";
      const start = sleepAction.start({ placementId: "tree", newHome: true }, context);
      if (!start.ok) throw new Error("start failed");
      sleepers.push(...SPOTS);
      asleep(start.state, context);
      expect(at()).toMatchObject({ x: 4, z: 0 });
      expect(start.state).toMatchObject({ placementId: null, newHome: false });
      expect(emitted).toEqual([{ type: "fell_asleep", placementId: null, tiredness: 0.5 }]);
      expect(homes).toEqual([]);
      expect(reaches).toEqual([]);
    });

    it("finding it full on the way, then stuck, notes no failure", () => {
      const { context, reaches, sleepers } = sleepContext({ spots: SPOTS, movingTicks: 5 });
      const start = sleepAction.start({ placementId: "tree" }, context);
      if (!start.ok) throw new Error("start failed");
      sleepAction.step(start.state, context);
      sleepers.push(...SPOTS);
      sleepAction.step(start.state, context);
      expect(start.state).toMatchObject({ placementId: null, arrived: false });
      sleepAction.interrupted!(start.state, context, "stuck");
      expect(reaches).toEqual([]);
    });

    it("catching up, starts asleep only at the spot clear of them", () => {
      const { context } = sleepContext({ spots: SPOTS, sleepers: [{ x: 1.2, z: 0.2 }] });
      const at = (x: number, z: number) => ({
        ...context,
        catchingUp: true,
        position: { regionId: "r", x, z },
      });
      expect(sleepAction.start({ placementId: "tree", asleep: true }, at(1.2, 0))).toMatchObject({
        ok: false,
        reason: "not_at_spot",
      });
      expect(sleepAction.start({ placementId: "tree", asleep: true }, at(2, 1.2))).toMatchObject({
        ok: true,
        asleep: true,
      });
    });
  });

  it("notes whether it reached its spot at a shelter: arrived, no spot or route, or stuck", () => {
    const reached = sleepContext({ movingTicks: 1 });
    const start = sleepAction.start({ placementId: "tree" }, reached.context);
    if (!start.ok) throw new Error("start failed");
    sleepAction.step(start.state, reached.context);
    expect(reached.reaches).toEqual([]);
    sleepAction.step(start.state, reached.context);
    expect(reached.reaches).toEqual([
      { affordanceId: SHELTER, placementId: "tree", outcome: "reached" },
    ]);

    const blocked = sleepContext();
    const noSpot = { ...blocked.context, spotAt: () => undefined };
    expect(sleepAction.start({ placementId: "tree" }, noSpot)).toMatchObject({ reason: "no_spot" });
    const noRoute = {
      ...blocked.context,
      planRoute: () => ({ ok: false as const, reason: "unreachable" as const, detail: "" }),
    };
    expect(sleepAction.start({ placementId: "tree" }, noRoute)).toMatchObject({
      reason: "unreachable",
    });
    // Not a shelter: nothing to back off.
    sleepAction.start({ placementId: "rock" }, blocked.context);
    expect(blocked.reaches.map((r) => r.outcome)).toEqual(["no_route", "no_route"]);

    const stuck = sleepContext({ movingTicks: 5 });
    const walking = sleepAction.start({ placementId: "tree" }, stuck.context);
    if (!walking.ok) throw new Error("start failed");
    sleepAction.step(walking.state, stuck.context);
    sleepAction.interrupted!(walking.state, stuck.context, "outranked");
    // Catch-up drops the action with its own reason (#164): no back-off either.
    sleepAction.interrupted!(walking.state, stuck.context, "catch_up");
    expect(stuck.reaches).toEqual([]);
    sleepAction.interrupted!(walking.state, stuck.context, "stuck");
    expect(stuck.reaches).toEqual([
      { affordanceId: SHELTER, placementId: "tree", outcome: "stuck" },
    ]);
  });

  it("in the open, notes nothing, also when stuck moving away from a sleeper", () => {
    const { context, reaches } = sleepContext({
      sleepers: [{ x: 0, z: 0 }],
      points: [{ x: 5, z: 5 }],
      movingTicks: 5,
    });
    const start = sleepAction.start({}, context);
    if (!start.ok) throw new Error("start failed");
    sleepAction.step(start.state, context);
    sleepAction.step(start.state, context);
    expect(start.state).toMatchObject({ moves: 1, arrived: false });
    sleepAction.interrupted!(start.state, context, "stuck");
    expect(reaches).toEqual([]);
  });
});

// ---- In the simulation -----------------------------------------------------------------------

describe("sleeping in Woodland Hollow", () => {
  function setup(
    seed: number,
    startMinutes: number,
    tickRateHz = 10,
    extra?: (registries: Registries) => void,
  ) {
    const traces: DecisionTrace[] = [];
    const simulation = createSimulation({
      register: (r: Registries) => {
        registerBuiltInContent(r);
        extra?.(r);
      },
      worldId: "hollow:woodland-hollow",
      seed,
      startMinutes,
      tickRateHz,
      onTrace: (t) => traces.push(t),
    });
    const events: SimulationEvent[] = [];
    const run = (ticks: number, until?: () => boolean) => {
      for (let t = 0; t < ticks && !until?.(); t++) {
        simulation.setTimeOfDay(
          minutesAfter(startMinutes, (simulation.tick * 1000) / simulation.tickRateHz),
        );
        events.push(...simulation.step());
      }
    };
    const spawn = (options?: { released?: boolean }, speciesId = "hollow:mossling") => {
      const spawned = simulation.spawn(speciesId, "meadow", options);
      if (!spawned.ok) throw new Error("spawn failed");
      return spawned.value;
    };
    const of = (creature: CreatureState, type: SimulationEvent["type"]) =>
      events.filter((e) => e.type === type && "creatureId" in e && e.creatureId === creature.id);
    return { simulation, traces, events, run, spawn, of };
  }
  /**
   * Its own day as the world's until its next draw (issue #85), so a test can time the phase
   * starts to the tick: the next dawn draws a new evening, the night after that a new morning.
   */
  const steady = (creature: CreatureState) => {
    creature.day.morning = 0;
    creature.day.evening = 0;
  };
  const HOUR = 36_000;

  it("goes to bed on the night bonus alone, at a shelter that becomes its home", () => {
    const { simulation, traces, run, spawn, of } = setup(1, 21 * 60);
    const creature = spawn();
    creature.needs[TIREDNESS] = 0.1;
    creature.needs[HUNGER] = 0;
    run(1);
    expect(traces[0]!.chosen).toMatchObject({ behavior: "core:rest", action: "core:sleep" });
    run(HOUR, () => creature.asleep);
    expect(creature.asleep).toBe(true);
    const [fell] = of(creature, "fell_asleep");
    const home = (fell as { placementId: string | null }).placementId;
    // Perception saw a round tree from the meadow within a second.
    expect(home).not.toBeNull();
    expect(creature.home).toBe(home);
    expect(of(creature, "new_home_selected")).toEqual([
      expect.objectContaining({ placementId: home, previous: null }),
    ]);
    expect(simulation.snapshot().creatures[0]!.cues).toContain("sleeping");
    const { x, z } = simulation.state.model.propsById.get(home!)!.transform.position;
    expect(Math.hypot(creature.position.x - x, creature.position.z - z)).toBeLessThan(2);
  });

  it("settles around a shelter facing ways of their own, turning smoothly", () => {
    const { simulation, run, spawn } = setup(4, 21 * 60);
    const creatures = [spawn(), spawn(), spawn(), spawn()];
    // They all know the shelter nearest the first.
    const { x: x0, z: z0 } = creatures[0]!.position;
    const shelter = [...simulation.state.model.propsByAffordance.get(SHELTER)!].sort(
      (a, b) =>
        Math.hypot(a.transform.position.x - x0, a.transform.position.z - z0) -
        Math.hypot(b.transform.position.x - x0, b.transform.position.z - z0),
    )[0]!;
    for (const creature of creatures) {
      creature.needs[HUNGER] = 0;
      rememberPlace(creature.knowledge, SHELTER, shelter.id, 0, 4);
    }
    const step = Math.PI * simulation.tickSeconds;
    const last = new Map(creatures.map((c) => [c.id, c.heading]));
    let biggest = 0;
    const turnTicks = new Map<string, number>();
    run(HOUR, () => {
      for (const c of creatures) {
        const state = c.action?.state as { arrived?: boolean; asleep?: boolean } | undefined;
        // Once there and not yet asleep, it only turns: by at most half a turn a second.
        if (state?.arrived && !state.asleep) {
          const turn = Math.abs(
            Math.atan2(
              Math.sin(c.heading - last.get(c.id)!),
              Math.cos(c.heading - last.get(c.id)!),
            ),
          );
          biggest = Math.max(biggest, turn);
          turnTicks.set(c.id, (turnTicks.get(c.id) ?? 0) + 1);
        }
        last.set(c.id, c.heading);
      }
      return creatures.every((c) => c.asleep);
    });
    expect(creatures.every((c) => c.asleep)).toBe(true);
    expect(biggest).toBeGreaterThan(0);
    expect(biggest).toBeLessThanOrEqual(step + 1e-9);
    // Half a turn at most: within a second (10 ticks) and the tick it lies down on.
    for (const ticks of turnTicks.values()) expect(ticks).toBeLessThanOrEqual(11);
    for (const c of creatures) {
      expect(c.heading).toBe((c.action!.state as { heading: number }).heading);
    }
    // Not all facing their shelters: each lies at a heading drawn from its own stream.
    expect(new Set(creatures.map((c) => c.heading)).size).toBe(creatures.length);
    const atShelter = creatures.flatMap((c) => {
      const { placementId } = c.action!.state as { placementId: string | null };
      return placementId === null ? [] : [{ c, placementId }];
    });
    expect(atShelter.length).toBe(creatures.length);
    const offShelter = atShelter.filter(({ c, placementId }) => {
      const { x, z } = simulation.state.model.propsById.get(placementId)!.transform.position;
      const towards = Math.atan2(x - c.position.x, z - c.position.z);
      return Math.abs(Math.sin((c.heading - towards) / 2)) > 0.1;
    });
    expect(offShelter.length).toBeGreaterThan(0);
  });

  /** The searches `core:rest` chose for `creature`, with where it set off from. */
  const searches = (traces: DecisionTrace[], creature: CreatureState) =>
    traces.flatMap((t) => {
      const proposal = t.candidates.find((c) => c.behavior === "core:rest")?.proposal;
      return t.creatureId === creature.id &&
        t.result === "started" &&
        t.chosen?.behavior === "core:rest" &&
        t.chosen.action === "core:follow_path"
        ? [{ from: t.position, params: t.chosen.params, reason: proposal?.reason }]
        : [];
    });

  it("knowing no shelter, searches three times, further each time, then sleeps in the open", () => {
    const { traces, run, spawn, of } = setup(1, 21 * 60);
    const creature = spawn();
    // No vision: it learns only by touch, and the meadow spawn is no shelter.
    creature.variation.senses["core:vision"] = 0;
    creature.needs[HUNGER] = 0;
    const spawnedAt = { ...creature.position };
    run(HOUR, () => creature.asleep);
    expect(creature.asleep).toBe(true);
    const walks = searches(traces, creature);
    expect(walks.map((w) => w.reason)).toEqual(
      [1, 2, 3].map((k) => `night: looking for shelter (${k}/3)`),
    );
    walks.forEach(({ from, params }, k) => {
      const { destination } = params as { destination: { x: number; z: number } };
      const d = Math.hypot(destination.x - from.x, destination.z - from.z);
      // At least half the radius; at most the radius, plus half a cell for the point's place in it.
      expect(d).toBeGreaterThanOrEqual(SHELTER_SEARCH_RADII[k]! / 2);
      expect(d).toBeLessThanOrEqual(SHELTER_SEARCH_RADII[k]! + 0.5);
    });
    expect(of(creature, "fell_asleep")).toEqual([expect.objectContaining({ placementId: null })]);
    expect(
      Math.hypot(creature.position.x - spawnedAt.x, creature.position.z - spawnedAt.z),
    ).toBeGreaterThan(3);
    expect(creature.home).toBeNull();
    // About a minute of searching, not the night.
    expect(of(creature, "fell_asleep")[0]!.tick).toBeLessThan(3 * 600);
  });

  it("finds a shelter while searching and sleeps there, at its new home", () => {
    const { simulation, traces, run, spawn, of } = setup(3, 21 * 60);
    const creature = spawn();
    creature.variation.senses["core:vision"] = 0;
    creature.needs[HUNGER] = 0;
    run(HOUR, () => creature.asleep);
    expect(searches(traces, creature).length).toBeGreaterThan(0);
    const [fell] = of(creature, "fell_asleep");
    const home = (fell as { placementId: string | null }).placementId;
    expect(home).not.toBeNull();
    expect(creature.home).toBe(home);
    const { x, z } = simulation.state.model.propsById.get(home!)!.transform.position;
    expect(Math.hypot(creature.position.x - x, creature.position.z - z)).toBeLessThan(2);
  });

  describe("shelters it can't get to (issue #161)", () => {
    /** A mossling too slow to pass the stuck watchdog, that knows the two nearest shelters. */
    function sluggish(seed: number) {
      const world = setup(seed, 21 * 60, 10, (r) =>
        r.species.register({
          ...r.species.get("hollow:mossling")!,
          id: "test:sluggish-mossling",
          baseSpeed: 0.001,
        }),
      );
      const creature = world.spawn(undefined, "test:sluggish-mossling");
      // No vision, so it knows only the shelters given here.
      creature.variation.senses["core:vision"] = 0;
      creature.needs[HUNGER] = 0;
      const { x, z } = creature.position;
      const shelters = [...world.simulation.state.model.propsByAffordance.get(SHELTER)!]
        .sort(
          (a, b) =>
            Math.hypot(a.transform.position.x - x, a.transform.position.z - z) -
            Math.hypot(b.transform.position.x - x, b.transform.position.z - z),
        )
        .slice(0, 2)
        .map((p) => p.id);
      for (const id of shelters) rememberPlace(creature.knowledge, SHELTER, id, 0, 4);
      /** Wakes it as if nothing had happened, so `core:rest` decides afresh next tick. */
      const wake = () => {
        delete creature.action;
        delete creature.lastResult;
        creature.asleep = false;
        creature.decideAtTick = world.simulation.tick;
      };
      const sleeps = () =>
        world.traces.flatMap((t) =>
          t.creatureId === creature.id &&
          t.result === "started" &&
          t.chosen?.action === "core:sleep"
            ? [(t.chosen.params as { placementId?: string }).placementId ?? null]
            : [],
        );
      return { ...world, creature, shelters, wake, sleeps };
    }
    const failuresOf = (creature: CreatureState, id: string) =>
      creature.knowledge.places[SHELTER]!.find((p) => p.placementId === id)!.failures;

    it("backs off a shelter it got stuck going to, tries the other, then sleeps in the open", () => {
      const { creature, shelters, run, wake, sleeps, traces } = sluggish(1);
      run(HOUR, () => creature.asleep);
      expect(creature.asleep).toBe(true);
      const [first, second] = sleeps();
      expect(first).not.toBeNull();
      expect(failuresOf(creature, first!)).toMatchObject({ stuck: 1, noRoute: 0 });
      // Stuck, it lay down in the open at once, without searching.
      expect(second).toBeNull();
      expect(traces.some((t) => t.chosen?.action === "core:follow_path")).toBe(false);

      // Woken while the first is backed off: it goes for the other shelter instead.
      wake();
      run(HOUR, () => creature.asleep);
      const other = shelters.find((id) => id !== first)!;
      expect(sleeps().slice(2)).toEqual([other, null]);
      expect(failuresOf(creature, other)).toMatchObject({ stuck: 1 });

      // Woken again with both backed off: in the open at once, no search, no trip.
      wake();
      run(2);
      expect(sleeps().slice(4)).toEqual([null]);
      expect(traces.some((t) => t.chosen?.action === "core:follow_path")).toBe(false);
      expect(creature.home).toBeNull();
    });

    it("backs off the same way for the same seed", () => {
      const knowledge = (seed: number) => {
        const { creature, run } = sluggish(seed);
        run(6_000);
        return creature.knowledge;
      };
      const first = knowledge(4);
      expect(first.places[SHELTER]!.some((p) => p.failures)).toBe(true);
      expect(knowledge(4)).toEqual(first);
    });
  });

  it("sleepers at one shelter lie apart, and those it can't fit sleep in the open (issue #158)", () => {
    const COUNT = 8;
    const night = () => {
      const { simulation, run, spawn, of } = setup(6, 21 * 60);
      const creatures = Array.from({ length: COUNT }, () => spawn());
      const { position } = creatures[0]!;
      const shelter = [...simulation.state.model.propsByAffordance.get(SHELTER)!].sort(
        (a, b) =>
          Math.hypot(a.transform.position.x - position.x, a.transform.position.z - position.z) -
          Math.hypot(b.transform.position.x - position.x, b.transform.position.z - position.z),
      )[0]!;
      for (const c of creatures) {
        // They all know only that shelter, and have searched already tonight.
        c.variation.senses["core:vision"] = 0;
        c.needs[HUNGER] = 0;
        c.position = { ...position };
        rememberPlace(c.knowledge, SHELTER, shelter.id, 0, 4);
        c.memory["core:rest"] = { searches: 3, searchedAtTick: 0 };
      }
      run(HOUR, () => creatures.every((c) => c.asleep));
      expect(creatures.every((c) => c.asleep)).toBe(true);
      const at = creatures.filter(
        (c) => (c.action!.state as { placementId: string | null }).placementId === shelter.id,
      );
      // Room for a few, not for all.
      expect(at.length).toBeGreaterThanOrEqual(2);
      expect(at.length).toBeLessThan(COUNT);
      for (const c of creatures) {
        const [fell] = of(c, "fell_asleep") as { placementId: string | null }[];
        const there = at.includes(c);
        expect(fell!.placementId).toBe(there ? shelter.id : null);
        // Only a shelter slept at becomes home.
        expect(c.home).toBe(there ? shelter.id : null);
      }
      const radius = simulation.state.pathfinderFor(MOSSLING)!.navigation.profile.radius;
      const spots = at.map((c) => ({ ...c.position }));
      for (const [i, a] of spots.entries()) {
        for (const b of spots.slice(i + 1)) {
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2 * radius + SLEEPER_GAP);
        }
      }
      return creatures.map((c) => ({ ...c.position }));
    };
    const positions = night();
    expect(night()).toEqual(positions);
  });

  it("homeless sleepers settling on one point lie down apart, the same for the same seed", () => {
    const night = () => {
      const { simulation, run, spawn, of } = setup(5, 21 * 60);
      const creatures = [spawn(), spawn(), spawn(), spawn()];
      const { position } = creatures[0]!;
      for (const c of creatures) {
        c.variation.senses["core:vision"] = 0;
        c.needs[HUNGER] = 0;
        c.position = { ...position };
        // It has searched already tonight.
        c.memory["core:rest"] = { searches: 3, searchedAtTick: 0 };
      }
      run(HOUR, () => creatures.every((c) => c.asleep));
      expect(creatures.every((c) => c.asleep)).toBe(true);
      for (const c of creatures) {
        expect(of(c, "fell_asleep")).toEqual([expect.objectContaining({ placementId: null })]);
      }
      // All but one moved off the point, at least once.
      const moved = creatures.filter((c) => (c.action!.state as { moves: number }).moves > 0);
      expect(moved.length).toBeGreaterThanOrEqual(creatures.length - 1);
      const radius = simulation.state.pathfinderFor(MOSSLING)!.navigation.profile.radius;
      return { positions: creatures.map((c) => ({ ...c.position })), radius };
    };
    const { positions, radius } = night();
    for (const [i, a] of positions.entries()) {
      for (const b of positions.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2 * radius + SLEEPER_GAP);
      }
    }
    expect(night().positions).toEqual(positions);
  });

  it("asleep, hunger rises at a fifteenth of its rate and tiredness falls", () => {
    const { run, spawn } = setup(3, 22 * 60);
    const creature = spawn();
    creature.needs[HUNGER] = 0;
    creature.needs[TIREDNESS] = 0.5;
    run(HOUR, () => creature.asleep);
    const hunger = creature.needs[HUNGER]!;
    const tiredness = creature.needs[TIREDNESS]!;
    run(HOUR);
    expect(creature.asleep).toBe(true);
    const h = creature.variation.needs[HUNGER]!;
    const t = creature.variation.needs[TIREDNESS]!;
    expect(creature.needs[HUNGER]! - hunger).toBeCloseTo(h / 1.5 / 15, 6);
    expect(tiredness - creature.needs[TIREDNESS]!).toBeCloseTo(t / 8, 6);
  });

  it("hunger at 0.9 wakes a sleeper to eat; at 0.8 it sleeps on", () => {
    const { simulation, traces, run, spawn, of } = setup(4, 22 * 60);
    const creature = spawn();
    creature.needs[HUNGER] = 0;
    run(HOUR, () => creature.asleep);
    // A day-phase reaction at hunger 0.8: feed (1.0) doesn't beat sleep (0.95) by 0.15.
    creature.needs[HUNGER] = 0.8;
    creature.phaseReactionTick = simulation.tick;
    run(1);
    expect(traces.at(-1)!.result).toBe("kept");
    expect(creature.asleep).toBe(true);
    // Hunger crosses 0.9: feed (1.1) wakes it.
    creature.needs[HUNGER] = 0.8999;
    run(HOUR, () => !creature.asleep);
    const woke = traces.at(-1)!;
    expect(woke.result).toBe("started");
    expect(woke.chosen?.behavior).toBe("core:feed");
    expect(woke.triggers).toEqual([{ kind: "need", need: HUNGER, threshold: 0.9 }]);
    expect(of(creature, "woke_up")).toEqual([expect.objectContaining({ reason: "interrupted" })]);
    expect(creature.lastResult).toEqual({
      action: "core:sleep",
      outcome: "interrupted",
      reason: "outranked",
    });
    // Awake from the interruption on, and no longer showing the sleeping cue.
    expect(creature.asleep).toBe(false);
    run(1);
    expect(creature.asleep).toBe(false);
    expect(simulation.snapshot().creatures[0]!.cues).not.toContain("sleeping");
    // It eats, then goes back to bed.
    run(HOUR, () => of(creature, "fell_asleep").length === 2);
    expect(of(creature, "ate").length).toBeGreaterThanOrEqual(1);
    expect(creature.asleep).toBe(true);
  });

  it("wakes at dawn when rested, and stays awake", () => {
    const { run, spawn, of } = setup(5, 5 * 60 + 30, 2);
    const creature = spawn();
    steady(creature);
    creature.needs[HUNGER] = 0;
    creature.needs[TIREDNESS] = 0.05;
    run(1_200, () => creature.asleep);
    expect(creature.asleep).toBe(true);
    // Until 06:00 and a little after.
    run(2 * 3_600);
    expect(creature.asleep).toBe(false);
    const [woke] = of(creature, "woke_up");
    expect(woke).toMatchObject({ reason: "rested" });
    // At 06:00, not later: 05:30 plus 30 minutes at 2 Hz.
    expect(woke!.tick).toBe(3_600);
    expect(of(creature, "fell_asleep")).toHaveLength(1);
  });

  it("doesn't sleep in the first 10 minutes after a Studio release", () => {
    const { simulation, run, spawn, of } = setup(6, 22 * 60, 2);
    const released = spawn({ released: true });
    const placed = spawn();
    for (const c of [released, placed]) c.needs[HUNGER] = 0;
    expect(released.releasedAtTick).toBe(0);
    expect(placed.releasedAtTick).toBeUndefined();
    run(9 * 120);
    expect(of(released, "fell_asleep")).toEqual([]);
    expect(of(placed, "fell_asleep")).toHaveLength(1);
    // The next trigger after the grace sends it to bed: wander's actions are short.
    run(5 * 120, () => released.asleep);
    expect(released.asleep).toBe(true);
    expect(simulation.tick * 0.5).toBeGreaterThanOrEqual(600);
  });

  it("a nocturnal creature sleeps by day and wakes at dusk", () => {
    const { run, spawn, of } = setup(9, 11 * 60, 2, (r) => {
      r.species.register({
        ...r.species.get("hollow:mossling")!,
        id: "test:night-mossling",
        traits: { [NOCTURNAL]: 1 },
      });
    });
    const creature = spawn(undefined, "test:night-mossling");
    steady(creature);
    creature.needs[HUNGER] = 0;
    creature.needs[TIREDNESS] = 0.3;
    // Day is its sleeping phase: the bonus alone sends it to bed.
    run(1_200, () => creature.asleep);
    expect(creature.asleep).toBe(true);
    // Rested by early afternoon, it sleeps on until its waking phase begins at 18:00.
    run(6 * 7_200 - 1_300);
    expect(creature.asleep).toBe(true);
    run(2 * 7_200);
    expect(of(creature, "woke_up")).toEqual([
      expect.objectContaining({ reason: "rested", tick: 7 * 7_200 }),
    ]);
    // Awake through dusk and into the night: the bonus alone doesn't send it back to bed there.
    expect(of(creature, "fell_asleep")).toHaveLength(1);
    expect(creature.asleep).toBe(false);
  });

  it("the watchdog calls interrupted, and the creature is awake at once", () => {
    const interrupts: string[] = [];
    // Reports asleep while it walks, so the watchdog stops it on a tick it reported asleep.
    const sleepwalk: ActionProvider = {
      id: "test:sleepwalk",
      version: "1.0.0",
      start: () => ({
        ok: true,
        state: { points: [{ regionId: "west-woods", x: -15, z: 7 }], next: 0 },
      }),
      step: (state, context) => {
        context.walk(state as Parameters<ActionContext["walk"]>[0]);
        return { status: "running", asleep: true };
      },
      interrupted: (_state, _context, reason) => interrupts.push(reason),
    };
    const sleepwalker: BehaviorProvider = {
      id: "test:sleepwalker",
      version: "1.0.0",
      dependencies: [{ registry: "actions", id: "test:sleepwalk" }],
      evaluate: (o) => (o.tick < 5 ? { action: "test:sleepwalk", utility: 0.5 } : null),
    };
    const { run, spawn } = setup(10, 12 * 60, 10, (r) => {
      r.actions.register(sleepwalk);
      r.behaviors.register(sleepwalker);
      r.species.register({
        ...r.species.get("hollow:mossling")!,
        id: "test:sleepwalker",
        // So slow that walking never makes the watchdog's 5 cm of progress in 5 s.
        baseSpeed: 0.001,
        behaviors: ["test:sleepwalker"],
      });
    });
    const creature = spawn(undefined, "test:sleepwalker");
    // Decides on the first tick, steps (asleep) from the second.
    run(2);
    expect(creature.action?.id).toBe("test:sleepwalk");
    expect(creature.asleep).toBe(true);
    run(100, () => creature.action === undefined);
    expect(interrupts).toEqual(["stuck"]);
    expect(creature.lastResult).toMatchObject({ outcome: "interrupted", reason: "stuck" });
    expect(creature.asleep).toBe(false);
  });

  it("emits the interrupted action's woke_up before the challenger's events", () => {
    const sleeper: ActionProvider = {
      id: "test:sleeper",
      version: "1.0.0",
      start: () => ({ ok: true, state: {} }),
      step: () => ({ status: "running", asleep: true }),
      interrupted: (_state, context) =>
        context.emit({ type: "woke_up", reason: "interrupted", tiredness: 0 }),
    };
    const announce: ActionProvider = {
      id: "test:announce",
      version: "1.0.0",
      start: (_params, context) => {
        context.emit({ type: "ate", placementId: "none", hunger: 0 });
        return { ok: true, state: {} };
      },
      step: () => ({ status: "running" }),
    };
    const behaviors: BehaviorProvider[] = [
      {
        id: "test:sleepy",
        version: "1.0.0",
        dependencies: [{ registry: "actions", id: "test:sleeper" }],
        evaluate: () => ({ action: "test:sleeper", utility: 0.5 }),
      },
      {
        id: "test:eager",
        version: "1.0.0",
        dependencies: [{ registry: "actions", id: "test:announce" }],
        evaluate: (o) => (o.tick > 1 ? { action: "test:announce", utility: 1 } : null),
      },
    ];
    const { simulation, events, run, spawn } = setup(11, 12 * 60, 10, (r) => {
      r.actions.register(sleeper);
      r.actions.register(announce);
      for (const b of behaviors) r.behaviors.register(b);
      r.species.register({
        ...r.species.get("hollow:mossling")!,
        id: "test:sleepy",
        behaviors: ["test:sleepy", "test:eager"],
      });
    });
    const creature = spawn(undefined, "test:sleepy");
    run(3);
    expect(creature.action?.id).toBe("test:sleeper");
    creature.phaseReactionTick = simulation.tick;
    run(1);
    expect(creature.action?.id).toBe("test:announce");
    expect(creature.asleep).toBe(false);
    const order = events.filter((e) => e.type === "woke_up" || e.type === "ate");
    expect(order.map((e) => e.type)).toEqual(["woke_up", "ate"]);
  });

  it("stays up through dusk unless tired, and goes to bed as night begins", () => {
    const { run, spawn, of } = setup(12, 18 * 60 + 30, 2);
    const rested = spawn();
    const tired = spawn();
    for (const c of [rested, tired]) {
      steady(c);
      c.needs[HUNGER] = 0;
    }
    rested.needs[TIREDNESS] = 0.5;
    tired.needs[TIREDNESS] = 0.95;
    // 18:30 to 20:00: the dusk bonus alone doesn't start sleep, but adds to real tiredness.
    run(90 * 120);
    expect(of(rested, "fell_asleep")).toEqual([]);
    expect(of(tired, "fell_asleep")).toHaveLength(1);
    // Night: the phase reaction (0–30 s) sends it to bed.
    run(15 * 120);
    const [bedtime] = of(rested, "fell_asleep");
    expect(bedtime).toBeDefined();
    expect(bedtime!.tick).toBeGreaterThanOrEqual(90 * 120);
  });

  describe("from night to night (issue #85)", () => {
    const DAYS = 6;
    /** Two mosslings over six days from noon at 1 Hz: their sleep events and own days. */
    const nights = (seed: number) => {
      const { simulation, events, run } = setup(seed, 12 * 60, 1);
      for (let k = 0; k < 2; k++) simulation.spawn("hollow:mossling");
      run(DAYS * 24 * 3_600);
      const sleep = events.filter((e) => e.type === "fell_asleep" || e.type === "woke_up");
      return { simulation, sleep };
    };
    // The time of day of a tick: noon plus simulated time at 1 Hz.
    const at = (tick: number) => minutesAfter(12 * 60, tick * 1000);
    let simulation: ReturnType<typeof nights>["simulation"];
    let sleep: SimulationEvent[];
    beforeAll(() => ({ simulation, sleep } = nights(3)), 60_000);
    const ofCreature = (id: string) =>
      sleep.filter((e) => "creatureId" in e && e.creatureId === id);

    it("goes to bed and wakes within half an hour of dusk's end and dawn, not the same each night", () => {
      for (const id of simulation.state.creatures.keys()) {
        const events = ofCreature(id);
        const bedtimes = events.filter((e) => e.type === "fell_asleep").map((e) => at(e.tick));
        const wakes = events.filter((e) => e.type === "woke_up").map((e) => at(e.tick));
        expect(bedtimes).toHaveLength(DAYS);
        expect(wakes).toHaveLength(DAYS);
        // Its own night starts 19:30–20:30; then up to 30 s to react and a short walk home.
        for (const t of bedtimes) {
          expect(t).toBeGreaterThanOrEqual(19 * 60 + 30);
          expect(t).toBeLessThan(20 * 60 + 40);
        }
        // Its own dawn starts 05:30–06:30, and it is rested long before.
        for (const t of wakes) {
          expect(t).toBeGreaterThanOrEqual(5 * 60 + 30);
          expect(t).toBeLessThan(6 * 60 + 31);
        }
        const spread = (times: number[]) => Math.max(...times) - Math.min(...times);
        expect(spread(bedtimes)).toBeGreaterThan(10);
        expect(spread(wakes)).toBeGreaterThan(10);
      }
    });

    it("self-corrects through tiredness: every night rests it, and a longer day tires it more", () => {
      for (const creature of simulation.state.creatures.values()) {
        const events = ofCreature(creature.id) as Extract<
          SimulationEvent,
          { type: "fell_asleep" | "woke_up" }
        >[];
        const rate =
          tirednessNeed.perHour.awake * (creature.variation.needs[TIREDNESS] ?? 1) * (1 / 3600);
        for (const [k, event] of events.entries()) {
          // Whatever the night before, it wakes rested, so a late night carries nothing over.
          if (event.type === "woke_up") expect(event.tiredness).toBeLessThan(WAKE_TIREDNESS);
          // What carries over is the day: it goes to bed as tired as its time awake since
          // waking makes it, so one that woke early is more tired by its bedtime.
          const woke = events[k - 1];
          if (event.type !== "fell_asleep" || woke?.type !== "woke_up") continue;
          expect(event.tiredness).toBeCloseTo(woke.tiredness + rate * (event.tick - woke.tick), 6);
        }
      }
    });

    it("draws the same nights for the same seed", { timeout: 30_000 }, () => {
      const again = nights(3);
      expect(again.sleep).toEqual(sleep);
      expect([...again.simulation.state.creatures.values()].map((c) => c.day)).toEqual(
        [...simulation.state.creatures.values()].map((c) => c.day),
      );
    });
  });

  it("repeats the same nights for the same seed", { timeout: 30_000 }, () => {
    const night = (seed: number) => {
      const { simulation, events, run } = setup(seed, 19 * 60 + 30, 1);
      for (let k = 0; k < 2; k++) simulation.spawn("hollow:mossling");
      run(12 * 3_600);
      const sleep = events.filter(
        (e) => e.type === "fell_asleep" || e.type === "woke_up" || e.type === "new_home_selected",
      );
      return {
        sleep,
        states: [...simulation.state.creatures.values()].map((c) => JSON.stringify(c)),
      };
    };
    const first = night(7);
    expect(first.sleep.length).toBeGreaterThan(2);
    expect(night(7)).toEqual(first);
    expect(night(8).sleep).not.toEqual(first.sleep);
  });
});

describe("a home it can't get to (issue #171)", () => {
  const START = 21 * 60;
  /** A day in ticks at 10 Hz. */
  const DAY = 864_000;

  /**
   * A wader in the far-shelter world, at home at the tree in the pond, which it has failed to
   * reach `failures` times: a day before, or just now, so it is still backed off at bedtime. It
   * doesn't know the tree in the meadow.
   */
  function wading(seed: number, failures: number, failedAt = -DAY) {
    const traces: DecisionTrace[] = [];
    const simulation = createSimulation({
      register: registerFarShelter,
      worldId: "fixture:far-shelter",
      seed,
      startMinutes: START,
      onTrace: (t) => traces.push(t),
    });
    const spawned = simulation.spawn("fixture:wader", "start");
    if (!spawned.ok) throw new Error("spawn failed");
    const creature = spawned.value;
    creature.home = "pond-tree";
    rememberPlace(creature.knowledge, SHELTER, "pond-tree", 0, 4);
    for (let k = 0; k < failures; k++) {
      recordReach(creature.knowledge, SHELTER, "pond-tree", "stuck", {
        tick: failedAt,
        tickSeconds: 0.1,
        cell: { x: 0, z: 0 },
      });
    }
    const events: SimulationEvent[] = [];
    /** Runs `ticks`, or until `done`: by default, until it is asleep. */
    const run = (ticks: number, done = () => creature.asleep) => {
      for (let t = 0; t < ticks && !done(); t++) {
        simulation.setTimeOfDay(
          minutesAfter(START, (simulation.tick * 1000) / simulation.tickRateHz),
        );
        events.push(...simulation.step());
      }
    };
    const of = (type: SimulationEvent["type"]) => events.filter((e) => e.type === type);
    /** What `core:rest` started: sleeps by place (null in the open), and searches. */
    const started = () =>
      traces.flatMap((t) =>
        t.result !== "started" || t.chosen?.behavior !== "core:rest"
          ? []
          : t.chosen.action === "core:sleep"
            ? [(t.chosen.params as { placementId?: string }).placementId ?? null]
            : ["search"],
      );
    return { simulation, creature, events, run, of, started };
  }
  const failuresOf = (creature: CreatureState) =>
    creature.knowledge.places[SHELTER]!.find((p) => p.placementId === "pond-tree")!.failures;

  it("having failed twice, gets stuck again, searches, and moves to the tree it finds", () => {
    const { creature, run, of, started } = wading(1, SEARCH_AFTER_SHELTER_FAILURES);
    run(DAY);
    expect(creature.asleep).toBe(true);
    const tries = started();
    // Home first, stuck on the way in the pond; then searches, and the tree seen on one.
    expect(tries[0]).toBe("pond-tree");
    expect(tries.length).toBeGreaterThan(2);
    expect(tries.slice(1, -1).every((t) => t === "search")).toBe(true);
    expect(tries.at(-1)).toBe("meadow-tree");
    expect(failuresOf(creature)).toMatchObject({ stuck: 3 });
    expect(of("creature_stuck").length).toBeGreaterThan(0);
    expect(of("fell_asleep")).toEqual([expect.objectContaining({ placementId: "meadow-tree" })]);
    expect(of("new_home_selected")).toEqual([
      expect.objectContaining({ placementId: "meadow-tree", previous: "pond-tree" }),
    ]);
    expect(creature.home).toBe("meadow-tree");
    // Within the first night's first hour.
    expect(of("fell_asleep")[0]!.tick).toBeLessThan(36_000);
  });

  it("failing for the first time, sleeps in the open without searching", () => {
    const { creature, run, of, started } = wading(1, 0);
    run(DAY);
    expect(started()).toEqual(["pond-tree", null]);
    expect(failuresOf(creature)).toMatchObject({ stuck: 1 });
    expect(of("fell_asleep")).toEqual([expect.objectContaining({ placementId: null })]);
    expect(creature.home).toBe("pond-tree");
  });

  it("moves to the tree within four nights, whatever the seed", { timeout: 120_000 }, () => {
    const SEEDS = Array.from({ length: 32 }, (_, k) => k + 1);
    for (const failedAt of [-DAY, 0]) {
      for (const seed of SEEDS) {
        const { creature, run, started } = wading(seed, SEARCH_AFTER_SHELTER_FAILURES, failedAt);
        run(4 * DAY, () => creature.asleep && creature.home === "meadow-tree");
        expect([failedAt, seed, creature.home, creature.asleep]).toEqual([
          failedAt,
          seed,
          "meadow-tree",
          true,
        ]);
        // With home backed off at bedtime, it searches at once instead of sleeping in the open.
        if (failedAt === 0) expect([seed, started()[0]]).toEqual([seed, "search"]);
      }
    }
  });

  it("does the same for the same seed", { timeout: 30_000 }, () => {
    const outcome = (seed: number) => {
      const { creature, events, run } = wading(seed, SEARCH_AFTER_SHELTER_FAILURES);
      run(2 * DAY, () => false);
      return { events, creature: JSON.stringify(creature) };
    };
    const first = outcome(5);
    expect(first.events.some((e) => e.type === "new_home_selected")).toBe(true);
    expect(outcome(5)).toEqual(first);
    expect(outcome(6).events).not.toEqual(first.events);
  });

  /** Where the creature sleeps: the shelter, or null in the open. */
  const bed = (creature: CreatureState) =>
    (creature.action?.state as { placementId: string | null }).placementId;

  it("catch-up records no failure, doesn't search, and puts it to bed in the open", () => {
    const { simulation, creature, run, started } = wading(1, SEARCH_AFTER_SHELTER_FAILURES);
    // On its way home, before it reaches the pond.
    run(20);
    expect(started()).toEqual(["pond-tree"]);
    const before = structuredClone(failuresOf(creature));
    simulation.catchUp({ gapMs: 3 * 3_600_000, minutes: 0 });
    run(600, () => false);
    expect(failuresOf(creature)).toEqual(before);
    expect(started()).toEqual(["pond-tree"]);
    expect(creature.asleep).toBe(true);
    // Not at home in the pond, which it keeps failing to reach (issue #175).
    expect(bed(creature)).toBeNull();
    expect(creature.home).toBe("pond-tree");
  });

  it("catch-up puts it to bed at a tree it knows that isn't failing, keeping home (issue #175)", () => {
    const outcome = (seed: number, failures: number) => {
      const { simulation, creature, run } = wading(seed, failures);
      rememberPlace(creature.knowledge, SHELTER, "meadow-tree", 0, 4);
      run(20);
      const knowledge = structuredClone(creature.knowledge);
      simulation.catchUp({ gapMs: 3 * 3_600_000, minutes: 0 });
      expect(creature.knowledge).toEqual(knowledge);
      return { bed: bed(creature), creature: JSON.stringify(creature) };
    };
    const failing = outcome(1, SEARCH_AFTER_SHELTER_FAILURES);
    expect(failing.bed).toBe("meadow-tree");
    expect(JSON.parse(failing.creature)).toMatchObject({ asleep: true, home: "pond-tree" });
    // The same for the same seed.
    expect(outcome(1, SEARCH_AFTER_SHELTER_FAILURES)).toEqual(failing);
    // Failing once only, home is not failing: home, as before.
    expect(outcome(1, SEARCH_AFTER_SHELTER_FAILURES - 1).bed).toBe("pond-tree");
  });
});
