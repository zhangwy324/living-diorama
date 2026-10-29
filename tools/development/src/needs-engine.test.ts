import { registerBuiltInContent } from "@living-diorama/built-in-content";
import type { NeedType, Registries, TraitType } from "@living-diorama/extension-api";
import {
  DAY_SHIFT_MINUTES,
  followPathAction,
  INTERRUPT_MARGIN,
  PHASE_REACTION_SECONDS,
  Rng,
  type ActionProvider,
  type BehaviorProvider,
  type CreatureObservation,
  type DecisionTrace,
  type PathState,
  type Proposal,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { pebble, registerRiverCrossing } from "./index";
import { createSimulation } from "./simulation-run";

// The needs engine (ADR 0018 §1, §7, §8, §15, §16, §18 and amendments), exercised with a test
// pack: needs with simple rates, a rate trait, and behaviors and actions that play scripts.

/** At 10 Hz, 36 per hour is 0.001 per tick. */
const hunger: NeedType = {
  id: "test:hunger",
  version: "1.0.0",
  perHour: { awake: 36, asleep: 3.6 },
  actAt: 0.5,
  triggers: [0.5, 0.9, 1],
  cue: { cue: "hungry", from: 0.8 },
  atMax: { speedFactor: 0.5 },
  rateTrait: "test:appetite",
};
const tiredness: NeedType = {
  id: "test:tiredness",
  version: "1.0.0",
  perHour: { awake: 36, asleep: -72 },
  actAt: 0.9,
  triggers: [0.9],
  variation: 0.15,
};
/** Defaults to 2, so a species that leaves it out has hunger rising at twice the base rate. */
const appetite: TraitType = { id: "test:appetite", version: "1.0.0", default: 2, min: 0.5, max: 4 };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Changes `params.need` by `params.delta` every tick for `params.ticks`, showing "eating". */
const eat: ActionProvider = {
  id: "test:eat",
  version: "1.0.0",
  cue: "eating",
  start: (params) => ({ ok: true, state: { ...(isRecord(params) ? params : {}) } }),
  step(state, context) {
    const s = state as { need: string; delta: number; ticks: number };
    context.adjustNeed(s.need, s.delta);
    s.ticks--;
    return { status: s.ticks > 0 ? "running" : "done", cue: "eating" };
  },
};
/** Sleeps for good. */
const nap: ActionProvider = {
  id: "test:nap",
  version: "1.0.0",
  cue: "sleeping",
  start: () => ({ ok: true, state: {} }),
  step: () => ({ status: "running", asleep: true, cue: "sleeping" }),
};
/** Stands still for good, reporting a cue its type doesn't declare. */
const still: ActionProvider = {
  id: "test:still",
  version: "1.0.0",
  start: () => ({ ok: true, state: {} }),
  step: () => ({ status: "running", cue: "sleeping" }),
};
/** Walks to the south bank, then stands there; reports "eating" all along. */
const walkThenEat: ActionProvider = {
  id: "test:walk-then-eat",
  version: "1.0.0",
  cue: "eating",
  start: (_params, context) =>
    followPathAction.start({ destination: { regionId: "south-bank", x: 1.5, z: 2.2 } }, context),
  step(state, context) {
    const path = state as PathState;
    if (path.next < path.points.length) context.walk(path);
    return { status: "running", cue: "eating" };
  },
};
/** Stands still for good, showing "eating" with `params.progress` as its progress. */
const meter: ActionProvider = {
  id: "test:meter",
  version: "1.0.0",
  cue: "eating",
  start: (params) => ({ ok: true, state: isRecord(params) ? params.progress : undefined }),
  step: (state) => ({ status: "running", cue: "eating", cueProgress: state as number }),
};
/** Stands still for good, naming `params.target`, if any, as the placement it goes to. */
const aim: ActionProvider = {
  id: "test:aim",
  version: "1.0.0",
  start: (params) => ({ ok: true, state: isRecord(params) ? params.target : undefined }),
  step: () => ({ status: "running" }),
  target: (state) => state as string | undefined,
};
const testActions = [eat, nap, still, walkThenEat, meter, aim];

const behavior = (
  id: string,
  evaluate: BehaviorProvider["evaluate"],
  needs: string[] = ["test:hunger", "test:tiredness"],
): BehaviorProvider => ({
  id,
  version: "1.0.0",
  dependencies: [
    ...["core:idle", "core:follow_path", ...testActions.map((a) => a.id)].map((a) => ({
      registry: "actions" as const,
      id: a,
    })),
    ...needs.map((n) => ({ registry: "needs" as const, id: n })),
  ],
  evaluate,
});

/** Always proposes `proposal`. */
const always = (id: string, proposal: Proposal | null, needs?: string[]) =>
  behavior(id, () => proposal && { ...proposal }, needs);

const idleLong: Proposal = { action: "core:idle", params: { seconds: 10_000 }, utility: 0.3 };

interface Setup {
  behaviors: BehaviorProvider[];
  traits?: Record<string, number>;
  startMinutes?: number;
  seed?: number;
}

function setup({ behaviors, traits = {}, startMinutes, seed = 1 }: Setup) {
  const traces: DecisionTrace[] = [];
  const simulation = createSimulation({
    worldId: "fixture:river-crossing",
    seed,
    ...(startMinutes === undefined ? {} : { startMinutes }),
    register: (r: Registries) => {
      registerRiverCrossing(r);
      r.traits.register(appetite);
      r.needs.register(hunger);
      r.needs.register(tiredness);
      for (const a of testActions) r.actions.register(a);
      for (const b of behaviors) r.behaviors.register(b);
      r.species.register({
        ...pebble,
        id: "fixture:needy",
        behaviors: behaviors.map((b) => b.id),
        traits,
      });
    },
    onTrace: (t) => traces.push(t),
  });
  const events: SimulationEvent[] = [];
  const run = (ticks: number) => {
    for (let t = 0; t < ticks; t++) events.push(...simulation.step());
  };
  const spawn = (speciesId = "fixture:needy") => {
    const spawned = simulation.spawn(speciesId, "north-meadow");
    if (!spawned.ok) throw new Error("spawn failed");
    return spawned.value;
  };
  return { simulation, traces, events, run, spawn };
}

describe("spawning", () => {
  it("gives a creature the needs its behaviors depend on, below their actAt", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { spawn } = setup({ behaviors: [always("test:a", idleLong)], seed });
      const creature = spawn();
      expect(Object.keys(creature.needs)).toEqual(["test:hunger", "test:tiredness"]);
      expect(creature.needs["test:hunger"]).toBeLessThan(0.5);
      expect(creature.needs["test:tiredness"]).toBeLessThan(0.9);
      // Only needs that declare variation get a factor.
      expect(Object.keys(creature.variation.needs)).toEqual(["test:tiredness"]);
      expect(creature.variation.needs["test:tiredness"]).toBeGreaterThanOrEqual(0.85);
      expect(creature.variation.needs["test:tiredness"]).toBeLessThan(1.15);
      expect(creature.knowledge).toEqual({ places: {}, recentCells: [] });
      expect(creature.home).toBeNull();
    }
  });

  it("starts a need below its startBelow where it declares one: mosslings start rested", () => {
    const simulation = createSimulation({
      register: registerBuiltInContent,
      worldId: "hollow:woodland-hollow",
      seed: 1,
    });
    for (let n = 0; n < 20; n++) {
      const spawned = simulation.spawn("hollow:mossling");
      if (!spawned.ok) throw new Error("spawn failed");
      expect(spawned.value.needs["core:hunger"]).toBeLessThan(0.4);
      expect(spawned.value.needs["core:tiredness"]).toBeLessThan(0.1);
    }
  });

  it("only takes needs a behavior declares, and none for a creature that only wanders", () => {
    const { spawn } = setup({ behaviors: [always("test:a", idleLong, ["test:hunger"])] });
    expect(Object.keys(spawn().needs)).toEqual(["test:hunger"]);
    expect(spawn("fixture:pebble").needs).toEqual({});
  });

  it("varies a mossling's vision and shows it to its behaviors", () => {
    let seen: CreatureObservation | undefined;
    const simulation = createSimulation({
      worldId: "hollow:woodland-hollow",
      seed: 3,
      register: (r: Registries) => {
        registerBuiltInContent(r);
        for (const a of testActions) r.actions.register(a);
        r.behaviors.register(
          behavior(
            "test:observer",
            (observation) => {
              seen = observation;
              return idleLong;
            },
            [],
          ),
        );
        r.species.register({
          ...r.species.get("hollow:mossling")!,
          id: "test:observant-mossling",
          behaviors: ["test:observer"],
        });
      },
    });
    const mossling = simulation.spawn("hollow:mossling");
    // The mossling feeds (PR 4a) and rests (PR 5a), so it has hunger and tiredness; the observer
    // depends on no need.
    expect(Object.keys(mossling.ok ? mossling.value.needs : {})).toEqual([
      "core:hunger",
      "core:tiredness",
    ]);
    const spawned = simulation.spawn("test:observant-mossling");
    if (!spawned.ok) throw new Error("spawn failed");
    const factor = spawned.value.variation.senses["core:vision"]!;
    expect(factor).toBeGreaterThanOrEqual(0.85);
    expect(factor).toBeLessThan(1.15);
    simulation.step();
    expect(seen).toMatchObject({
      dayPhase: "day",
      needs: {},
      traits: { "core:nocturnal": 0, "core:appetite": 1 },
      senses: { "core:vision": 8 * factor },
      home: null,
    });
  });
});

