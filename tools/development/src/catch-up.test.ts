import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { parseWorldSave, type WorldSave } from "@living-diorama/content-schema";
import {
  CATCH_UP_CAP_MS,
  eatAction,
  feedBehavior,
  hungerNeed,
  minutesAfter,
  OPEN_SPOT_RADII,
  phaseSpans,
  planCatchUp,
  restBehavior,
  Rng,
  SHORT_GAP_MS,
  SLEEPER_GAP,
  sleepAction,
  tirednessAfter,
  tirednessNeed,
  type ActionContext,
  type ActionProvider,
  type CatchUpGap,
  type CreatureObservation,
  type DayPhase,
  type Simulation,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSimulation } from "./simulation-run";

// Catch-up after a gap (ADR 0018 §19, ADR 0019 §5, §6; M15 PR 3), and the check of saved running
// actions on restore (ADR 0019 §7).

const HZ = 2;
const WORLD = "hollow:woodland-hollow";
const MOSSLING = "hollow:mossling";
const HUNGER = hungerNeed.id;
const TIREDNESS = tirednessNeed.id;
const SAVED_AT = Date.UTC(2026, 9, 28, 20, 40);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (hours: number, minutes = 0) => hours * 60 + minutes;

const create = (seed: number, minutes = at(12)) =>
  createSimulation({
    register: registerBuiltInContent,
    worldId: WORLD,
    seed,
    tickRateHz: HZ,
    startMinutes: minutes,
  });

/** Runs `ticks` ticks from `start`, the time of day following simulation time. */
function run(simulation: Simulation, ticks: number, start: number) {
  const events: SimulationEvent[] = [];
  const from = simulation.tick;
  for (let k = 0; k < ticks; k++) {
    simulation.setTimeOfDay(minutesAfter(start, ((simulation.tick - from) * 1000) / HZ));
    events.push(...simulation.step());
  }
  return events;
}

/** What a save goes through on disk: JSON and back, then the schema. */
function throughDisk(save: WorldSave): WorldSave {
  const parsed = parseWorldSave(JSON.parse(JSON.stringify(save)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

/**
 * Three mosslings run from 19:15 to 20:40: in bed at their new homes, also one whose night starts
 * half an hour late (issue #85). Built once.
 */
const nightSave = (() => {
  let save: WorldSave | undefined;
  return () => {
    if (!save) {
      const simulation = create(7, at(19, 15));
      for (let k = 0; k < 3; k++) simulation.spawn(MOSSLING);
      run(simulation, 85 * 60 * HZ, at(19, 15));
      save = throughDisk(simulation.save(SAVED_AT));
    }
    return structuredClone(save);
  };
})();

/** Three mosslings run from noon for 5 minutes, so some walk or eat. */
function daySave(): WorldSave {
  const simulation = create(3, at(12));
  for (let k = 0; k < 3; k++) simulation.spawn(MOSSLING);
  run(simulation, 5 * 60 * HZ, at(12));
  return throughDisk(simulation.save(SAVED_AT));
}

function restored(
  save: WorldSave,
  options: Parameters<Simulation["restore"]>[1],
  seed = 999,
): { simulation: Simulation; report: ReturnType<typeof report> } {
  const simulation = create(seed);
  return { simulation, report: report(simulation.restore(save, options)) };
}

function report(result: ReturnType<Simulation["restore"]>) {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
}

const PER_CREATURE = ["ate", "fell_asleep", "woke_up", "new_home_selected", "creature_stuck"];

describe("gap rules", () => {
  it("caps the gap at 12 hours", () => {
    expect(planCatchUp(0, 30 * HOUR)).toEqual({ apply: true, gapMs: CATCH_UP_CAP_MS });
    expect(planCatchUp(0, 5 * HOUR)).toEqual({ apply: true, gapMs: 5 * HOUR });
  });

  it("counts a clock that went backwards, or didn't move, as no gap", () => {
    expect(planCatchUp(10 * HOUR, 9 * HOUR)).toEqual({
      apply: false,
      reason: "no_gap",
    });
    expect(planCatchUp(HOUR, HOUR)).toEqual({ apply: false, reason: "no_gap" });
  });

  it("treats a gap under 2 minutes as no gap", () => {
    expect(planCatchUp(0, SHORT_GAP_MS - 1)).toEqual({
      apply: false,
      reason: "short_gap",
    });
    expect(planCatchUp(0, SHORT_GAP_MS)).toEqual({
      apply: true,
      gapMs: SHORT_GAP_MS,
    });
  });

  it("splits a gap ending now into the phases it passed through", () => {
    // 22:00 to 07:30: the rest of the night across midnight, then dawn.
    expect(phaseSpans(at(7, 30), 9.5 * HOUR)).toEqual([
      { phase: "night", hours: 8 },
      { phase: "dawn", hours: 1.5 },
    ]);
    expect(phaseSpans(at(21), 12 * HOUR)).toEqual([
      { phase: "day", hours: 9 },
      { phase: "dusk", hours: 2 },
      { phase: "night", hours: 1 },
    ]);
    expect(phaseSpans(at(12), 5 * MINUTE)).toEqual([{ phase: "day", hours: 1 / 12 }]);
  });
});

describe("restore without catch-up", () => {
  it("resumes a short gap exactly; only the time of day moves", () => {
    const save = daySave();
    expect(save.creatures.some((c) => c.action)).toBe(true);
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 90_000,
      minutes: save.minutes + 1.5,
    });
    expect(report.gapMs).toBe(90_000);
    expect(report.catchUp).toEqual({
      applied: false,
      skipped: "short_gap",
      gapMs: 0,
      failures: [],
    });
    expect(report.droppedActions).toEqual([]);
    const after = simulation.save(SAVED_AT);
    expect(after.creatures).toEqual(save.creatures);
    expect(after.minutes).toBe(save.minutes + 1.5);
  });

  it("counts a clock that went backwards as no gap", () => {
    const save = daySave();
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT - 3 * HOUR,
      minutes: at(9),
    });
    expect(report.gapMs).toBe(0);
    expect(report.catchUp.skipped).toBe("no_gap");
    expect(simulation.save(SAVED_AT).creatures).toEqual(save.creatures);
  });
});

