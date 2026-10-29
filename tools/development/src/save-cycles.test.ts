import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { minutesAfter, SLEEPER_GAP, type Simulation } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { catchUpProblems, firstDifference, planRestores, saveThroughText } from "./save-cycles";
import { createSimulation, LIVING_BEHAVIOR_CHECKS, runWithInvariants } from "./simulation-run";

// The save and restore checks of the long runs (M15 PR 7). `pnpm soak` runs them over many seeds.

const HZ = 2;
const hollow = {
  register: registerBuiltInContent,
  worldId: "hollow:woodland-hollow",
  speciesId: "hollow:mossling",
};
const HOURS = 3600 * HZ;

describe("planRestores", () => {
  const options = { cycles: 4, compareTicks: 600, longGap: true };

  it("draws the same restores from the same seed, one per part, one after a long gap", () => {
    const planned = planRestores(3, 24 * HOURS, options);
    expect(planRestores(3, 24 * HOURS, options)).toEqual(planned);
    expect(planRestores(4, 24 * HOURS, options)).not.toEqual(planned);
    expect(planned).toHaveLength(4);
    planned.forEach(({ afterStep }, k) => {
      expect(afterStep).toBeGreaterThanOrEqual(k * 6 * HOURS);
      expect(afterStep + options.compareTicks).toBeLessThan((k + 1) * 6 * HOURS);
    });
    const gaps = planned.map((p) => p.gapMs).filter((gap) => gap > 0);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(gaps[0]).toBeLessThan(16 * 3_600_000);
  });

  it("plans no long gap unless asked", () => {
    const planned = planRestores(3, 24 * HOURS, { ...options, longGap: false });
    expect(planned.every((p) => p.gapMs === 0)).toBe(true);
  });
});

describe("a long run that saves and restores", () => {
  const slow = { timeout: 30_000 };

  it("restores every save and keeps every invariant", slow, () => {
    const report = runWithInvariants({
      ...hollow,
      seed: 2,
      ticks: 12 * HOURS,
      tickRateHz: HZ,
      creatures: 3,
      startMinutes: 18 * 60,
      ...LIVING_BEHAVIOR_CHECKS,
      saveRestore: { cycles: 3, compareTicks: 10 * 60 * HZ, longGap: true },
    });
    expect(report.violations).toEqual([]);
    expect(report.saveRestore).toMatchObject({
      restores: 3,
      comparedTicks: 2 * 10 * 60 * HZ,
      longGap: { gapMs: expect.any(Number) },
    });
  });

  it("reports a restored world that doesn't carry on as the unbroken one", () => {
    let first: Simulation | undefined;
    let changed = false;
    const report = runWithInvariants({
      ...hollow,
      seed: 2,
      ticks: 600,
      tickRateHz: HZ,
      creatures: 2,
      saveRestore: { cycles: 1, compareTicks: 100 },
      onTick: (simulation) => {
        first ??= simulation;
        // The first tick of the restored world: as if the save had lost a need's value.
        if (simulation !== first && !changed) {
          const creature = simulation.state.creatures.get("creature-1")!;
          creature.needs["core:hunger"] = (creature.needs["core:hunger"] ?? 0) + 0.01;
          changed = true;
        }
      },
    });
    expect(changed).toBe(true);
    expect(report.saveRestore.restores).toBe(1);
    expect(report.violations).toEqual([
      // Caught by the next decision's trace, or else by the state at the end of the comparison.
      expect.stringMatching(/the restored world differs from the unbroken run: at \/.*hunger/),
    ]);
  });
});

describe("catchUpProblems", () => {
  /** Mosslings in bed at 21:00, back after 3 hours, one step on. */
  function caughtUp() {
    const simulation = createSimulation({
      ...hollow,
      seed: 7,
      tickRateHz: HZ,
      startMinutes: 19 * 60 + 15,
    });
    for (let k = 0; k < 3; k++) simulation.spawn(hollow.speciesId);
    for (let k = 0; k < 105 * 60 * HZ; k++) {
      simulation.setTimeOfDay(minutesAfter(19 * 60 + 15, (simulation.tick * 1000) / HZ));
      simulation.step();
    }
    const saved = saveThroughText(simulation, 0);
    if (!saved.ok) throw new Error(saved.problem);
    const restored = createSimulation({ ...hollow, seed: 1, tickRateHz: HZ });
    const present = 24 * 60;
    const result = restored.restore(saved.save, { nowMs: 3 * 3_600_000, minutes: present });
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
    restored.setTimeOfDay(present);
    const events = restored.step();
    return { simulation: restored, save: saved.save, report: result.value, events };
  }

  it("passes a world caught up by the rules", { timeout: 30_000 }, () => {
    const { simulation, save, report, events } = caughtUp();
    expect(catchUpProblems(simulation, save, report, events, () => true)).toEqual([]);
  });

  it("expects a sleeper at its home's spot clear of the others asleep (issue #158)", () => {
    const { simulation, save, report, events } = caughtUp();
    const [creature, other] = simulation.state.creatures.values();
    const home = creature!.home!;
    const plain = simulation.spotFor(creature!.id, home)!;
    // Another sleeper lies at its plain spot, so its spot there is the next clear one.
    other!.asleep = true;
    other!.position = { ...plain };
    const clear = simulation.spotFor(creature!.id, home, { clearOfSleepers: SLEEPER_GAP })!;
    expect(clear).not.toEqual(plain);
    const problems = (at: typeof plain) => {
      creature!.position = { ...at };
      return catchUpProblems(simulation, save, report, events, (c) => c.id === creature!.id);
    };
    expect(problems(clear)).toEqual([]);
    expect(problems(plain)).toEqual([
      expect.stringContaining(`${creature!.id}: away from its home`),
    ]);
  });

  it("finds a creature awake at night, away from home, unfed, and announced events", () => {
    const { simulation, save, report } = caughtUp();
    const creature = [...simulation.state.creatures.values()][0]!;
    creature.asleep = false;
    creature.needs["core:hunger"] = 0.95;
    expect(creature.home).not.toBeNull();
    creature.position = { ...creature.position, x: creature.position.x + 1 };
    const events = [{ type: "woke_up" as const, tick: simulation.tick, creatureId: creature.id }];
    const problems = catchUpProblems(
      simulation,
      save,
      report,
      events as never,
      (c) => c.id === creature.id,
    );
    expect(problems).toEqual([
      expect.stringContaining("first step after catch-up emitted"),
      expect.stringContaining(`${creature.id}: hunger 0.95`),
      expect.stringContaining(`${creature.id}: awake at its night`),
      expect.stringContaining(`${creature.id}: away from its home`),
    ]);
  });
});

describe("firstDifference", () => {
  it("names the path of the first difference", () => {
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBeUndefined();
    expect(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(
      "at /a/1/b: expected 2, got 3",
    );
    expect(firstDifference({ a: [] }, {})).toBe("at /a: expected [], got missing");
  });
});