describe("need rates", () => {
  it("rises awake at the rate scaled by the rate trait's default and the variation", () => {
    const { spawn, run } = setup({ behaviors: [always("test:a", idleLong)] });
    const creature = spawn();
    run(1);
    creature.needs["test:hunger"] = 0.1;
    creature.needs["test:tiredness"] = 0.1;
    run(100);
    // Appetite defaults to 2: 2 × 0.001 per tick.
    expect(creature.needs["test:hunger"]).toBeCloseTo(0.1 + 100 * 0.002, 9);
    const factor = creature.variation.needs["test:tiredness"]!;
    expect(creature.needs["test:tiredness"]).toBeCloseTo(0.1 + 100 * 0.001 * factor, 9);
  });

  it("takes the species' trait value over the default", () => {
    const { spawn, run } = setup({
      behaviors: [always("test:a", idleLong)],
      traits: { "test:appetite": 0.5 },
    });
    const creature = spawn();
    run(1);
    creature.needs["test:hunger"] = 0.1;
    run(100);
    expect(creature.needs["test:hunger"]).toBeCloseTo(0.1 + 100 * 0.0005, 9);
  });

  it("uses the asleep rates while the action reports the creature asleep, within [0, 1]", () => {
    const { spawn, run, simulation } = setup({
      behaviors: [always("test:a", { action: "test:nap", utility: 1 })],
    });
    const creature = spawn();
    run(1);
    creature.needs["test:hunger"] = 0.1;
    creature.needs["test:tiredness"] = 0.05;
    run(10);
    expect(creature.asleep).toBe(true);
    expect(creature.needs["test:hunger"]).toBeCloseTo(0.1 + 10 * 0.0002, 9);
    const factor = creature.variation.needs["test:tiredness"]!;
    expect(creature.needs["test:tiredness"]).toBeCloseTo(0.05 - 10 * 0.002 * factor, 9);
    run(100);
    expect(creature.needs["test:tiredness"]).toBe(0);
    expect(simulation.snapshot().creatures[0]!.cues).toEqual(["sleeping"]);
  });
});