describe("catch-up after a long gap", () => {
  it("wakes creatures rested and fed in the morning, near home, with nothing announced", () => {
    const save = nightSave();
    expect(save.creatures.every((c) => c.home !== null && c.asleep)).toBe(true);
    // Back at 07:10 the next morning: the night has passed.
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 11 * HOUR,
      minutes: at(7, 10),
    });
    expect(report.catchUp).toEqual({ applied: true, gapMs: 11 * HOUR, failures: [] });
    const after = simulation.save(SAVED_AT);
    for (const creature of after.creatures) {
      const before = save.creatures.find((c) => c.id === creature.id)!;
      expect(creature.action).toBeUndefined();
      expect(creature.lastResult).toBeUndefined();
      expect(creature.asleep).toBe(false);
      // Rested at dawn, then up for 70 minutes.
      expect(creature.needs[TIREDNESS]).toBeGreaterThan(0);
      expect(creature.needs[TIREDNESS]).toBeLessThan(0.1);
      expect(creature.needs[HUNGER]).toBeLessThan(hungerNeed.actAt);
      // Awake in its home's region, somewhere else than its bed.
      const home = simulation.spotFor(creature.id, creature.home!);
      expect(creature.position.regionId).toBe(home?.regionId);
      expect(creature.position).not.toEqual(before.position);
    }
    expect(after.dayPhase).toBe("dawn");
    const events = simulation.step();
    expect(events.filter((e) => e.type === "day_phase_changed")).toEqual([]);
    expect(events.filter((e) => PER_CREATURE.includes(e.type))).toEqual([]);
    expect(simulation.snapshot().creatures.every((c) => !c.cues.includes("sleeping"))).toBe(true);
  });

  it("wakes each creature by its own day: one whose dawn starts late still sleeps", () => {
    const save = nightSave();
    // Their nights have begun, so each morning is set: dawn at 05:45 or 06:25.
    const mornings = [-15, 25, 25];
    save.creatures.forEach((c, k) => {
      expect(c.day).toMatchObject({ phase: "night" });
      expect(c.day.evening).toBeUndefined();
      c.day.morning = mornings[k]!;
    });
    // Back at 06:10.
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 9.5 * HOUR,
      minutes: at(6, 10),
    });
    expect(report.catchUp.applied).toBe(true);
    const after = simulation.save(SAVED_AT).creatures;
    expect(after.map((c) => c.asleep)).toEqual([false, true, true]);
    expect(after.map((c) => c.day.phase)).toEqual(["dawn", "night", "night"]);
    const [early, late] = after;
    // Up since 05:45: rested then, and tired by 25 minutes awake since.
    const rate = tirednessNeed.perHour.awake * early!.variation.needs[TIREDNESS]!;
    expect(early!.needs[TIREDNESS]).toBeCloseTo(rate * (25 / 60), 9);
    // The early one drew its evening at its dawn; the late one draws its own at 06:25.
    expect(early!.day.evening).toBeDefined();
    expect(late!.day.evening).toBeUndefined();
    const events = run(simulation, 20 * 60 * HZ, at(6, 10));
    const woke = events.filter((e) => e.type === "woke_up");
    expect(woke.map((e) => ("creatureId" in e ? e.creatureId : ""))).toEqual(
      [after[1]!.id, after[2]!.id].sort(),
    );
    for (const e of woke) expect(e.tick - simulation.tick + 20 * 60 * HZ).toBe(15 * 60 * HZ);
  });

  it("puts creatures to bed at home when it is night, already asleep", () => {
    const save = nightSave();
    // Back at 22:10 the next day; the gap counts as the 12 hours since 10:10.
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 26 * HOUR,
      minutes: at(22, 10),
    });
    expect(report.catchUp).toEqual({ applied: true, gapMs: CATCH_UP_CAP_MS, failures: [] });
    const restoredCreatures = simulation.save(SAVED_AT).creatures;
    for (const creature of restoredCreatures) {
      expect(creature.action).toMatchObject({
        id: "core:sleep",
        behavior: "core:rest",
        state: { placementId: creature.home, arrived: true, asleep: true, nap: false },
      });
      expect(creature.position).toEqual(simulation.spotFor(creature.id, creature.home!));
      // Lying at a resting heading of its own already, with no turn to make.
      expect(creature.heading).toBe((creature.action?.state as { heading: number }).heading);
      // Up from 10:10 to 20:00, asleep since: tired, but less than at bedtime.
      expect(creature.needs[TIREDNESS]).toBeGreaterThan(0.2);
      expect(creature.needs[HUNGER]).toBeLessThan(hungerNeed.actAt);
    }
    // Each draws its own heading, so they don't all lie the same way.
    expect(new Set(restoredCreatures.map((c) => c.heading)).size).toBe(restoredCreatures.length);
    const headings = restoredCreatures.map((c) => c.heading);
    const events = run(simulation, 20, at(22, 10));
    expect(simulation.save(SAVED_AT).creatures.map((c) => c.heading)).toEqual(headings);
    expect(events.filter((e) => e.type === "day_phase_changed")).toEqual([]);
    expect(events.filter((e) => PER_CREATURE.includes(e.type))).toEqual([]);
    const snapshot = simulation.snapshot();
    expect(snapshot.creatures.every((c) => c.cues.includes("sleeping"))).toBe(true);
    expect(simulation.save(SAVED_AT).creatures.every((c) => c.asleep)).toBe(true);
  });

  it("raises tiredness for the hours awake when no night passed", () => {
    const save = daySave();
    const { simulation } = restored(save, { nowMs: SAVED_AT + 4 * HOUR, minutes: at(16, 5) });
    for (const creature of simulation.save(SAVED_AT).creatures) {
      const before = save.creatures.find((c) => c.id === creature.id)!;
      const rate = tirednessNeed.perHour.awake * (creature.variation.needs[TIREDNESS] ?? 1);
      expect(creature.needs[TIREDNESS]).toBeCloseTo(before.needs[TIREDNESS]! + 4 * rate, 9);
    }
  });

  it("is the same for the same save and present", () => {
    const save = nightSave();
    const options = { nowMs: SAVED_AT + 5 * HOUR, minutes: at(1, 10) };
    const a = restored(save, options, 1);
    const b = restored(save, options, 2);
    expect(a.report).toEqual(b.report);
    expect(a.simulation.save(0)).toEqual(b.simulation.save(0));
    expect(run(a.simulation, 400, at(1, 10))).toEqual(run(b.simulation, 400, at(1, 10)));
    expect(a.simulation.save(0)).toEqual(b.simulation.save(0));
  });

  it("moves the tick on by the gap, so the release grace and cooldowns count the time away", () => {
    const simulation = create(5, at(21));
    expect(simulation.spawn(MOSSLING, undefined, { released: true }).ok).toBe(true);
    run(simulation, 60 * HZ, at(21));
    const saved = simulation.save(SAVED_AT);
    // A meal it failed to reach, skipped for another minute.
    saved.creatures[0]!.memory["core:feed"] = { avoid: { "gone-later": saved.tick + 60 * HZ } };
    const save = throughDisk(saved);
    const released = save.creatures[0]!.releasedAtTick!;

    // 3 minutes away: 4 minutes since the release, still in the grace, so awake.
    const short = restored(save, { nowMs: SAVED_AT + 3 * MINUTE, minutes: at(21, 4) });
    expect(short.simulation.tick).toBe(save.tick + 3 * 60 * HZ);
    const [inGrace] = short.simulation.save(SAVED_AT).creatures;
    expect(inGrace!.releasedAtTick).toBe(released);
    expect(inGrace!.action).toBeUndefined();

    // An hour away: the grace is over, so it is put to bed, and the cooldown has run out.
    const long = restored(save, { nowMs: SAVED_AT + HOUR, minutes: at(22, 1) });
    expect(long.simulation.tick).toBe(save.tick + 3600 * HZ);
    const after = throughDisk(long.simulation.save(SAVED_AT)).creatures[0]!;
    expect(after.action?.id).toBe("core:sleep");
    const avoid = (after.memory["core:feed"] as { avoid: Record<string, number> }).avoid;
    expect(Object.values(avoid).every((until) => until <= long.simulation.tick)).toBe(true);
  });

  it("staggers the first decisions of awake creatures over up to 30 s", () => {
    const { simulation } = restored(nightSave(), {
      nowMs: SAVED_AT + 11 * HOUR,
      minutes: at(7, 10),
    });
    const ticks = simulation.save(0).creatures.map((c) => c.decideAtTick - simulation.tick);
    expect(ticks.every((t) => t >= 0 && t <= 30 * HZ)).toBe(true);
    expect(new Set(ticks).size).toBeGreaterThan(1);
  });

  it("draws afresh on a second restore after time has passed", () => {
    const save = nightSave();
    const first = restored(save, { nowMs: SAVED_AT + 11 * HOUR, minutes: at(7, 10) });
    const resaved = throughDisk(first.simulation.save(SAVED_AT + 11 * HOUR));
    const second = restored(resaved, { nowMs: SAVED_AT + 22 * HOUR, minutes: at(18, 10) });
    const a = first.simulation.save(0).creatures.map((c) => c.needs[HUNGER]);
    const b = second.simulation.save(0).creatures.map((c) => c.needs[HUNGER]);
    expect(a).not.toEqual(b);
  });

  it("lowers tiredness through a gap that ends mid-night, without resetting it", () => {
    const save = nightSave();
    const { simulation } = restored(save, { nowMs: SAVED_AT + 3 * HOUR, minutes: at(23, 10) });
    for (const creature of simulation.save(SAVED_AT).creatures) {
      const before = save.creatures.find((c) => c.id === creature.id)!;
      const rate = tirednessNeed.perHour.asleep * (creature.variation.needs[TIREDNESS] ?? 1);
      expect(creature.needs[TIREDNESS]).toBeCloseTo(
        Math.max(0, before.needs[TIREDNESS]! + 3 * rate),
        9,
      );
      expect(creature.action?.id).toBe("core:sleep");
    }
  });

  it("puts a creature with no home to bed at the nearest shelter it knows", () => {
    const save = nightSave();
    const creature = save.creatures[0]!;
    const shelters = creature.knowledge.places["core:shelter"]!.map((p) => p.placementId);
    expect(shelters.length).toBeGreaterThan(0);
    creature.home = null;
    const { simulation } = restored(save, { nowMs: SAVED_AT + 3 * HOUR, minutes: at(23, 10) });
    const after = simulation.save(SAVED_AT).creatures[0]!;
    const placementId = (after.action?.state as { placementId: string }).placementId;
    expect(shelters).toContain(placementId);
    expect(after.position).toEqual(simulation.spotFor(after.id, placementId));
    // It takes the shelter as home, as on falling asleep there.
    expect(after.home).toBe(placementId);
  });

  it("puts a creature knowing no shelter to bed where it stands", () => {
    const save = nightSave();
    const creature = save.creatures[0]!;
    creature.home = null;
    creature.knowledge.places["core:shelter"] = [];
    const { simulation } = restored(save, { nowMs: SAVED_AT + 3 * HOUR, minutes: at(23, 10) });
    const after = simulation.save(SAVED_AT).creatures[0]!;
    expect(after.action).toMatchObject({
      id: "core:sleep",
      state: { placementId: null, asleep: true },
    });
    expect(after.heading).toBe((after.action?.state as { heading: number }).heading);
    expect(after.position).toEqual(creature.position);
    expect(after.home).toBeNull();
  });
  it("counts as asleep only creatures already put to bed, not those asleep at the save", () => {
    const save = nightSave();
    const [first, second] = save.creatures;
    const { position } = first!;
    // Both homeless on one point; the second was asleep there at the save, but wakes in catch-up.
    for (const creature of [first!, second!]) {
      creature.home = null;
      creature.knowledge.places["core:shelter"] = [];
      creature.position = { ...position };
    }
    expect(second!.asleep).toBe(true);
    const original = restBehavior.catchUp!;
    const spy = vi
      .spyOn(restBehavior, "catchUp")
      .mockImplementation((observation, gap, rng) =>
        observation.creature.id === second!.id ? null : original(observation, gap, rng),
      );
    try {
      const { simulation } = restored(save, { nowMs: SAVED_AT + 3 * HOUR, minutes: at(23, 10) });
      const [after, awake] = simulation.save(SAVED_AT).creatures;
      expect(awake!.action).toBeUndefined();
      // The second's stale sleep at the save doesn't push the first off its point.
      expect(after!.action).toMatchObject({ id: "core:sleep", state: { placementId: null } });
      expect(after!.position).toEqual(position);
    } finally {
      spy.mockRestore();
    }
  });

  it("puts creatures knowing no shelter to bed apart, the same for the same save", () => {
    const save = nightSave();
    const { position } = save.creatures[0]!;
    for (const creature of save.creatures) {
      creature.home = null;
      creature.knowledge.places["core:shelter"] = [];
      creature.position = { ...position };
    }
    const bed = () => {
      const { simulation, report } = restored(structuredClone(save), {
        nowMs: SAVED_AT + 3 * HOUR,
        minutes: at(23, 10),
      });
      expect(report.catchUp.failures).toEqual([]);
      const creatures = simulation.save(SAVED_AT).creatures;
      const radius = simulation.state.pathfinderFor(MOSSLING)!.navigation.profile.radius;
      return { creatures, radius };
    };
    const { creatures, radius } = bed();
    for (const creature of creatures) {
      expect(creature.action).toMatchObject({
        id: "core:sleep",
        state: { placementId: null, asleep: true },
      });
      expect(creature.asleep).toBe(true);
    }
    // The first stays where it was; the others lie down clear of those before them.
    expect(creatures[0]!.position).toEqual(position);
    const positions = creatures.map((c) => c.position);
    for (const [i, a] of positions.entries()) {
      for (const b of positions.slice(i + 1)) {
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(2 * radius + SLEEPER_GAP);
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThanOrEqual(
          2 * OPEN_SPOT_RADII.at(-1)! + 1,
        );
      }
    }
    expect(bed().creatures).toEqual(creatures);
  });
});

