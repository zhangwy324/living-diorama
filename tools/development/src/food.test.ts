import { registerBuiltInContent } from "@living-diorama/built-in-content";
import type { AffordanceType, Registries } from "@living-diorama/extension-api";
import {
  CellState,
  chooseNearestByRoute,
  eatAction,
  emptyKnowledge,
  FEED_BASE_UTILITY,
  feedBehavior,
  findSpot,
  MEAL,
  perceive,
  RegionMask,
  perceptionOffset,
  rememberPlace,
  Rng,
  SPOT_GAP,
  SPOT_SEARCH_RADIUS,
  type ActionContext,
  type BehaviorProvider,
  type CreatureKnowledge,
  type CreatureObservation,
  type DecisionTrace,
  type PlaceView,
  type PropModel,
  type RegionModel,
  type SimulationEvent,
  type WorldQueries,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { pebble, registerRiverCrossing, riverCrossingWorld } from "./index";
import { createSimulation } from "./simulation-run";

// Food (ADR 0018 §10–§12, §18 and amendments, PR 4a): perception, `core:feed` and `core:eat`.

const hollow = {
  register: registerBuiltInContent,
  worldId: "hollow:woodland-hollow",
};
const FOOD = "core:food";
const HUNGER = "core:hunger";

// ---- Perception ------------------------------------------------------------------------------

const prop = (id: string, x: number, z: number, blockRadius = 0): PropModel => ({
  id,
  prop: "test:thing",
  model: "test:model",
  transform: { position: { x, y: 0, z }, rotationY: 0, scale: 1 },
  blockRadius,
  affordances: { [FOOD]: { eatSeconds: 5 } },
});

const caps: Record<string, number | undefined> = { [FOOD]: 8, "test:uncapped": undefined };
const affordance = (id: string) =>
  ({ id, version: "1.0.0", remember: caps[id] }) as unknown as AffordanceType;

function scan(
  knowledge: CreatureKnowledge,
  props: PropModel[],
  { x = 0, z = 0, vision = 8, blind = false, tick = 0, id = FOOD } = {},
) {
  perceive({
    knowledge,
    x,
    z,
    vision: blind ? undefined : vision,
    tick,
    propsByAffordance: new Map([[id, props]]),
    affordance,
  });
}

const known = (knowledge: CreatureKnowledge, id = FOOD) =>
  (knowledge.places[id] ?? []).map((p) => p.placementId).sort();

describe("perception", () => {
  it("remembers places within vision by straight-line distance, and none beyond", () => {
    const knowledge = emptyKnowledge();
    scan(knowledge, [prop("near", 3, 0), prop("edge", 0, 7.9), prop("far", 8.1, 0)]);
    expect(known(knowledge)).toEqual(["edge", "near"]);
    expect(knowledge.places[FOOD]!.every((p) => p.lastSeenTick === 0)).toBe(true);
  });

  it("keeps the affordance's cap, the nearest in view, and forgets the oldest seen first", () => {
    const knowledge = emptyKnowledge();
    const row = Array.from({ length: 10 }, (_, k) => prop(`a${k + 1}`, k + 1, 0));
    scan(knowledge, row, { vision: 20 });
    expect(known(knowledge)).toEqual(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8"]);
    // Elsewhere, later: three new places push out three of the old ones.
    const there = [prop("b1", 100, 1), prop("b2", 100, 2), prop("b3", 100, 3)];
    scan(knowledge, [...row, ...there], { x: 100, tick: 10 });
    expect(knowledge.places[FOOD]).toHaveLength(8);
    expect(known(knowledge)).toEqual(expect.arrayContaining(["b1", "b2", "b3"]));
    // Seeing a known place again only refreshes it.
    scan(knowledge, there, { x: 100, tick: 20 });
    expect(knowledge.places[FOOD]).toHaveLength(8);
  });

  it("doesn't remember an affordance without a remember cap", () => {
    const knowledge = emptyKnowledge();
    scan(knowledge, [prop("p", 1, 0)], { id: "test:uncapped" });
    expect(knowledge.places).toEqual({});
  });

  it("without vision, learns of a place only within 1 m of its edge", () => {
    const knowledge = emptyKnowledge();
    scan(knowledge, [prop("touched", 1.3, 0, 0.4), prop("missed", 0, 1.5, 0.4)], { blind: true });
    expect(known(knowledge)).toEqual(["touched"]);
  });

  it("records the 8 m grid cell the creature stands in", () => {
    const knowledge = emptyKnowledge();
    scan(knowledge, [], { x: 3, z: -1, tick: 5 });
    scan(knowledge, [], { x: 17, z: 9, tick: 15 });
    expect(knowledge.recentCells).toEqual([
      { x: 0, z: -1, tick: 5 },
      { x: 2, z: 1, tick: 15 },
    ]);
  });

  it("scans each creature once a second, at an offset of its own", () => {
    const offsets = new Set(Array.from({ length: 20 }, (_, k) => perceptionOffset(`c-${k}`, 10)));
    expect(offsets.size).toBeGreaterThanOrEqual(5);
    const simulation = createSimulation({ ...hollow, seed: 1 });
    for (let k = 0; k < 6; k++) simulation.spawn("hollow:mossling");
    for (let t = 0; t < 35; t++) simulation.step();
    for (const creature of simulation.state.creatures.values()) {
      const ticks = creature.knowledge.recentCells.map((c) => c.tick);
      expect((ticks.at(-1)! + perceptionOffset(creature.id, 10)) % 10).toBe(0);
      expect(ticks.at(-1)!).toBeGreaterThanOrEqual(25);
    }
  });

  it("finds a mossling's food by affordance, from the world's index and parsed params", () => {
    const simulation = createSimulation({ ...hollow, seed: 1 });
    const { model } = simulation.state;
    const food = model.propsByAffordance.get(FOOD)!;
    expect(food.length).toBe(34);
    expect(food.every((p) => model.propsById.get(p.id) === p)).toBe(true);
    for (const p of food) {
      expect((p.affordances[FOOD] as { eatSeconds: number }).eatSeconds).toBeGreaterThan(0);
    }
    const mossling = simulation.spawn("hollow:mossling", "meadow");
    if (!mossling.ok) throw new Error("spawn failed");
    const creature = mossling.value;
    for (let t = 0; t < 10; t++) simulation.step();
    const vision = 8 * creature.variation.senses["core:vision"]!;
    const { x, z } = creature.position;
    const inView = food.filter(
      (p) => Math.hypot(p.transform.position.x - x, p.transform.position.z - z) <= vision,
    );
    // It hasn't moved far in one second, so it knows what is in view (within the cap).
    expect(known(creature.knowledge).length).toBe(Math.min(8, inView.length));
  });
});

// ---- core:feed -------------------------------------------------------------------------------

interface Stub {
  places: Record<string, { x: number; z: number }>;
  /** Route length per placement; undefined means no route. */
  routes?: Record<string, number | undefined>;
  points?: { x: number; z: number }[];
  /** Records the reach of each exploration draw. */
  ranges?: number[];
}

/** An observation of a creature at the origin, with a world that answers from `stub`. */
function observe(
  stub: Stub,
  {
    hunger = 0.5,
    knowledge = emptyKnowledge(),
    ...rest
  }: Partial<CreatureObservation> & {
    hunger?: number;
  } = {},
) {
  const pathed: string[] = [];
  let point = 0;
  const world: WorldQueries = {
    place: (id) => {
      const p = stub.places[id];
      return p && { id, ...p, y: 0, blockRadius: 0, affordances: { [FOOD]: { eatSeconds: 5 } } };
    },
    // The spot names its placement in `regionId`, so `routeLength` can answer per placement.
    spotAt: (id) => stub.places[id] && { regionId: id, ...stub.places[id]! },
    routeLength: (destination) => {
      pathed.push(destination.regionId);
      return stub.routes?.[destination.regionId];
    },
    reachableRegions: () => [{ regionId: "r", walkableArea: 100 }],
    randomWalkablePoint: () => undefined,
    randomWalkablePointWithin: (maxDistance) => {
      stub.ranges?.push(maxDistance);
      const p = stub.points?.[point++];
      return p && { regionId: "r", ...p };
    },
  };
  const observation: CreatureObservation = {
    tick: 1000,
    tickSeconds: 0.1,
    creature: { id: "c", speciesId: "s", position: { regionId: "r", x: 0, z: 0 }, heading: 0 },
    dayPhase: "day",
    needs: { [HUNGER]: hunger },
    traits: {},
    senses: {},
    knowledge,
    home: null,
    world,
    ...rest,
  };
  return { observation, pathed };
}

function knowing(...ids: string[]) {
  const knowledge = emptyKnowledge();
  for (const id of ids) rememberPlace(knowledge, FOOD, id, 0, 8);
  return knowledge;
}

describe("core:feed", () => {
  const stub: Stub = {
    places: { a: { x: 1, z: 0 }, b: { x: 0, z: 2 }, c: { x: -3, z: 0 }, d: { x: 0, z: -4 } },
    routes: { a: 50, b: 3, c: 10, d: 1 },
  };

  it("routes only the three nearest by straight line, and takes the shortest route", () => {
    const { observation, pathed } = observe(stub, { knowledge: knowing("d", "c", "b", "a") });
    expect(chooseNearestByRoute(observation, FOOD)).toEqual({ placementId: "b", length: 3 });
    // Only places offering the affordance asked for count.
    expect(chooseNearestByRoute(observation, "core:shelter")).toBeUndefined();
    expect(pathed.sort()).toEqual(["a", "b", "c"]);
  });

  it("proposes eating only from actAt, with 0.2 + hunger", () => {
    const knowledge = knowing("a", "b");
    const evaluate = (hunger: number) =>
      feedBehavior.evaluate(observe(stub, { hunger, knowledge }).observation, {}, Rng.fromSeed(1));
    expect(evaluate(0.39)).toBeNull();
    expect(evaluate(0.4)).toMatchObject({
      action: "core:eat",
      params: { placementId: "b" },
      utility: FEED_BASE_UTILITY + 0.4,
    });
  });

  it("asked to continue its own action, returns its utility even below actAt", () => {
    const { observation } = observe(stub, {
      hunger: 0.05,
      action: { id: "core:eat", behavior: "core:feed", startTick: 990 },
    });
    expect(feedBehavior.evaluate(observation, {}, Rng.fromSeed(1))).toEqual({
      action: "core:eat",
      utility: FEED_BASE_UTILITY + 0.05,
      reason: "continue",
    });
  });

  it("skips food it failed to reach for a while", () => {
    const memory = { target: "b" };
    const { observation } = observe(stub, {
      knowledge: knowing("a", "b", "c"),
      lastResult: { action: "core:eat", outcome: "interrupted", reason: "stuck" },
    });
    expect(feedBehavior.evaluate(observation, memory, Rng.fromSeed(1))).toMatchObject({
      params: { placementId: "c" },
    });
    expect(memory).toEqual({ target: "c", avoid: { b: 1000 + 600 } });
  });

  it("knowing no food, explores towards a grid cell not visited recently", () => {
    const knowledge = emptyKnowledge();
    knowledge.recentCells.push({ x: 0, z: 0, tick: 900 }, { x: 1, z: 0, tick: 950 });
    const points = [
      { x: 1, z: 1 }, // too close
      { x: 6, z: 6 }, // cell (0, 0), visited
      { x: 12, z: 2 }, // cell (1, 0), visited
      { x: 3, z: 12 }, // cell (0, 1), not visited
    ];
    const ranges: number[] = [];
    const proposal = feedBehavior.evaluate(
      observe({ places: {}, points, ranges }, { knowledge }).observation,
      {},
      Rng.fromSeed(1),
    );
    // Without vision a leg reaches at most 12 m.
    expect(new Set(ranges)).toEqual(new Set([12]));
    expect(proposal).toMatchObject({
      action: "core:follow_path",
      params: { destination: { regionId: "r", x: 3, z: 12 } },
      utility: FEED_BASE_UTILITY + 0.5,
    });
    // With every candidate visited, the cell visited longest ago wins.
    const visited = feedBehavior.evaluate(
      observe({ places: {}, points: points.slice(0, 3) }, { knowledge }).observation,
      {},
      Rng.fromSeed(1),
    );
    expect(visited).toMatchObject({ params: { destination: { x: 6, z: 6 } } });
  });

  it("keeps exploration legs within twice the vision range, at least 8 m", () => {
    const reach = (vision: number) => {
      const ranges: number[] = [];
      feedBehavior.evaluate(
        observe(
          { places: {}, points: [{ x: 5, z: 5 }], ranges },
          { senses: { "core:vision": vision } },
        ).observation,
        {},
        Rng.fromSeed(1),
      );
      return ranges[0];
    };
    expect(reach(8)).toBe(16);
    expect(reach(2)).toBe(8);
  });
});

// ---- core:eat --------------------------------------------------------------------------------

function eatContext(walks: ("moving" | "arrived")[], legs: { x: number; z: number }[]) {
  const adjusted: number[] = [];
  const emitted: unknown[] = [];
  let walked = 0;
  const faced: { x: number; z: number }[] = [];
  const needs = { [HUNGER]: 0.9 };
  const context: ActionContext = {
    tick: 0,
    tickSeconds: 0.1,
    position: { regionId: "r", x: 0, z: 0 },
    dayPhase: "day",
    needs,
    traits: {},
    place: (id) =>
      id === "m"
        ? { id, x: 2, y: 0, z: 0, blockRadius: 0, affordances: { [FOOD]: { eatSeconds: 5 } } }
        : id === "rock"
          ? { id, x: 2, y: 0, z: 0, blockRadius: 0.5, affordances: {} }
          : undefined,
    spotAt: () => ({ regionId: "r", x: 1.3, z: 0 }),
    planRoute: () => ({
      ok: true,
      route: { legs: [{ regionId: "r", points: [{ x: 0, z: 0 }, ...legs] }], length: 1.3 },
    }),
    walk: () => {
      walked++;
      return walks.shift() ?? "arrived";
    },
    adjustNeed: (id, delta) => {
      adjusted.push(delta);
      needs[id as typeof HUNGER] = Math.max(0, needs[HUNGER] + delta);
    },
    face: (x, z) => faced.push({ x, z }),
    emit: (event) => emitted.push(event),
    home: null,
    setHome: () => {},
  };
  return { context, adjusted, emitted, walked: () => walked, needs, faced };
}

describe("core:eat", () => {
  it("only starts at a place that offers food", () => {
    const { context } = eatContext([], []);
    expect(eatAction.start({ placementId: "rock" }, context)).toMatchObject({
      ok: false,
      reason: "not_food",
    });
    expect(eatAction.start({ placementId: "nowhere" }, context)).toMatchObject({ ok: false });
    expect(eatAction.start({}, context)).toMatchObject({ ok: false, reason: "invalid_params" });
  });

  it("walks to its spot, stops walking, faces the food and eats 0.8 of hunger over eatSeconds", () => {
    const { context, adjusted, emitted, walked, needs, faced } = eatContext(
      ["moving", "arrived"],
      [{ x: 1.3, z: 0 }],
    );
    const start = eatAction.start({ placementId: "m" }, context);
    if (!start.ok) throw new Error("start failed");
    expect(eatAction.step(start.state, context)).toEqual({ status: "running" });
    expect(eatAction.step(start.state, context)).toEqual({ status: "running" });
    expect(walked()).toBe(2);
    expect(faced).toEqual([]);
    // 5 s at 10 Hz: 50 ticks of eating. Half a meal counts as half.
    // Each tick reports the share of the meal eaten so far, for the eating cue.
    for (let t = 1; t <= 25; t++) {
      const step = eatAction.step(start.state, context);
      expect(step).toMatchObject({ status: "running", cue: "eating" });
      expect(step.cueProgress).toBeCloseTo(t / 50, 9);
    }
    expect(walked()).toBe(2);
    expect(adjusted.reduce((a, b) => a + b, 0)).toBeCloseTo(-MEAL / 2, 9);
    expect(faced.at(-1)).toEqual({ x: 2, z: 0 });
    for (let t = 0; t < 24; t++) eatAction.step(start.state, context);
    expect(eatAction.step(start.state, context)).toEqual({ status: "done", cue: "eating" });
    expect(adjusted).toHaveLength(50);
    expect(adjusted.reduce((a, b) => a + b, 0)).toBeCloseTo(-MEAL, 9);
    expect(emitted).toEqual([{ type: "ate", placementId: "m", hunger: needs[HUNGER] }]);
    expect(needs[HUNGER]).toBeCloseTo(0.1, 9);
  });
});

// ---- Spots -----------------------------------------------------------------------------------

describe("eating spots", () => {
  /** River fixture: the north bank runs to z = -0.6, then the river. */
  function river() {
    const simulation = createSimulation({
      register: registerRiverCrossing,
      worldId: "fixture:river-crossing",
      seed: 1,
    });
    const pathfinder = simulation.state.pathfinderFor("fixture:pebble")!;
    const from = { regionId: "north-bank", x: -2, z: -1.8 };
    const spot = (place: PlaceView, angle: number) =>
      findSpot({
        place,
        radius: 0.2,
        angle,
        masks: pathfinder.navigation.masks,
        reachable: pathfinder.reachableCells(from),
      });
    const place: PlaceView = { id: "p", x: -2, y: 0.5, z: -1.2, blockRadius: 0.1, affordances: {} };
    return { spot, place, masks: pathfinder.navigation.masks };
  }

  it("stands at the creature's own angle, just clear of the place", () => {
    const { spot, place } = river();
    // Angle π faces −Z, away from the river.
    const at = spot(place, Math.PI)!;
    const distance = place.blockRadius + 0.2 + SPOT_GAP;
    expect(at.regionId).toBe("north-bank");
    expect(at.x).toBeCloseTo(place.x, 9);
    expect(at.z).toBeCloseTo(place.z - distance, 9);
    const west = spot(place, -Math.PI / 2)!;
    expect(west.x).toBeCloseTo(place.x - distance, 9);
  });

  it("falls back to the nearest reachable walkable point when its own spot is blocked", () => {
    const { spot, place, masks } = river();
    // Angle 0 faces +Z: 0.6 m on lies in the river, past the bank's edge.
    const at = spot(place, 0)!;
    const preferred = { x: place.x, z: place.z + 0.6 };
    expect(at.regionId).toBe("north-bank");
    expect(masks.get("north-bank")!.isWalkableAt(at.x, at.z)).toBe(true);
    expect(at.z).toBeLessThan(preferred.z);
    expect(Math.hypot(at.x - preferred.x, at.z - preferred.z)).toBeLessThanOrEqual(
      SPOT_SEARCH_RADIUS,
    );
  });

  it("gives creatures their own angles, so they spread out around one place", () => {
    const simulation = createSimulation({ ...hollow, seed: 2 });
    const angles = Array.from({ length: 4 }, () => {
      const spawned = simulation.spawn("hollow:mossling");
      if (!spawned.ok) throw new Error("spawn failed");
      return spawned.value.spotAngle;
    });
    expect(new Set(angles).size).toBe(4);
    for (const a of angles) expect(Math.abs(a)).toBeLessThanOrEqual(Math.PI);
  });

  /** A 10 m × 10 m mask of 0.5 m cells centred on the origin, at one height. */
  function flatMask(id: string, height: number, walkable: (x: number, z: number) => boolean) {
    const n = 20;
    const states = new Uint8Array(n * n);
    const mask = new RegionMask(
      { id } as RegionModel,
      0,
      0,
      n,
      n,
      0.5,
      -5,
      -5,
      states,
      new Float64Array(n * n).fill(height),
    );
    for (let cell = 0; cell < n * n; cell++) {
      const { x, z } = mask.center(cell);
      states[cell] = walkable(x, z) ? CellState.walkable : CellState.outside;
    }
    return mask;
  }
  const spotsIn = (masks: RegionMask[], place: PlaceView, angle: number) =>
    findSpot({
      place,
      radius: 0.2,
      angle,
      masks: new Map(masks.map((m) => [m.region.id, m])),
      reachable: new Map(
        masks.map((m) => [
          m.region.id,
          [...m.states.keys()].filter((c) => m.states[c] === CellState.walkable),
        ]),
      ),
    });
  const at = (x: number, y: number, z: number, blockRadius = 0.1): PlaceView => ({
    id: "p",
    x,
    y,
    z,
    blockRadius,
    affordances: {},
  });

  it("tries the next angles round the place when its own side is blocked", () => {
    // Only the west is walkable, beyond the search radius of the east side.
    const west = flatMask("west", 0, (x) => x < -3);
    // Angle π/2 faces +X: 2.9 m east. Three quarters of a turn on faces west.
    const spot = spotsIn([west], at(0, 0, 0, 2.4), Math.PI / 2)!;
    expect(spot.regionId).toBe("west");
    expect(spot.x).toBeLessThan(-3);
    expect(spotsIn([flatMask("none", 0, () => false)], at(0, 0, 0), 0)).toBeUndefined();
  });

  it("takes only surfaces near the place's height, the nearest where regions overlap", () => {
    const low = flatMask("low", 0, () => true);
    const high = flatMask("high", 2, () => true);
    expect(spotsIn([low, high], at(1, 0, 1), 0)!.regionId).toBe("low");
    expect(spotsIn([low, high], at(1, 2, 1), 0)!.regionId).toBe("high");
    expect(spotsIn([low, high], at(1, 1.6, 1), 0)!.regionId).toBe("high");
    // More than 0.75 m from both: no spot.
    expect(spotsIn([low, high], at(1, 1, 1), 0)).toBeUndefined();
  });
});

// ---- In the simulation -----------------------------------------------------------------------

describe("feeding in Woodland Hollow", () => {
  function setup(seed: number, extra?: (registries: Registries) => void) {
    const traces: DecisionTrace[] = [];
    const simulation = createSimulation({
      ...hollow,
      register: (r: Registries) => {
        registerBuiltInContent(r);
        extra?.(r);
      },
      seed,
      onTrace: (t) => traces.push(t),
    });
    const events: SimulationEvent[] = [];
    const run = (ticks: number) => {
      for (let t = 0; t < ticks; t++) events.push(...simulation.step());
    };
    return { simulation, traces, events, run };
  }

  it("keeps a meal going when a trigger comes, as feed's continue utility beats wander", () => {
    const { simulation, traces, events, run } = setup(3);
    const spawned = simulation.spawn("hollow:mossling", "meadow");
    if (!spawned.ok) throw new Error("spawn failed");
    const creature = spawned.value;
    // It knows the nearest food and is just hungry enough to act.
    const { x, z } = creature.position;
    const nearest = [...simulation.state.model.propsByAffordance.get(FOOD)!].sort(
      (a, b) =>
        Math.hypot(a.transform.position.x - x, a.transform.position.z - z) -
        Math.hypot(b.transform.position.x - x, b.transform.position.z - z),
    )[0]!;
    rememberPlace(creature.knowledge, FOOD, nearest.id, 0, 8);
    creature.needs[HUNGER] = 0.45;
    run(1);
    expect(traces[0]!.chosen).toMatchObject({ behavior: "core:feed", action: "core:eat" });
    // Walk there and start eating.
    for (let t = 0; t < 2_000 && !(creature.action?.state as { arrived: boolean }).arrived; t++) {
      run(1);
    }
    // Eat until hunger is below actAt, where feed alone would no longer propose a meal.
    for (let t = 0; t < 100 && creature.needs[HUNGER]! >= 0.35; t++) run(1);
    const eating = simulation.snapshot().creatures[0]!;
    expect(eating.cues).toEqual(["eating"]);
    // Hunger fell from 0.45 to below 0.35 of the meal's 0.8, so at least an eighth is eaten.
    expect(eating.cueProgress).toBeGreaterThan(0.1);
    expect(eating.cueProgress).toBeLessThan(1);
    expect(creature.needs[HUNGER]).toBeLessThan(0.35);
    // A day-phase reaction now: wander (0.1) can't beat feed's continue utility (0.2 + hunger).
    creature.phaseReactionTick = simulation.tick;
    run(1);
    const trace = traces.at(-1)!;
    expect(trace.result).toBe("kept");
    expect(trace.running).toMatchObject({ action: "core:eat", behavior: "core:feed" });
    expect(trace.running!.utility).toBeGreaterThanOrEqual(FEED_BASE_UTILITY);
    run(200);
    expect(events.filter((e) => e.type === "ate")).toEqual([
      expect.objectContaining({ creatureId: creature.id, placementId: nearest.id }),
    ]);
    expect(creature.needs[HUNGER]).toBeLessThan(0.05);
  });

  it("at hunger 1, feeds before wandering and walks at 80% speed (sanctuary)", () => {
    const { simulation, traces, run } = setup(4);
    const spawned = simulation.spawn("hollow:mossling", "meadow");
    if (!spawned.ok) throw new Error("spawn failed");
    const creature = spawned.value;
    creature.needs[HUNGER] = 1;
    let fastest = 0;
    for (let t = 0; t < 100; t++) {
      const { x, z } = creature.position;
      run(1);
      fastest = Math.max(fastest, Math.hypot(creature.position.x - x, creature.position.z - z));
    }
    const [first] = traces;
    expect(first!.candidates).toEqual([
      { behavior: "core:wander", proposal: expect.objectContaining({ utility: 0.1 }) },
      { behavior: "core:feed", proposal: expect.objectContaining({ utility: 1.2 }) },
      // Not tired, by day: no rest.
      { behavior: "core:rest", proposal: null },
    ]);
    expect(first!.chosen!.behavior).toBe("core:feed");
    // 0.6 m/s × 0.8 × 0.1 s.
    expect(fastest).toBeCloseTo(0.048, 6);
  });

  /** The food props nearest the creature, nearest first. */
  function nearestFood(
    simulation: {
      state: { model: { propsByAffordance: ReadonlyMap<string, readonly PropModel[]> } };
    },
    x: number,
    z: number,
  ) {
    return [...simulation.state.model.propsByAffordance.get(FOOD)!].sort(
      (a, b) =>
        Math.hypot(a.transform.position.x - x, a.transform.position.z - z) -
        Math.hypot(b.transform.position.x - x, b.transform.position.z - z),
    );
  }

  it("counts an interrupted meal in part, without an `ate` event", () => {
    // A test behavior that outranks a meal in progress by far.
    const alarm: BehaviorProvider = {
      id: "test:alarm",
      version: "1.0.0",
      dependencies: [{ registry: "actions", id: "core:idle" }],
      evaluate: (observation) =>
        observation.action?.id === "core:eat"
          ? { action: "core:idle", params: { seconds: 1_000 }, utility: 5 }
          : null,
    };
    const { simulation, events, run } = setup(3, (r) => {
      r.behaviors.register(alarm);
      r.species.register({
        ...r.species.get("hollow:mossling")!,
        id: "test:alarmed-mossling",
        behaviors: ["core:wander", "core:feed", "test:alarm"],
      });
    });
    const spawned = simulation.spawn("test:alarmed-mossling", "meadow");
    if (!spawned.ok) throw new Error("spawn failed");
    const creature = spawned.value;
    const [food] = nearestFood(simulation, creature.position.x, creature.position.z);
    rememberPlace(creature.knowledge, FOOD, food!.id, 0, 8);
    creature.needs[HUNGER] = 0.6;
    run(1);
    for (let t = 0; t < 2_000 && !(creature.action?.state as { arrived: boolean }).arrived; t++) {
      run(1);
    }
    const before = creature.needs[HUNGER]!;
    run(20);
    creature.phaseReactionTick = simulation.tick;
    run(1);
    expect(creature.action?.id).toBe("core:idle");
    expect(creature.lastResult).toEqual({
      action: "core:eat",
      outcome: "interrupted",
      reason: "outranked",
    });
    const eaten = before - creature.needs[HUNGER]!;
    expect(eaten).toBeGreaterThan(0.1);
    expect(eaten).toBeLessThan(MEAL - 0.1);
    run(300);
    expect(events.some((e) => e.type === "ate")).toBe(false);
  });

  it("skips food it got stuck on for 60 s and goes to other food", () => {
    // So slow that walking never makes the watchdog's 5 cm of progress in 5 s.
    const { simulation, traces, run } = setup(3, (r) => {
      r.species.register({
        ...r.species.get("hollow:mossling")!,
        id: "test:sluggish-mossling",
        baseSpeed: 0.001,
      });
    });
    const spawned = simulation.spawn("test:sluggish-mossling", "meadow");
    if (!spawned.ok) throw new Error("spawn failed");
    const creature = spawned.value;
    const [first, second] = nearestFood(simulation, creature.position.x, creature.position.z);
    rememberPlace(creature.knowledge, FOOD, first!.id, 0, 8);
    rememberPlace(creature.knowledge, FOOD, second!.id, 0, 8);
    creature.needs[HUNGER] = 0.5;
    const eats = () =>
      traces.flatMap((t) =>
        t.chosen?.action === "core:eat" && t.result === "started"
          ? [
              {
                tick: t.tick,
                placementId: (t.chosen.params as { placementId: string }).placementId,
              },
            ]
          : [],
      );
    for (let t = 0; t < 200 && eats().length < 2; t++) run(1);
    const [stuckOn, then] = eats();
    expect(stuckOn).toBeDefined();
    expect(then).toBeDefined();
    expect(traces.find((t) => t.tick === then!.tick)!.lastResult).toEqual({
      action: "core:eat",
      outcome: "interrupted",
      reason: "stuck",
    });
    expect(then!.placementId).not.toBe(stuckOn!.placementId);
    expect(
      (creature.memory["core:feed"] as { avoid: Record<string, number> }).avoid[
        stuckOn!.placementId
      ],
    ).toBe(then!.tick + 600);
  });

  it("repeats the same meals for the same seed", () => {
    const meals = (seed: number) => {
      const { simulation, events, run } = setup(seed);
      for (let k = 0; k < 3; k++) simulation.spawn("hollow:mossling");
      run(30_000);
      const states = [...simulation.state.creatures.values()].map((c) => JSON.stringify(c));
      return { ate: events.filter((e) => e.type === "ate"), states };
    };
    const first = meals(6);
    expect(first.ate.length).toBeGreaterThan(0);
    expect(meals(6)).toEqual(first);
    expect(meals(7).ate).not.toEqual(first.ate);
  });

  it.each([1, 2])("over three hours, every mossling eats regularly (seed %i)", (seed) => {
    const { simulation, events, run } = setup(seed);
    for (let k = 0; k < 3; k++) simulation.spawn("hollow:mossling");
    // Rested, so none naps in these three daytime hours (PR 5a); this is about feeding.
    for (const c of simulation.state.creatures.values()) c.needs["core:tiredness"] = 0;
    let highest = 0;
    for (let t = 0; t < 3 * 36_000; t++) {
      run(1);
      for (const c of simulation.state.creatures.values()) {
        highest = Math.max(highest, c.needs[HUNGER]!);
      }
    }
    expect(events.some((e) => e.type === "creature_stuck" || e.type === "path_failed")).toBe(false);
    for (const c of simulation.state.creatures.values()) {
      const meals = events.flatMap((e) => (e.type === "ate" && e.creatureId === c.id ? [e] : []));
      expect(meals.length).toBeGreaterThanOrEqual(4);
      const gaps = meals.map((m, k) => m.tick - (meals[k - 1]?.tick ?? 0));
      // actAt 0.4 is reached within 0.4 × 90 min / 0.85 ≈ 42 min; the rest is finding food.
      expect(Math.max(...gaps)).toBeLessThan(60 * 60 * 10);
    }
    // Hunger stays bounded: no creature gets near the hungry cue.
    expect(highest).toBeLessThan(0.6);
  });
});

// ---- Touch only ------------------------------------------------------------------------------

describe("a species without vision", () => {
  it("learns of food only by coming within 1 m of it, then eats there", () => {
    const berry = { id: "berry-1", x: 2.5, z: -2 };
    const traces: DecisionTrace[] = [];
    const simulation = createSimulation({
      worldId: "test:river-berry",
      seed: 1,
      onTrace: (t) => traces.push(t),
      register: (r: Registries) => {
        registerRiverCrossing(r);
        r.props.register({
          schemaVersion: 1,
          id: "test:berry-bush",
          version: "1.0.0",
          name: "Berry bush",
          model: "fixture:models/pine.glb",
          blockRadius: 0.2,
          affordances: { [FOOD]: { eatSeconds: 3 } },
        });
        r.worlds.register({
          ...riverCrossingWorld,
          id: "test:river-berry",
          props: [
            ...riverCrossingWorld.props,
            {
              id: berry.id,
              prop: "test:berry-bush",
              transform: { position: { x: berry.x, y: 0.5, z: berry.z } },
            },
          ],
        });
        r.species.register({ ...pebble, id: "test:blind-pebble", behaviors: ["core:feed"] });
      },
    });
    const spawned = simulation.spawn("test:blind-pebble", "north-meadow");
    if (!spawned.ok) throw new Error("spawn failed");
    const creature = spawned.value;
    expect(Object.keys(creature.variation.senses)).toEqual([]);
    creature.needs[HUNGER] = 0.5;
    let learnedAt: number | undefined;
    const events: SimulationEvent[] = [];
    for (let t = 0; t < 36_000 && !events.some((e) => e.type === "ate"); t++) {
      // Perception runs before the creature moves, from where it stands now.
      const { x, z } = creature.position;
      events.push(...simulation.step());
      if (learnedAt === undefined && creature.knowledge.places[FOOD]?.length) {
        learnedAt = simulation.tick;
        expect(Math.hypot(x - berry.x, z - berry.z) - 0.2).toBeLessThanOrEqual(1);
      }
    }
    expect(learnedAt).toBeDefined();
    // Until then it explored; afterwards it went to eat.
    const before = traces.filter((t) => t.tick < learnedAt! && t.chosen);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((t) => t.chosen!.action === "core:follow_path")).toBe(true);
    expect(events.filter((e) => e.type === "ate")).toEqual([
      expect.objectContaining({ placementId: berry.id }),
    ]);
  });
});

describe("exploring for food", () => {
  it("finds and eats food it discovers in a sparse Woodland Hollow, in short legs", () => {
    const traces: DecisionTrace[] = [];
    let kept: string[] = [];
    const simulation = createSimulation({
      worldId: "test:sparse-hollow",
      seed: 2,
      onTrace: (t) => traces.push(t),
      register: (r: Registries) => {
        registerBuiltInContent(r);
        const world = r.worlds.get("hollow:woodland-hollow")!;
        const meadow = world.spawnPoints.find((p) => p.id === "meadow")!.position;
        const isFood = (prop: string) => Object.hasOwn(r.props.get(prop)!.affordances, FOOD);
        // Only the two food props farthest from the meadow are left.
        kept = world.props
          .filter((p) => isFood(p.prop))
          .sort(
            (a, b) =>
              Math.hypot(b.transform.position.x - meadow.x, b.transform.position.z - meadow.z) -
              Math.hypot(a.transform.position.x - meadow.x, a.transform.position.z - meadow.z),
          )
          .slice(0, 2)
          .map((p) => p.id);
        r.worlds.register({
          ...world,
          id: "test:sparse-hollow",
          props: world.props.filter((p) => !isFood(p.prop) || kept.includes(p.id)),
        });
      },
    });
    const spawned = simulation.spawn("hollow:mossling", "meadow");
    if (!spawned.ok) throw new Error("spawn failed");
    const creature = spawned.value;
    creature.needs[HUNGER] = 0.5;
    const events: SimulationEvent[] = [];
    for (let t = 0; t < 2 * 36_000 && !events.some((e) => e.type === "ate"); t++) {
      events.push(...simulation.step());
    }
    const explored = traces.filter(
      (t) => t.chosen?.behavior === "core:feed" && t.chosen.action === "core:follow_path",
    );
    expect(explored.length).toBeGreaterThan(1);
    // Twice the vision range (8 m, ±15%), plus up to half a cell for the point within its cell.
    const reach = 2 * 8 * creature.variation.senses["core:vision"]! + 0.5;
    for (const t of explored) {
      const { destination } = t.chosen!.params as { destination: { x: number; z: number } };
      expect(Math.hypot(destination.x - t.position.x, destination.z - t.position.z)).toBeLessThan(
        reach,
      );
    }
    const [meal] = events.filter((e) => e.type === "ate");
    expect(kept).toContain(meal && "placementId" in meal ? meal.placementId : undefined);
  });
});