describe("triggers", () => {
  it("evaluates when a need rises across a trigger value, including 1", () => {
    // A second behavior, so that there is someone to evaluate while the first one's action runs.
    const { spawn, run, traces } = setup({
      behaviors: [always("test:a", idleLong), always("test:watcher", null)],
    });
    const creature = spawn();
    run(1);
    const needTriggers = () => traces.filter((t) => t.triggers.some((x) => x.kind === "need"));
    creature.needs["test:tiredness"] = 0;
    creature.needs["test:hunger"] = 0.49;
    run(10);
    creature.needs["test:hunger"] = 0.89;
    run(10);
    creature.needs["test:hunger"] = 0.999;
    run(10);
    // Clamped at 1, it rises across nothing more.
    run(100);
    expect(needTriggers().map((t) => [t.triggers, t.result])).toEqual([
      [[{ kind: "need", need: "test:hunger", threshold: 0.5 }], "kept"],
      [[{ kind: "need", need: "test:hunger", threshold: 0.9 }], "kept"],
      [[{ kind: "need", need: "test:hunger", threshold: 1 }], "kept"],
    ]);
    expect(needTriggers()[2]!.needs["test:hunger"]).toBe(1);
    expect(creature.action?.id).toBe("core:idle");
  });

  it("reacts to a day-phase change after a deterministic delay of up to 30 s per creature", () => {
    const reactions = () => {
      const { simulation, spawn, run, traces } = setup({
        behaviors: [always("test:a", idleLong), always("test:watcher", null)],
      });
      for (let n = 0; n < 6; n++) spawn();
      spawn("fixture:pebble");
      run(1);
      // No need triggers in the way.
      for (const c of simulation.state.creatures.values()) {
        for (const id of Object.keys(c.needs)) c.needs[id] = 0;
      }
      // Late enough that every creature's own dusk has begun, however its day is moved (#85).
      simulation.setTimeOfDay(18 * 60 + DAY_SHIFT_MINUTES);
      run(PHASE_REACTION_SECONDS * 10 + 1);
      return traces
        .filter((t) => t.triggers.some((x) => x.kind === "day_phase"))
        .map((t) => [t.creatureId, t.tick] as const);
    };
    const first = reactions();
    // Each needy creature once; the pebble has no other behavior to consider.
    expect(first.map(([id]) => id).sort()).toEqual(
      ["creature-1", "creature-2", "creature-3", "creature-4", "creature-5", "creature-6"].sort(),
    );
    for (const [, tick] of first) {
      expect(tick).toBeGreaterThanOrEqual(1);
      expect(tick).toBeLessThanOrEqual(1 + PHASE_REACTION_SECONDS * 10);
    }
    expect(new Set(first.map(([, tick]) => tick)).size).toBeGreaterThan(1);
    expect(reactions()).toEqual(first);
  });

  it("records every trigger of a tick in one evaluation", () => {
    const { spawn, run, traces } = setup({
      behaviors: [always("test:a", idleLong), always("test:watcher", null)],
    });
    const creature = spawn();
    run(1);
    creature.needs["test:hunger"] = 0.4999;
    creature.needs["test:tiredness"] = 0.8999;
    // Both rise across a trigger value on the same tick.
    run(1);
    creature.needs["test:hunger"] = 0.4999;
    creature.needs["test:tiredness"] = 0;
    run(1);
    expect(traces.filter((t) => t.triggers.length > 0).map((t) => t.triggers)).toEqual([
      [
        { kind: "need", need: "test:hunger", threshold: 0.5 },
        { kind: "need", need: "test:tiredness", threshold: 0.9 },
      ],
      [{ kind: "need", need: "test:hunger", threshold: 0.5 }],
    ]);
  });
});