describe("catch-up in place, for time a running world lost (issue #113)", () => {
  /** Three mosslings run live from `start` for `minutes`, never saved. */
  function live(seed: number, start: number, minutes: number) {
    const simulation = create(seed, start);
    for (let k = 0; k < 3; k++) simulation.spawn(MOSSLING);
    run(simulation, minutes * 60 * HZ, start);
    return simulation;
  }

  it.each([
    ["overnight, from bedtime to the morning", 7, at(19, 15), 85, 11 * HOUR, at(7, 40)],
    ["by day, while some walk or eat", 3, at(12), 5, 3 * HOUR, at(15, 5)],
    ["beyond the cap", 5, at(12), 5, 20 * HOUR, at(8, 5)],
  ])("leaves the world as a relaunch after the same gap: %s", (_, seed, start, mins, gap, now) => {
    const running = live(seed, start, mins);
    const { simulation: relaunched, report: restore } = restored(
      throughDisk(running.save(SAVED_AT)),
      { nowMs: SAVED_AT + gap, minutes: now },
    );
    const report = running.catchUp({ gapMs: gap, minutes: now });
    expect(report.applied).toBe(true);
    expect(report).toEqual(restore.catchUp);
    expect(running.save(0)).toEqual(relaunched.save(0));
    expect(run(running, 600, now)).toEqual(run(relaunched, 600, now));
    expect(running.save(0)).toEqual(relaunched.save(0));
  });

  it("is the same for the same world and gap, and announces nothing", () => {
    const [a, b] = [live(7, at(19, 15), 85), live(7, at(19, 15), 85)];
    expect(a.catchUp({ gapMs: 9 * HOUR, minutes: at(5, 40) })).toEqual(
      b.catchUp({ gapMs: 9 * HOUR, minutes: at(5, 40) }),
    );
    expect(a.save(0)).toEqual(b.save(0));
    const events = run(a, 1, at(5, 40));
    expect(events.filter((e) => e.type === "day_phase_changed")).toEqual([]);
    expect(events.filter((e) => PER_CREATURE.includes(e.type))).toEqual([]);
  });

  it("does nothing but set the time of day for a gap under 2 minutes or a clock set back", () => {
    for (const gapMs of [SHORT_GAP_MS - 1, 0, -HOUR]) {
      const a = live(3, at(12), 5);
      const b = live(3, at(12), 5);
      const report = a.catchUp({ gapMs, minutes: at(12, 6) });
      expect(report).toEqual({
        applied: false,
        skipped: gapMs > 0 ? "short_gap" : "no_gap",
        gapMs: 0,
        failures: [],
      });
      b.setTimeOfDay(at(12, 6));
      expect(a.save(0)).toEqual(b.save(0));
      expect(run(a, 200, at(12, 6))).toEqual(run(b, 200, at(12, 6)));
    }
  });

  it("refuses a gap or time of day that isn't a number", () => {
    const simulation = create(1);
    expect(() => simulation.catchUp({ gapMs: Number.NaN, minutes: 0 })).toThrow(RangeError);
    expect(() => simulation.catchUp({ gapMs: HOUR, minutes: Infinity })).toThrow(RangeError);
  });
});

