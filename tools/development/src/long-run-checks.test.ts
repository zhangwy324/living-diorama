import { registerBuiltInContent } from "@living-diorama/built-in-content";
import type {
  CreatureState,
  DayPhase,
  DecisionTrace,
  Simulation,
  SimulationEvent,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { LongRunChecks, type CreatureTick, type LongRunCheckOptions } from "./long-run-checks";
import { registerRiverCrossing } from "./fixtures/river-crossing";
import { LIVING_BEHAVIOR_CHECKS, reachesFood, runWithInvariants } from "./simulation-run";

// The ADR 0018 §20 checks, fed synthetic runs that break them, and wired into the runner.

const HZ = 10;
const withoutTick = (violation: string) => violation.replace(/^seed \d+, tick \d+: /, "");
const HOUR = 3600 * HZ;

function checker(options: LongRunCheckOptions = {}) {
  const violations: string[] = [];
  const checks = new LongRunChecks(HZ, options, (m) => violations.push(m));
  const creature = (overrides: Partial<CreatureTick> = {}): CreatureTick => ({
    id: "c1",
    speciesId: "test:critter",
    needs: {},
    asleep: false,
    cues: [],
    ...overrides,
  });
  /** `count` ticks from `from`, with one creature. */
  const live = (from: number, count: number, phase: DayPhase, c: Partial<CreatureTick> = {}) => {
    for (let t = from; t < from + count; t++) checks.tick(t, phase, [creature(c)]);
  };
  const trace = (tick: number, overrides: Partial<DecisionTrace> = {}): DecisionTrace => ({
    tick,
    creatureId: "c1",
    position: { regionId: "meadow", x: 0, z: 0 },
    triggers: [],
    needs: {},
    candidates: [],
    result: "started",
    ...overrides,
  });
  const interruption = (tick: number) =>
    trace(tick, { running: { action: "core:idle", behavior: "core:wander", utility: 0.1 } });
  return { checks, violations, live, trace, interruption };
}

describe("long-run checks", () => {
  it("keeps every need in [0, 1]", () => {
    const { checks, violations } = checker();
    checks.tick(1, "day", [
      { id: "ok", speciesId: "s", needs: { a: 0, b: 1 }, asleep: false, cues: [] },
      { id: "bad", speciesId: "s", needs: { a: 1.2, b: -0.1, c: NaN }, asleep: false, cues: [] },
    ]);
    expect(violations).toEqual(["bad: a is 1.2", "bad: b is -0.1", "bad: c is NaN"]);
  });

  it("bounds decisions to about one per creature per 10 s on average, the first free", () => {
    for (const [decisions, expected] of [
      [11, 0],
      [12, 1],
    ] as const) {
      const { checks, violations, live, trace } = checker();
      live(1, 100 * HZ, "day");
      for (let n = 0; n < decisions; n++) checks.trace(trace(n * 10));
      checks.finish();
      expect(violations).toHaveLength(expected);
      expect(checks.creatures.get("c1")!.decisions).toBe(decisions);
    }
  });

  it("bounds interruptions to 3 per creature in any minute, counted from traces", () => {
    const { checks, violations, trace, interruption } = checker();
    // Spread over more than a minute, and evaluations that kept or started without one running.
    for (const tick of [0, 300, 599, 600, 1200]) checks.trace(interruption(tick));
    checks.trace(
      trace(601, { running: { action: "a", behavior: "b", utility: 1 }, result: "kept" }),
    );
    checks.trace(trace(602));
    expect(violations).toEqual([]);
    expect(checks.creatures.get("c1")).toMatchObject({
      decisions: 7,
      interruptions: 5,
      peakInterruptionsPerMinute: 3,
    });
    // A fourth within the minute ending at tick 1250, reported once.
    for (const tick of [1210, 1220, 1250, 1260]) checks.trace(interruption(tick));
    expect(violations).toEqual(["c1: 4 interruptions within a minute (at most 3)"]);
    expect(checks.creatures.get("c1")!.peakInterruptionsPerMinute).toBe(5);
  });

  it("fails a retry loop: more than 20 rejected or empty evaluations in a row", () => {
    const { checks, violations, trace } = checker();
    const failures = (from: number, count: number) => {
      for (let n = 0; n < count; n++) {
        checks.trace(trace(from + n, { result: n % 2 ? "rejected" : "no_proposal" }));
      }
    };
    failures(0, 20);
    // `kept` neither counts nor ends the run; `started` ends it.
    checks.trace(
      trace(20, { running: { action: "a", behavior: "b", utility: 1 }, result: "kept" }),
    );
    checks.trace(trace(21));
    failures(22, 20);
    expect(violations).toEqual([]);
    checks.trace(trace(42, { result: "rejected" }));
    failures(43, 5);
    expect(violations).toEqual(["c1: 21 rejected or empty evaluations in a row (at most 20)"]);

    const loose = checker({ maxFailedDecisionsInARow: 100 });
    for (let n = 0; n < 100; n++) loose.checks.trace(loose.trace(n, { result: "no_proposal" }));
    expect(loose.violations).toEqual([]);
  });

  it("counts meals, and checks one every 3 h awake only when asked", () => {
    const meal = (tick: number) => ({ type: "ate", tick, creatureId: "c1" }) as never;
    const off = checker();
    off.live(0, 4 * HOUR, "day");
    expect(off.violations).toEqual([]);

    const on = checker({ meals: {} });
    on.live(0, 2 * HOUR, "day");
    on.checks.event(meal(2 * HOUR));
    on.live(2 * HOUR, 3 * HOUR, "day");
    expect(on.violations).toEqual([]);
    on.live(5 * HOUR, 2, "day");
    expect(on.violations).toEqual(["c1: no meal for 3 h awake"]);

    // Time asleep doesn't count: 2 h awake, a 10-hour night, 1 h awake is no gap.
    const night = checker({ meals: {} });
    night.checks.event(meal(0));
    night.live(0, 2 * HOUR, "dusk");
    night.live(2 * HOUR, 10 * HOUR, "night", { asleep: true });
    night.live(12 * HOUR, HOUR, "dawn");
    expect(night.violations).toEqual([]);
    night.live(13 * HOUR, 1, "dawn");
    expect(night.violations).toEqual(["c1: no meal for 3 h awake"]);
    expect(on.checks.creatures.get("c1")!.meals).toBe(1);
    // Other events don't count.
    on.checks.event({ type: "creature_stuck", tick: 1, creatureId: "c1" } as SimulationEvent);
    expect(on.checks.creatures.get("c1")!.meals).toBe(1);

    // A creature its `creatures` filter leaves out.
    const filtered = checker({ meals: { hours: 1 } });
    filtered.live(0, 2 * HOUR, "day", { checkMeals: false });
    expect(filtered.violations).toEqual([]);
  });

  it("checks that creatures sleep most of the night only when asked", () => {
    const run = (options: LongRunCheckOptions, asleepNightTicks: number, nightTicks = 2 * HOUR) => {
      const c = checker(options);
      c.live(0, HOUR, "day", { asleep: true });
      c.live(HOUR, asleepNightTicks, "night", { asleep: true });
      c.live(HOUR + asleepNightTicks, nightTicks - asleepNightTicks, "night");
      c.checks.finish();
      return c;
    };
    expect(run({}, 0).violations).toEqual([]);
    expect(run({ sleep: {} }, HOUR - 1).violations).toEqual([
      "c1: asleep 50% of the night (at least 50%)",
    ]);
    expect(run({ sleep: {} }, HOUR).violations).toEqual([]);
    const skipped = checker({ sleep: {} });
    skipped.live(0, 2 * HOUR, "night", { checkSleep: false });
    skipped.checks.finish();
    expect(skipped.violations).toEqual([]);
    // At most 14 hours a day asleep, once a whole day is lived: one that never wakes fails.
    const sleepy = (asleepHours: number) => {
      const c = checker({ sleep: {} });
      c.live(0, asleepHours * HOUR, "night", { asleep: true });
      c.live(asleepHours * HOUR, (24 - asleepHours) * HOUR, "day");
      c.checks.finish();
      return c.violations;
    };
    expect(sleepy(14)).toEqual([]);
    expect(sleepy(24)).toEqual(["c1: asleep 24.0 h a day (at most 14)"]);
    // A run whose ticks are mostly night, as after a catch-up that skipped a day: asleep every
    // night tick is 10 hours a day, however many night ticks were stepped.
    const skewed = (asleepOtherHours: number) => {
      const c = checker({ sleep: {} });
      c.live(0, 16 * HOUR, "night", { asleep: true });
      c.live(16 * HOUR, asleepOtherHours * HOUR, "day", { asleep: true });
      c.live((16 + asleepOtherHours) * HOUR, (8 - asleepOtherHours) * HOUR, "day");
      c.checks.finish();
      return c.violations;
    };
    expect(skewed(0)).toEqual([]);
    expect(skewed(2)).toEqual([]);
    // Oversleeping still shows: asleep half of the other ticks too is 10 + 7 hours a day.
    expect(skewed(4)).toEqual(["c1: asleep 17.0 h a day (at most 14)"]);
    const short = checker({ sleep: {} });
    short.live(0, 4 * HOUR, "night", { asleep: true });
    short.checks.finish();
    expect(short.violations).toEqual([]);
    // Less than an hour of night: too little to judge.
    expect(run({ sleep: {} }, 0, HOUR - 1).violations).toEqual([]);
    expect(run({ sleep: { minShare: 0.9 } }, 1.5 * HOUR).checks.creatures.get("c1")).toMatchObject({
      asleepTicks: 2.5 * HOUR,
      nightTicks: 2 * HOUR,
      asleepAtNightTicks: 1.5 * HOUR,
    });
  });

  it("counts time hungry by the cue or by hunger", () => {
    const { checks, live } = checker();
    live(0, 10, "day", { cues: ["hungry"] });
    live(10, 10, "day", { needs: { "core:hunger": 0.8 } });
    live(20, 10, "day", { needs: { "core:hunger": 0.79 }, cues: ["eating"] });
    expect(checks.creatures.get("c1")).toMatchObject({ ticks: 30, hungryTicks: 20 });
  });

  it("are wired into the runner, with the meal and sleep checks off by default", () => {
    // Pebbles only wander: no food, no sleep.
    const river = {
      register: registerRiverCrossing,
      worldId: "fixture:river-crossing",
      speciesId: "fixture:pebble",
      seed: 1,
      creatures: 2,
      tickRateHz: 2,
      startMinutes: 19 * 60,
      ticks: 4 * 3600 * 2,
      // Short walks in a small world (see LongRunCheckOptions).
      maxDecisionsPer10Seconds: 2,
    };
    const clean = runWithInvariants(river);
    expect(clean.violations).toEqual([]);
    expect(Object.keys(clean.creatures)).toEqual(["creature-1", "creature-2"]);
    expect(clean.creatures["creature-1"]).toMatchObject({ ticks: river.ticks, meals: 0 });
    expect(clean.creatures["creature-1"]!.decisions).toBeGreaterThan(0);
    // Pebbles have no needs, so the meal and sleep checks as Woodland Hollow runs them skip them.
    expect(runWithInvariants({ ...river, ...LIVING_BEHAVIOR_CHECKS }).violations).toEqual([]);
    // Held to them anyway, both fail: nothing to eat, and no sleep.
    const checked = runWithInvariants({ ...river, meals: {}, sleep: {} });
    expect(checked.violations.map(withoutTick)).toEqual([
      "creature-1: no meal for 3 h awake",
      "creature-2: no meal for 3 h awake",
      "creature-1: asleep 0% of the night (at least 50%)",
      "creature-2: asleep 0% of the night (at least 50%)",
    ]);

    const corrupted = runWithInvariants({
      ...river,
      ticks: 2,
      onTick: (simulation) => {
        simulation.state.creatures.get("creature-1")!.needs["test:corrupt"] = 1.5;
      },
    });
    expect(corrupted.violations).toEqual(["seed 1, tick 2: creature-1: test:corrupt is 1.5"]);
  });

  it("holds mosslings to the checks: they eat while awake and sleep the night through", () => {
    const hollow = {
      register: registerBuiltInContent,
      worldId: "hollow:woodland-hollow",
      speciesId: "hollow:mossling",
      seed: 1,
      creatures: 2,
      tickRateHz: 2,
      startMinutes: 19 * 60,
      ticks: 4 * 3600 * 2,
    };
    // They eat over dusk, go to bed as night begins and sleep it through without eating; only
    // time awake counts towards the meal check, so the night is no gap.
    const checked = runWithInvariants({ ...hollow, ...LIVING_BEHAVIOR_CHECKS });
    expect(checked.violations).toEqual([]);
    for (const c of Object.values(checked.creatures)) {
      expect(c.meals).toBeGreaterThan(0);
      expect(c.asleepAtNightTicks / c.nightTicks).toBeGreaterThan(0.99);
    }

    // A hungry creature that can reach no food is left out of the meal check, as is one without
    // hunger.
    const fed = { id: "c", needs: { "core:hunger": 0.2 } } as unknown as CreatureState;
    const unreachable = {
      state: { model: { propsByAffordance: new Map([["core:food", [{ id: "far-bush" }]]]) } },
      spotFor: () => undefined,
    } as unknown as Simulation;
    expect(reachesFood(fed, unreachable)).toBe(false);
    const reachable = { ...unreachable, spotFor: () => ({ regionId: "r", x: 0, z: 0 }) };
    expect(reachesFood(fed, reachable as unknown as Simulation)).toBe(true);
    expect(reachesFood({ ...fed, needs: {} }, reachable as unknown as Simulation)).toBe(false);

    // Filters see the creature's state and the simulation, once per creature.
    const seen: string[] = [];
    const filtered = runWithInvariants({
      ...hollow,
      meals: {
        hours: 0.25,
        creatures: (c, simulation) => {
          seen.push(c.id);
          return reachesFood(c, simulation) && c.id === "creature-2";
        },
      },
      sleep: { minShare: 1.01, creatures: (c) => c.id === "creature-2" },
    });
    expect(seen).toEqual(["creature-1", "creature-2"]);
    // Held to a meal every 15 minutes awake and to sleeping more than the whole night, only
    // creature-2 fails.
    const violations = filtered.violations.map(withoutTick);
    expect(violations).toContain("creature-2: no meal for 0.25 h awake");
    expect(violations).toContain("creature-2: asleep 100% of the night (at least 101%)");
    expect(violations.filter((v) => !v.startsWith("creature-2: "))).toEqual([]);
  });
});
