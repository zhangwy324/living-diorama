import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { parseWorldSave, type WorldSave } from "@living-diorama/content-schema";
import {
  CATCH_UP_CAP_MS,
  feedBehavior,
  hungerNeed,
  minutesAfter,
  phaseSpans,
  planCatchUp,
  restBehavior,
  SHORT_GAP_MS,
  tirednessNeed,
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
const SAVED_AT = Date.UTC(2026, 9, 28, 20, 10);
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

/** Three mosslings run from 19:15 to 20:10: in bed at their new homes. Built once. */
const nightSave = (() => {
  let save: WorldSave | undefined;
  return () => {
    if (!save) {
      const simulation = create(7, at(19, 15));
      for (let k = 0; k < 3; k++) simulation.spawn(MOSSLING);
      run(simulation, 55 * 60 * HZ, at(19, 15));
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
    expect(planCatchUp(0, 30 * HOUR, "real_time")).toEqual({ apply: true, gapMs: CATCH_UP_CAP_MS });
    expect(planCatchUp(0, 5 * HOUR, "real_time")).toEqual({ apply: true, gapMs: 5 * HOUR });
  });

  it("counts a clock that went backwards, or didn't move, as no gap", () => {
    expect(planCatchUp(10 * HOUR, 9 * HOUR, "real_time")).toEqual({
      apply: false,
      reason: "no_gap",
    });
    expect(planCatchUp(HOUR, HOUR, "real_time")).toEqual({ apply: false, reason: "no_gap" });
  });

  it("treats a gap under 2 minutes as no gap", () => {
    expect(planCatchUp(0, SHORT_GAP_MS - 1, "real_time")).toEqual({
      apply: false,
      reason: "short_gap",
    });
    expect(planCatchUp(0, SHORT_GAP_MS, "real_time")).toEqual({
      apply: true,
      gapMs: SHORT_GAP_MS,
    });
  });

  it("does no catch-up in custom day mode", () => {
    expect(planCatchUp(0, 5 * HOUR, "custom_day")).toEqual({ apply: false, reason: "custom_day" });
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

  it("carries on exactly from the save in custom day mode, at the saved time of day", () => {
    const save = nightSave();
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 10 * HOUR,
      minutes: at(6, 10),
      clockMode: "custom_day",
    });
    expect(report.catchUp).toEqual({
      applied: false,
      skipped: "custom_day",
      gapMs: 0,
      failures: [],
    });
    const after = simulation.save(SAVED_AT);
    expect(after.creatures).toEqual(save.creatures);
    expect(after.minutes).toBe(save.minutes);
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
      // Up from 10:10 to 20:00, asleep since: tired, but less than at bedtime.
      expect(creature.needs[TIREDNESS]).toBeGreaterThan(0.2);
      expect(creature.needs[HUNGER]).toBeLessThan(hungerNeed.actAt);
    }
    const events = run(simulation, 20, at(22, 10));
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

  it("moves a release back by the gap, so the release grace counts the time away", () => {
    const simulation = create(5, at(21));
    expect(simulation.spawn(MOSSLING, undefined, { released: true }).ok).toBe(true);
    run(simulation, 60 * HZ, at(21));
    const save = throughDisk(simulation.save(SAVED_AT));
    const released = save.creatures[0]!.releasedAtTick!;

    // 3 minutes away: 4 minutes since the release, still in the grace, so awake.
    const short = restored(save, { nowMs: SAVED_AT + 3 * MINUTE, minutes: at(21, 4) });
    const [inGrace] = short.simulation.save(SAVED_AT).creatures;
    expect(inGrace!.releasedAtTick).toBe(released - 3 * 60 * HZ);
    expect(inGrace!.action).toBeUndefined();

    // An hour away: the grace is over, so it is put to bed.
    const long = restored(save, { nowMs: SAVED_AT + HOUR, minutes: at(22, 1) });
    const after = throughDisk(long.simulation.save(SAVED_AT));
    expect(after.creatures[0]!.releasedAtTick).toBe(released - 3600 * HZ);
    expect(after.creatures[0]!.action?.id).toBe("core:sleep");
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
    ["core:sleep", "core:rest", { placementId: null, x: 0, z: 0, path, arrived: 1 }],
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
      { placementId: null, x: 0, z: 0, path, arrived: true, asleep: true, nap: false },
    ],
  ])("keeps %s with a sound state", (id, behavior, state) => {
    const { after, report } = withAction({ id, behavior, state, startTick: 0 });
    expect(report.droppedActions).toEqual([]);
    expect(after.action?.state).toEqual(state);
  });
});