describe("core:rest catching up", () => {
  const gap = (phases: { phase: DayPhase; hours: number }[]): CatchUpGap => ({
    ms: phases.reduce((sum, p) => sum + p.hours, 0) * HOUR,
    phases,
    needRate: (id, asleep) =>
      id === TIREDNESS
        ? asleep
          ? tirednessNeed.perHour.asleep
          : tirednessNeed.perHour.awake
        : undefined,
  });

  it("rests a nocturnal creature through the day and wakes it at dusk", () => {
    const awake = tirednessNeed.perHour.awake;
    expect(
      tirednessAfter(
        0.5,
        gap([
          { phase: "day", hours: 9 },
          { phase: "dusk", hours: 1 },
        ]),
        true,
      ),
    ).toBeCloseTo(awake, 9);
    // Diurnal, the same hours are a day awake.
    expect(
      tirednessAfter(
        0.2,
        gap([
          { phase: "day", hours: 9 },
          { phase: "dusk", hours: 1 },
        ]),
        false,
      ),
    ).toBeCloseTo(0.2 + 10 * awake, 9);
  });

  it("puts a nocturnal creature to bed by day, not at night", () => {
    const observation = (dayPhase: DayPhase) =>
      ({
        tick: 0,
        tickSeconds: 1,
        creature: { id: "c", speciesId: "s", position: { regionId: "r", x: 0, z: 0 }, heading: 0 },
        dayPhase,
        needs: { [TIREDNESS]: 0.5 },
        traits: { "core:nocturnal": 1 },
        senses: {},
        knowledge: { places: {}, recentCells: [] },
        home: null,
        world: { place: () => undefined, spotAt: () => undefined, sleeperNear: () => false },
      }) as unknown as CreatureObservation;
    const g = gap([{ phase: "day", hours: 3 }]);
    const rng = new Rng({ words: [1, 2, 3, 4], key: 5 });
    expect(restBehavior.catchUp!(observation("day"), g, rng)?.start).toEqual({
      action: "core:sleep",
      params: { asleep: true },
    });
    expect(restBehavior.catchUp!(observation("night"), g, rng)?.start).toBeUndefined();
  });

  it("can't start sleep already asleep away from the shelter's spot", () => {
    const context = {
      catchingUp: true,
      dayPhase: "night",
      traits: {},
      position: { regionId: "r", x: 10, z: 0 },
      place: (id: string) => ({
        id,
        x: 0,
        y: 0,
        z: 0,
        blockRadius: 0,
        affordances: { "core:shelter": {} },
      }),
      spotAt: () => ({ regionId: "r", x: 1, z: 0 }),
    } as unknown as ActionContext;
    expect(sleepAction.start({ placementId: "tree", asleep: true }, context)).toMatchObject({
      ok: false,
      reason: "not_at_spot",
    });
  });

  it("can't start sleep already asleep outside catch-up, even where it stands", () => {
    const context = {
      catchingUp: false,
      dayPhase: "night",
      traits: {},
      position: { regionId: "r", x: 0, z: 0 },
    } as unknown as ActionContext;
    expect(sleepAction.start({ asleep: true }, context)).toMatchObject({
      ok: false,
      reason: "not_catching_up",
    });
  });

  it("rejects a normal proposal to sleep already asleep", () => {
    const simulation = create(4, at(12));
    expect(simulation.spawn(MOSSLING).ok).toBe(true);
    const spy = vi
      .spyOn(restBehavior, "evaluate")
      .mockReturnValue({ action: "core:sleep", params: { asleep: true }, utility: 5 });
    try {
      simulation.step();
    } finally {
      spy.mockRestore();
    }
    const [creature] = simulation.save(0).creatures;
    expect(creature!.action?.id).not.toBe("core:sleep");
    expect(creature!.lastResult).toEqual({
      action: "core:sleep",
      outcome: "failed",
      reason: "not_catching_up",
    });
  });
});