describe("interruption", () => {
  /** The owner idles with utility `bar`; the challenger eats with 0.5 once hungry. */
  function contest(bar: number | null) {
    const owner = behavior("test:owner", (observation) =>
      observation.action
        ? bar === null
          ? null
          : { ...idleLong, utility: bar, reason: "still resting" }
        : idleLong,
    );
    const challenger = behavior("test:challenger", (observation) =>
      (observation.needs["test:hunger"] ?? 0) >= 0.5
        ? {
            action: "test:eat",
            params: { need: "test:hunger", delta: -0.01, ticks: 10 },
            utility: 0.5,
            reason: "hungry",
          }
        : null,
    );
    const s = setup({ behaviors: [owner, challenger] });
    const creature = s.spawn();
    s.run(1);
    creature.needs["test:tiredness"] = 0;
    creature.needs["test:hunger"] = 0.495;
    s.run(5);
    const trace = s.traces.find((t) => t.triggers.some((x) => x.kind === "need"))!;
    return { ...s, creature, trace };
  }

  it.each([
    [0.36, "kept"],
    [0.35, "started"],
    [0.2, "started"],
    [null, "started"],
  ] as const)("against a bar of %s, a challenger at 0.5 is %s", (bar, result) => {
    const { creature, trace } = contest(bar);
    expect(trace).toMatchObject({
      result,
      running: { action: "core:idle", behavior: "test:owner", utility: bar ?? 0 },
    });
    expect(0.5 - (bar ?? 0) >= INTERRUPT_MARGIN - 1e-9).toBe(result === "started");
    if (result === "started") {
      expect(trace.chosen).toMatchObject({ behavior: "test:challenger", action: "test:eat" });
      expect(trace.candidates.map((c) => c.proposal?.reason ?? null)).toEqual([
        bar === null ? null : "still resting",
        "hungry",
      ]);
      expect(creature.action).toMatchObject({ id: "test:eat", behavior: "test:challenger" });
      expect(creature.lastResult).toEqual({
        action: "core:idle",
        outcome: "interrupted",
        reason: "outranked",
      });
    } else {
      expect(creature.action).toMatchObject({ id: "core:idle", behavior: "test:owner" });
    }
  });

  it("never lets the running behavior interrupt itself", () => {
    const owner = behavior("test:owner", (observation) =>
      observation.action ? { action: "test:nap", utility: 10 } : idleLong,
    );
    const { spawn, run, traces } = setup({ behaviors: [owner, always("test:watcher", null)] });
    const creature = spawn();
    run(1);
    creature.needs["test:tiredness"] = 0;
    creature.needs["test:hunger"] = 0.495;
    run(5);
    expect(traces.at(-1)).toMatchObject({ result: "kept", running: { utility: 10 } });
    expect(creature.action?.id).toBe("core:idle");
  });

  it("keeps only the chosen behavior's memory and random-stream use", () => {
    const counting = (id: string, utility: (o: CreatureObservation) => number | null) =>
      behavior(id, (observation, memory, rng) => {
        memory.calls = (typeof memory.calls === "number" ? memory.calls : 0) + 1;
        memory.roll = rng.next();
        const u = utility(observation);
        return u === null ? null : { ...idleLong, utility: u };
      });
    const owner = counting("test:owner", (o) => (o.action ? 0.3 : 0.3));
    const low = counting("test:low", (o) => (o.action ? 0.2 : null));
    const { spawn, run, traces } = setup({ behaviors: [owner, low] });
    const creature = spawn();
    run(1);
    const rng = structuredClone(creature.rng);
    const memory = structuredClone(creature.memory);
    // With no action running, only the chosen behavior's memory was kept.
    expect(memory).toEqual({ "test:owner": { calls: 1, roll: expect.any(Number) } });
    creature.needs["test:tiredness"] = 0;
    creature.needs["test:hunger"] = 0.495;
    run(5);
    expect(traces.at(-1)!.result).toBe("kept");
    // Nothing was chosen: memory is untouched and the stream moved on by exactly one draw.
    new Rng(rng).nextUint32();
    expect(creature.rng).toEqual(rng);
    expect(creature.memory).toEqual(memory);
  });

  it("leaves the running action alone when a winning challenger can't start", () => {
    const challenger = behavior("test:challenger", (observation) =>
      observation.action ? { action: "test:nothing", utility: 1, reason: "eager" } : null,
    );
    const { spawn, run, traces } = setup({
      behaviors: [always("test:owner", idleLong), challenger],
    });
    const creature = spawn();
    run(1);
    creature.needs["test:tiredness"] = 0;
    creature.needs["test:hunger"] = 0.495;
    run(5);
    expect(traces.at(-1)).toMatchObject({
      result: "rejected",
      reason: "unknown_action",
      chosen: { behavior: "test:challenger", action: "test:nothing" },
    });
    expect(creature.action).toMatchObject({ id: "core:idle", behavior: "test:owner" });
    // The challenger's behavior learns that its proposal failed (PR 4a).
    expect(creature.lastResult).toEqual({
      action: "test:nothing",
      outcome: "failed",
      reason: "unknown_action",
    });
  });
});

