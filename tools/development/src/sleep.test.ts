import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  chooseShelter,
  emptyKnowledge,
  minutesAfter,
  rememberPlace,
  restBehavior,
  Rng,
  SLEEP_CONTINUE_UTILITY,
  sleepAction,
  sleepCycle,
  type ActionContext,
  type CreatureObservation,
  type CreatureState,
  type DayPhase,
  type DecisionTrace,
  type SimulationEvent,
  type WorldQueries,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { createSimulation } from "./simulation-run";

// Shelter, sleep and home (ADR 0018 §13, §14 and amendments, PR 5a): `core:rest` and `core:sleep`.

const SHELTER = "core:shelter";
const HUNGER = "core:hunger";
const TIREDNESS = "core:tiredness";
const NOCTURNAL = "core:nocturnal";

// ---- core:rest -------------------------------------------------------------------------------

interface Stub {
  places: Record<string, { x: number; z: number }>;
  /** Route length per placement; undefined means no route. */
  routes?: Record<string, number | undefined>;
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
      return p && { id, ...p, y: 0, blockRadius: 0, affordances: { [SHELTER]: {} } };
    },
    spotAt: (id) => stub.places[id] && { regionId: id, ...stub.places[id]! },
    routeLength: (destination) => stub.routes?.[destination.regionId],
    reachableRegions: () => [],
    randomWalkablePoint: () => undefined,
    randomWalkablePointWithin: () => undefined,
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
      { waking: true, bonus: 0.2 },
      { waking: true, bonus: 0 },
      { waking: false, bonus: 0.2 },
      { waking: false, bonus: 0.5 },
    ]);
    expect(phases.map((p) => sleepCycle(p, true))).toEqual([
      { waking: false, bonus: 0.2 },
      { waking: false, bonus: 0.5 },
      { waking: true, bonus: 0.2 },
      { waking: true, bonus: 0 },
    ]);
  });

  it.each([
    // phase, nocturnal, tiredness, utility (null: no proposal)
    ["dawn", 0, 0.3, null],
    ["day", 0, 0.3, null],
    ["dusk", 0, 0.3, 0.7],
    ["night", 0, 0.3, 1.0],
    ["night", 0, 0, 0.7],
    ["dawn", 0, 0.9, 1.3],
    ["day", 0, 0.9, 1.1],
    ["dusk", 0, 0.9, 1.3],
    ["night", 0, 0.9, 1.6],
    ["dawn", 1, 0.3, 0.7],
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

  it("knowing no shelter, or none it can reach, sleeps where it stands", () => {
    expect(evaluate(observe({ places: {} }, { dayPhase: "night" }))).toMatchObject({
      action: "core:sleep",
      params: {},
    });
    const unreachable = observe({ places: { t: { x: 3, z: 0 } } }, { knowledge: knowing("t") });
    expect(evaluate({ ...unreachable, dayPhase: "night" })).toMatchObject({ params: {} });
  });

  it("sleeps where it stands after failing to reach a shelter", () => {
    const observation = observe(
      { places: { t: { x: 3, z: 0 } }, routes: { t: 4 } },
      {
        dayPhase: "night",
        knowledge: knowing("t"),
        lastResult: { action: "core:sleep", outcome: "interrupted", reason: "stuck" },
      },
    );
    expect(evaluate(observation)).toMatchObject({ params: {} });
  });

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

function sleepContext({ phase = "night" as DayPhase, tiredness = 0.5, nocturnal = 0 } = {}) {
  const emitted: unknown[] = [];
  const homes: string[] = [];
  let walked = 0;
  const context = {
    tick: 0,
    tickSeconds: 0.1,
    position: { regionId: "r", x: 0, z: 0 },
    dayPhase: phase,
    needs: { [TIREDNESS]: tiredness, [HUNGER]: 0.2 },
    traits: { [NOCTURNAL]: nocturnal },
    place: (id: string) =>
      id === "tree"
        ? { id, x: 2, y: 0, z: 0, blockRadius: 0.35, affordances: { [SHELTER]: {} } }
        : id === "rock"
          ? { id, x: 2, y: 0, z: 0, blockRadius: 0.5, affordances: {} }
          : undefined,
    spotAt: () => ({ regionId: "r", x: 1.2, z: 0 }),
    planRoute: () => ({
      ok: true as const,
      route: {
        legs: [
          {
            regionId: "r",
            points: [
              { x: 0, z: 0 },
              { x: 1.2, z: 0 },
            ],
          },
        ],
        length: 1.2,
      },
    }),
    walk: () => {
      walked++;
      return "arrived" as const;
    },
    adjustNeed: () => {},
    face: () => {},
    emit: (event: unknown) => emitted.push(event),
    home: null as string | null,
    setHome: (id: string) => homes.push(id),
  } satisfies ActionContext;
  return { context, emitted, homes, walked: () => walked };
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

  it("doesn't change an existing home", () => {
    const { context, homes } = sleepContext();
    context.home = "elsewhere";
    const start = sleepAction.start({ placementId: "tree" }, context);
    if (!start.ok) throw new Error("start failed");
    sleepAction.step(start.state, context);
    sleepAction.step(start.state, context);
    expect(homes).toEqual([]);
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
});

// ---- In the simulation -----------------------------------------------------------------------

describe("sleeping in Woodland Hollow", () => {
  function setup(seed: number, startMinutes: number, tickRateHz = 10) {
    const traces: DecisionTrace[] = [];
    const simulation = createSimulation({
      register: registerBuiltInContent,
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
    const spawn = (options?: { released?: boolean }): CreatureState => {
      const spawned = simulation.spawn("hollow:mossling", "meadow", options);
      if (!spawned.ok) throw new Error("spawn failed");
      return spawned.value;
    };
    const of = (creature: CreatureState, type: SimulationEvent["type"]) =>
      events.filter((e) => e.type === type && "creatureId" in e && e.creatureId === creature.id);
    return { simulation, traces, events, run, spawn, of };
  }
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

  it("knowing no shelter, sleeps where it stands", () => {
    const { run, spawn, of } = setup(2, 21 * 60);
    const creature = spawn();
    // No vision: it learns only by touch, and the meadow spawn is no shelter.
    creature.variation.senses["core:vision"] = 0;
    creature.needs[HUNGER] = 0;
    const { x, z } = creature.position;
    run(20);
    expect(creature.asleep).toBe(true);
    expect(of(creature, "fell_asleep")).toEqual([expect.objectContaining({ placementId: null })]);
    expect(creature.position).toMatchObject({ x, z });
    expect(creature.home).toBeNull();
  });

  it("asleep, hunger rises at a tenth of its rate and tiredness falls", () => {
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
    expect(creature.needs[HUNGER]! - hunger).toBeCloseTo((h * 1) / 15, 6);
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

  it("repeats the same nights for the same seed", () => {
    const night = (seed: number) => {
      const { simulation, events, run } = setup(seed, 17 * 60, 2);
      for (let k = 0; k < 3; k++) simulation.spawn("hollow:mossling");
      run(14 * 7_200);
      const sleep = events.filter(
        (e) => e.type === "fell_asleep" || e.type === "woke_up" || e.type === "new_home_selected",
      );
      return {
        sleep,
        states: [...simulation.state.creatures.values()].map((c) => JSON.stringify(c)),
      };
    };
    const first = night(7);
    expect(first.sleep.length).toBeGreaterThan(3);
    expect(night(7)).toEqual(first);
    expect(night(8).sleep).not.toEqual(first.sleep);
  });
});