describe("running actions dropped by catch-up (issue #164)", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Spies on `core:sleep`'s `interrupted` hook, calling through unless `mock` is given. */
  function spyOnInterrupted(mock?: NonNullable<ActionProvider["interrupted"]>) {
    const spy = vi.spyOn(sleepAction as Required<ActionProvider>, "interrupted");
    if (mock) spy.mockImplementation(mock);
    return spy;
  }

  /** Each call's saved state, reason and tick. */
  const calls = (spy: ReturnType<typeof spyOnInterrupted>) =>
    spy.mock.calls.map(([state, context, reason]) => ({
      state: structuredClone(state),
      reason,
      tick: context.tick,
    }));

  it("are interrupted with the reason catch_up, at the tick after the jump, announcing nothing", () => {
    const save = nightSave();
    const spy = spyOnInterrupted();
    const { simulation } = restored(save, { nowMs: SAVED_AT + 5 * HOUR, minutes: at(1, 40) });
    expect(calls(spy)).toEqual(
      save.creatures.map((c) => ({
        state: c.action!.state,
        reason: "catch_up",
        tick: simulation.tick,
      })),
    );
    // The sleepers' `woke_up` is discarded with the rest of catch-up's events.
    expect(run(simulation, 1, at(1, 40)).filter((e) => PER_CREATURE.includes(e.type))).toEqual([]);
  });

  it("are not interrupted when there is no gap to catch up", () => {
    const save = nightSave();
    const spy = spyOnInterrupted();
    restored(save, { nowMs: SAVED_AT + MINUTE, minutes: save.minutes });
    expect(spy).not.toHaveBeenCalled();
  });

  it("are interrupted alike on a relaunch and in place", () => {
    const running = create(7, at(19, 15));
    for (let k = 0; k < 3; k++) running.spawn(MOSSLING);
    run(running, 85 * 60 * HZ, at(19, 15));
    const save = throughDisk(running.save(SAVED_AT));
    const spy = spyOnInterrupted();
    restored(save, { nowMs: SAVED_AT + 11 * HOUR, minutes: at(7, 40) });
    const relaunch = calls(spy);
    spy.mockClear();
    running.catchUp({ gapMs: 11 * HOUR, minutes: at(7, 40) });
    expect(relaunch).toHaveLength(save.creatures.length);
    expect(calls(spy)).toEqual(relaunch);
  });

  it("are dropped all the same when their hook throws, and the failure is reported", () => {
    spyOnInterrupted(() => {
      throw new Error("broken hook");
    });
    const save = nightSave();
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 11 * HOUR,
      minutes: at(7, 40),
    });
    expect(report.catchUp.applied).toBe(true);
    expect(report.catchUp.failures).toEqual(
      save.creatures.map((c) => ({
        creatureId: c.id,
        behavior: c.action!.behavior,
        reason: "interrupted_failed",
      })),
    );
    // Catch-up went on: everyone is awake at a fresh decision by morning.
    expect(simulation.save(0).creatures.every((c) => !c.action && !c.asleep)).toBe(true);
    run(simulation, 50, at(7, 40));
  });

  it("record no back-off for a meal cut short on the way to its food", () => {
    // A live world run until a creature is walking to its food.
    const running = create(3, at(12));
    for (let k = 0; k < 3; k++) running.spawn(MOSSLING);
    const walking = (save: WorldSave) =>
      save.creatures.find(
        (c) => c.action?.id === "core:eat" && !(c.action.state as { arrived: boolean }).arrived,
      );
    let before: WorldSave | undefined;
    for (let k = 0; k < 600 && !before; k++) {
      run(running, 5, minutesAfter(at(12), (running.tick * 1000) / HZ));
      const save = running.save(0);
      if (walking(save)) before = save;
    }
    const eater = walking(before!)!;
    const spy = vi.spyOn(eatAction as Required<ActionProvider>, "interrupted");
    running.catchUp({ gapMs: 3 * HOUR, minutes: at(15) });
    expect(spy.mock.calls.map(([, , reason]) => reason)).toContain("catch_up");
    const after = running.save(0).creatures.find((c) => c.id === eater.id)!;
    expect(after.knowledge).toEqual(eater.knowledge);
  });

  it("record no back-off for a sleep cut short on the way to its shelter (#161)", () => {
    // A live world run until a creature is walking to a shelter at bedtime.
    const running = create(3, at(21));
    for (let k = 0; k < 3; k++) running.spawn(MOSSLING);
    const walking = (save: WorldSave) =>
      save.creatures.find((c) => {
        const state = c.action?.state as { arrived: boolean; placementId: string | null };
        return c.action?.id === "core:sleep" && state.placementId !== null && !state.arrived;
      });
    let before: WorldSave | undefined;
    for (let k = 0; k < 600 && !before; k++) {
      run(running, 5, minutesAfter(at(21), (running.tick * 1000) / HZ));
      const save = running.save(0);
      if (walking(save)) before = save;
    }
    const sleeper = walking(before!)!;
    const spy = vi.spyOn(sleepAction as Required<ActionProvider>, "interrupted");
    running.catchUp({ gapMs: 3 * HOUR, minutes: at(0) });
    expect(spy.mock.calls.map(([, , reason]) => reason)).toContain("catch_up");
    const after = running.save(0).creatures.find((c) => c.id === sleeper.id)!;
    expect(after.knowledge.places["core:shelter"]).toEqual(
      sleeper.knowledge.places["core:shelter"],
    );
  });

  it("leave catch-up's draws unchanged when their hook draws", () => {
    const options = { nowMs: SAVED_AT + 11 * HOUR, minutes: at(7, 40) };
    spyOnInterrupted(() => {});
    const quiet = restored(nightSave(), options).simulation.save(0);
    vi.restoreAllMocks();
    spyOnInterrupted((_state, context) => {
      for (let k = 0; k < 5; k++) context.rng.next();
    });
    expect(restored(nightSave(), options).simulation.save(0)).toEqual(quiet);
  });
});