describe("decisions with no action running", () => {
  it("evaluates on scratch memory and keeps only the chosen behavior's", () => {
    const writing = (id: string, utility: number) =>
      behavior(id, (_observation, memory) => {
        memory.wrote = id;
        return { ...idleLong, utility };
      });
    const { spawn, run, traces } = setup({
      behaviors: [writing("test:low", 0.2), writing("test:high", 0.4)],
    });
    const creature = spawn();
    run(1);
    expect(traces[0]!.chosen?.behavior).toBe("test:high");
    expect(creature.memory).toEqual({ "test:high": { wrote: "test:high" } });
  });

  it("moves the random stream on when nothing is proposed, so retries draw anew", () => {
    const rolls: number[] = [];
    const shy = behavior("test:shy", (_observation, _memory, rng) => {
      const roll = rng.next();
      rolls.push(roll);
      return roll < 0.8 ? null : idleLong;
    });
    const { spawn, run, traces } = setup({ behaviors: [shy] });
    spawn();
    // A retry every second.
    for (let t = 0; t < 1_000 && !traces.some((x) => x.result === "started"); t++) run(1);
    expect(traces.some((t) => t.result === "started")).toBe(true);
    expect(new Set(rolls).size).toBe(rolls.length);
  });
});

describe("actions and needs", () => {
  it("watches for being stuck only on ticks the action walks", () => {
    const { spawn, run, events } = setup({
      behaviors: [always("test:a", { action: "test:still", utility: 1 })],
    });
    const creature = spawn();
    run(200);
    expect(events.filter((e) => e.type === "creature_stuck")).toEqual([]);
    expect(creature.action?.id).toBe("test:still");
  });

  it("applies adjustNeed at once, clamped, and ignores needs the creature lacks", () => {
    const eating = (need: string, delta: number): Proposal => ({
      action: "test:eat",
      params: { need, delta, ticks: 1000 },
      utility: 1,
    });
    const down = setup({ behaviors: [always("test:a", eating("test:hunger", -5))] });
    const a = down.spawn();
    down.run(2);
    // Clamped to 0 by the action, then risen by one tick awake.
    expect(a.needs["test:hunger"]).toBeCloseTo(0.002, 9);

    const up = setup({ behaviors: [always("test:a", eating("test:hunger", 5))] });
    const b = up.spawn();
    up.run(2);
    expect(b.needs["test:hunger"]).toBe(1);

    const other = setup({ behaviors: [always("test:a", eating("test:unknown", 1))] });
    const c = other.spawn();
    other.run(2);
    expect(Object.keys(c.needs)).toEqual(["test:hunger", "test:tiredness"]);
  });

  it("walks at the need's speed factor while that need is at 1", () => {
    const fastest = (hungerValue: number) => {
      const { spawn, run } = setup({
        behaviors: [
          always("test:a", {
            action: "core:follow_path",
            params: { destination: { regionId: "south-bank", x: 1.5, z: 2.2 } },
            utility: 1,
          }),
        ],
      });
      const creature = spawn();
      run(1);
      let max = 0;
      for (let t = 0; t < 20; t++) {
        creature.needs["test:hunger"] = hungerValue;
        const { x, z } = creature.position;
        run(1);
        max = Math.max(max, Math.hypot(creature.position.x - x, creature.position.z - z));
      }
      return max;
    };
    expect(fastest(0.99)).toBeCloseTo(0.06, 9);
    expect(fastest(1)).toBeCloseTo(0.03, 9);
  });
});