describe("catch-up hooks that fail", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lose only their own effect, and the restore reports them", () => {
    vi.spyOn(feedBehavior, "catchUp").mockImplementation(() => {
      throw new Error("broken hook");
    });
    const save = nightSave();
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 11 * HOUR,
      minutes: at(7, 10),
    });
    expect(report.catchUp.applied).toBe(true);
    expect(report.catchUp.failures).toEqual(
      save.creatures.map((c) => ({
        creatureId: c.id,
        behavior: feedBehavior.id,
        reason: "hook_failed",
      })),
    );
    for (const creature of simulation.save(SAVED_AT).creatures) {
      const before = save.creatures.find((c) => c.id === creature.id)!;
      expect(creature.needs[HUNGER]).toBe(before.needs[HUNGER]);
      // `core:rest`'s hook still ran.
      expect(creature.needs[TIREDNESS]).toBeLessThan(0.1);
    }
    run(simulation, 50, at(7, 10));
  });

  it("place the creature awake when the asked-for start can't happen", () => {
    vi.spyOn(restBehavior, "catchUp").mockReturnValue({
      start: { action: "core:sleep", params: { asleep: true }, at: "nowhere" },
    });
    const save = nightSave();
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 5 * HOUR,
      minutes: at(1, 10),
    });
    expect(report.catchUp.failures.map((f) => f.reason)).toEqual(
      save.creatures.map(() => "no_spot"),
    );
    expect(simulation.save(SAVED_AT).creatures.every((c) => !c.action)).toBe(true);
  });

  it("place the creature awake when asked to start at a position it has no route to", () => {
    vi.spyOn(restBehavior, "catchUp").mockReturnValue({
      start: {
        action: "core:sleep",
        params: { asleep: true },
        at: { regionId: "nowhere", x: 0, z: 0 },
      },
    });
    const save = nightSave();
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 5 * HOUR,
      minutes: at(1, 10),
    });
    expect(report.catchUp.failures.map((f) => f.reason)).toEqual(
      save.creatures.map(() => "no_route"),
    );
    expect(simulation.save(SAVED_AT).creatures.every((c) => !c.action)).toBe(true);
  });

  it("leave alone a need their behavior doesn't declare, and report it", () => {
    vi.spyOn(restBehavior, "catchUp").mockReturnValue({ needs: { [HUNGER]: 0.95 } });
    const save = nightSave();
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 5 * HOUR,
      minutes: at(1, 10),
    });
    expect(report.catchUp.failures).toEqual(
      save.creatures.map((c) => ({
        creatureId: c.id,
        behavior: restBehavior.id,
        reason: "undeclared_need",
        need: HUNGER,
      })),
    );
    // `core:feed`'s hunger stands.
    expect(simulation.save(0).creatures.every((c) => c.needs[HUNGER]! < hungerNeed.actAt)).toBe(
      true,
    );
  });

  it("can't start an action the behavior doesn't declare", () => {
    vi.spyOn(restBehavior, "catchUp").mockReturnValue({
      start: { action: "core:eat", params: { placementId: "x" } },
    });
    const { report } = restored(nightSave(), { nowMs: SAVED_AT + 5 * HOUR, minutes: at(1, 10) });
    expect(new Set(report.catchUp.failures.map((f) => f.reason))).toEqual(
      new Set(["undeclared_action"]),
    );
  });
});