describe("cues", () => {
  const cuesAfter = (proposal: Proposal, ticks: number, hungerValue?: number) => {
    const { spawn, run, simulation } = setup({ behaviors: [always("test:a", proposal)] });
    const creature = spawn();
    run(1);
    const seen: string[][] = [];
    for (let t = 0; t < ticks; t++) {
      if (hungerValue !== undefined) creature.needs["test:hunger"] = hungerValue;
      else creature.needs["test:hunger"] = 0;
      run(1);
      seen.push(simulation.snapshot().creatures[0]!.cues);
    }
    return seen;
  };

  it("shows an action's declared cue while it runs and doesn't walk", () => {
    const eating = { action: "test:eat", params: { need: "x", delta: 0, ticks: 5 }, utility: 1 };
    expect(cuesAfter(eating, 3)).toEqual([["eating"], ["eating"], ["eating"]]);
  });

  it("doesn't show a cue the action's type doesn't declare", () => {
    expect(cuesAfter({ action: "test:still", utility: 1 }, 2)).toEqual([[], []]);
  });

  it("hides an action's cue while it walks", () => {
    const seen = cuesAfter({ action: "test:walk-then-eat", utility: 1 }, 400);
    expect(seen[0]).toEqual([]);
    expect(seen.at(-1)).toEqual(["eating"]);
  });

  it("shows a need's cue from the value it declares, after the action's", () => {
    const eating = { action: "test:eat", params: { need: "x", delta: 0, ticks: 5 }, utility: 1 };
    expect(cuesAfter(eating, 1, 0.79)).toEqual([["eating"]]);
    expect(cuesAfter(eating, 1, 0.8)).toEqual([["eating", "hungry"]]);
  });

  it("passes an action's progress with its cue, within 0–1, and none that isn't a number", () => {
    const progressAfter = (progress: number | undefined) => {
      const { spawn, run, simulation } = setup({
        behaviors: [always("test:a", { action: "test:meter", params: { progress }, utility: 1 })],
      });
      spawn();
      run(2);
      return simulation.snapshot().creatures[0]!;
    };
    expect(progressAfter(0.25)).toMatchObject({ cues: ["eating"], cueProgress: 0.25 });
    expect(progressAfter(1.5).cueProgress).toBe(1);
    expect(progressAfter(-1).cueProgress).toBe(0);
    expect(progressAfter(Number.NaN)).not.toHaveProperty("cueProgress");
    expect(progressAfter(undefined)).not.toHaveProperty("cueProgress");
  });

  it("shows no progress with an action that doesn't report it", () => {
    const eating = { action: "test:eat", params: { need: "x", delta: 0, ticks: 5 }, utility: 1 };
    const { spawn, run, simulation } = setup({ behaviors: [always("test:a", eating)] });
    spawn();
    run(2);
    expect(simulation.snapshot().creatures[0]).not.toHaveProperty("cueProgress");
  });

  it("names the action's target with the cue of a need its behavior acts on (#110)", () => {
    const targetAfter = (hungerValue: number, needs: string[], target?: string) => {
      const aiming = { action: "test:aim", params: { target }, utility: 1 };
      const { spawn, run, simulation } = setup({
        // The second behavior gives the creature hunger, whatever the first depends on.
        behaviors: [always("test:a", aiming, needs), always("test:b", null)],
      });
      const creature = spawn();
      run(1);
      creature.needs["test:hunger"] = hungerValue;
      return simulation.snapshot().creatures[0]!;
    };
    expect(targetAfter(0.8, ["test:hunger"], "p1")).toMatchObject({
      cues: ["hungry"],
      cueTarget: "p1",
    });
    // No need cue showing: no target, and none again once hunger falls.
    expect(targetAfter(0.79, ["test:hunger"], "p1")).not.toHaveProperty("cueTarget");
    // The choosing behavior doesn't act on hunger, e.g. going home to sleep while hungry.
    expect(targetAfter(0.9, ["test:tiredness"], "p1")).not.toHaveProperty("cueTarget");
    // An action with no target.
    expect(targetAfter(0.9, ["test:hunger"])).not.toHaveProperty("cueTarget");
  });

  it("gives a creature that only wanders no cues and adds debug fields only on request", () => {
    const { spawn, run, simulation } = setup({ behaviors: [always("test:a", idleLong)] });
    spawn("fixture:pebble");
    run(50);
    const [plain] = simulation.snapshot().creatures;
    expect(plain!.cues).toEqual([]);
    expect(plain).not.toHaveProperty("needs");
    expect(plain).not.toHaveProperty("knowledge");
    expect(plain).not.toHaveProperty("home");
    expect(simulation.snapshot({ debug: true }).creatures[0]).toMatchObject({
      needs: {},
      // Perception has noted the cell it stands in; the fixture has no places to remember.
      knowledge: { places: {}, recentCells: [{ x: expect.any(Number), z: expect.any(Number) }] },
      home: null,
    });
  });
});

it("repeats the same run, needs and decisions included, and keeps state plain data", () => {
  const randomly = (id: string) =>
    behavior(id, (observation, _memory, rng) => {
      const hungry = observation.needs["test:hunger"] ?? 0;
      return rng.chance(0.5)
        ? {
            action: "test:eat",
            params: { need: "test:hunger", delta: -0.02, ticks: 30 },
            utility: hungry + 0.2,
          }
        : { action: "core:idle", params: { seconds: rng.range(1, 5) }, utility: rng.next() };
    });
  const once = () => {
    const { spawn, run, simulation, traces } = setup({
      behaviors: [randomly("test:a"), randomly("test:b")],
      startMinutes: 17 * 60 + 55,
    });
    spawn();
    spawn();
    const lines: string[] = [];
    for (let t = 0; t < 6_000; t++) {
      simulation.setTimeOfDay(17 * 60 + 55 + t / 600);
      run(1);
      for (const c of simulation.state.creatures.values()) {
        lines.push(`${c.position.x} ${c.position.z} ${JSON.stringify(c.needs)}`);
      }
    }
    return { lines, traces: JSON.stringify(traces), simulation };
  };
  const first = once();
  const second = once();
  expect(second.lines).toEqual(first.lines);
  expect(second.traces).toEqual(first.traces);
  expect(first.traces).toContain('"kind":"day_phase"');
  expect(first.traces).toContain('"kind":"need"');
  const creature = first.simulation.state.creatures.get("creature-1")!;
  expect(JSON.parse(JSON.stringify(creature))).toEqual(creature);
});