describe("saved running actions", () => {
  afterEach(() => vi.restoreAllMocks());

  /** A short-gap restore of the night save with the first creature's action replaced. */
  function withAction(action: WorldSave["creatures"][number]["action"]) {
    const save = nightSave();
    const creature = save.creatures[0]!;
    creature.action = action;
    const { simulation, report } = restored(save, { nowMs: SAVED_AT, minutes: save.minutes });
    return { creature, after: simulation.save(SAVED_AT).creatures[0]!, report, simulation };
  }

  it("carry on when their state is sound", () => {
    const save = nightSave();
    expect(save.creatures.every((c) => c.action?.id === "core:sleep")).toBe(true);
    const { simulation, report } = restored(save, { nowMs: SAVED_AT, minutes: save.minutes });
    expect(report.droppedActions).toEqual([]);
    expect(simulation.save(SAVED_AT).creatures).toEqual(save.creatures);
  });

  it("are dropped when their action isn't registered", () => {
    const { creature, after, report } = withAction({
      id: "core:dance",
      behavior: "core:wander",
      state: {},
      startTick: 0,
    });
    expect(report.droppedActions).toEqual([
      { creatureId: creature.id, actionId: "core:dance", reason: "unknown_action" },
    ]);
    expect(after.action).toBeUndefined();
    expect(after.asleep).toBe(false);
    expect(after.lastResult).toEqual({
      action: "core:dance",
      outcome: "interrupted",
      reason: "unknown_action",
    });
  });

  it("are dropped when their action's check throws", () => {
    vi.spyOn(sleepAction, "checkState").mockImplementation(() => {
      throw new Error("broken check");
    });
    const save = nightSave();
    const { simulation, report } = restored(save, { nowMs: SAVED_AT, minutes: save.minutes });
    expect(report.droppedActions).toEqual(
      save.creatures.map((c) => ({
        creatureId: c.id,
        actionId: "core:sleep",
        reason: "invalid_state",
      })),
    );
    expect(simulation.save(0).creatures.every((c) => !c.action && !c.asleep)).toBe(true);
  });

  it("are dropped when their state names a placement no longer in the world", () => {
    const sleeping = nightSave().creatures[0]!.action!;
    const { creature, after, report } = withAction({
      ...sleeping,
      state: { ...(sleeping.state as object), placementId: "gone-tree" },
    });
    expect(report.droppedActions).toEqual([
      { creatureId: creature.id, actionId: "core:sleep", reason: "invalid_state" },
    ]);
    expect(after.action).toBeUndefined();
  });

  const path = { points: [{ regionId: "r", x: 1, z: 2 }], next: 0 };
  const eat = {
    placementId: "gone-bush",
    x: 0,
    z: 0,
    path,
    arrived: false,
    ticksLeft: 4,
    perTick: 0.2,
  };
  it.each([
    ["core:eat", "core:feed", eat],
    ["core:eat", "core:feed", { ...eat, placementId: 7 }],
    ["core:eat", "core:feed", { ...eat, ticksLeft: 0 }],
    ["core:sleep", "core:rest", { placementId: null, heading: 0, path, arrived: 1 }],
    [
      "core:sleep",
      "core:rest",
      { placementId: null, heading: 0, path, arrived: true, asleep: true },
    ],
    [
      "core:sleep",
      "core:rest",
      { placementId: null, heading: "0", path, arrived: true, asleep: true, nap: false },
    ],
    [
      "core:sleep",
      "core:rest",
      { placementId: null, heading: 0, path, arrived: true, asleep: true, moves: -1, nap: false },
    ],
    ["core:sleep", "core:rest", "asleep"],
    // The shape before resting headings: where the shelter stands instead of a heading.
    [
      "core:sleep",
      "core:rest",
      { placementId: null, x: 0, z: 0, path, arrived: true, asleep: true, nap: false },
    ],
    ["core:follow_path", "core:wander", { points: [{ regionId: "r", x: 1 }], next: 0 }],
    ["core:follow_path", "core:wander", { ...path, next: 2 }],
    ["core:idle", "core:wander", { remainingTicks: 0 }],
    ["core:idle", "core:wander", null],
  ])("drops %s with a malformed state", (id, behavior, state) => {
    const { report } = withAction({ id, behavior, state, startTick: 0 });
    expect(report.droppedActions.map((d) => [d.actionId, d.reason])).toEqual([
      [id, "invalid_state"],
    ]);
  });

  it.each([
    ["core:follow_path", "core:wander", path],
    ["core:idle", "core:wander", { remainingTicks: 3 }],
    [
      "core:sleep",
      "core:rest",
      { placementId: null, heading: 0, path, arrived: true, asleep: true, moves: 0, nap: false },
    ],
  ])("keeps %s with a sound state", (id, behavior, state) => {
    const { after, report } = withAction({ id, behavior, state, startTick: 0 });
    expect(report.droppedActions).toEqual([]);
    expect(after.action?.state).toEqual(state);
  });
});
