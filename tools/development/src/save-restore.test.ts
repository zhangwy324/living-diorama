import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { parseWorldSave, type WorldSave } from "@living-diorama/content-schema";
import {
  checkSave,
  feedBehavior,
  minutesAfter,
  type BehaviorProvider,
  type Simulation,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { createSimulation } from "./simulation-run";

// Engine save and restore (ADR 0019 §7, §8; M15 PR 2): a save is plain data the schema accepts,
// restoring and carrying on equals an unbroken run, and a save that doesn't fit the world is
// discarded or trimmed, never a crash.

const HZ = 2;
const WORLD = "hollow:woodland-hollow";
const MOSSLING = "hollow:mossling";
const START = 19 * 60 + 15;
const SAVED_AT = Date.UTC(2026, 9, 28, 19, 45);

const create = (seed: number, minutes = 12 * 60) =>
  createSimulation({
    register: registerBuiltInContent,
    worldId: WORLD,
    seed,
    tickRateHz: HZ,
    startMinutes: minutes,
  });

/** The time of day `tick` ticks into a run from START, as a main thread at speed 1 would send. */
const minutesAt = (tick: number) => minutesAfter(START, (tick * 1000) / HZ);

/** Runs `ticks` ticks with the time of day following simulation time; events per tick. */
function run(simulation: Simulation, ticks: number, onTick?: (tick: number) => void) {
  const events: SimulationEvent[][] = [];
  for (let k = 0; k < ticks; k++) {
    onTick?.(simulation.tick);
    simulation.setTimeOfDay(minutesAt(simulation.tick));
    events.push(simulation.step());
  }
  return events;
}

/** A world with three mosslings, one more spawned and despawned, run for `ticks` ticks. */
function populated(ticks: number, seed = 7): Simulation {
  const simulation = create(seed, START);
  for (let k = 0; k < 4; k++) expect(simulation.spawn(MOSSLING).ok).toBe(true);
  expect(simulation.despawn("creature-2").ok).toBe(true);
  run(simulation, ticks);
  return simulation;
}

/** What a save goes through on disk: JSON and back, then the schema. */
function throughDisk(save: WorldSave): WorldSave {
  const parsed = parseWorldSave(JSON.parse(JSON.stringify(save)));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
  return parsed.value;
}

/** A fresh world, of another seed and time of day, with `save` restored into it. */
function restored(save: WorldSave, options = { nowMs: save.savedAt, minutes: save.minutes }) {
  const simulation = create(999);
  const result = simulation.restore(save, options);
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return { simulation, report: result.value };
}

describe("world save", () => {
  it("is plain data the schema accepts, unchanged by a JSON round trip", () => {
    const simulation = populated(600);
    const save = simulation.save(SAVED_AT);
    expect(parseWorldSave(save).ok).toBe(true);
    expect(throughDisk(save)).toEqual(save);
    expect(save).toMatchObject({
      savedAt: SAVED_AT,
      world: { id: WORLD, version: expect.any(String) },
      seed: 7,
      tick: 600,
      nextCreature: 5,
      introducedSpecies: [MOSSLING],
      species: { [MOSSLING]: expect.any(String) },
    });
    expect(save.creatures.map((c) => c.id)).toEqual(["creature-1", "creature-3", "creature-4"]);
  });

  it("is a copy: running on doesn't change it", () => {
    const simulation = populated(10);
    const save = simulation.save(SAVED_AT);
    const before = JSON.stringify(save);
    run(simulation, 200);
    expect(JSON.stringify(save)).toBe(before);
  });
});

describe("restore", () => {
  it("then carrying on equals an unbroken run, spawns included", () => {
    const N = 1800; // 19:15 to 19:30
    const M = 4000; // 19:30 to 20:03
    const spawnAt = N + 100;
    const spawnLater = (simulation: Simulation) => (tick: number) => {
      // A random spawn point, so the world stream must have been restored too.
      if (tick === spawnAt) expect(simulation.spawn(MOSSLING).ok).toBe(true);
    };

    const unbroken = populated(N);
    const save = throughDisk(unbroken.save(SAVED_AT));
    const expected = run(unbroken, M, spawnLater(unbroken));

    const { simulation, report } = restored(save);
    expect(report).toEqual({
      gapMs: 0,
      droppedCreatures: [],
      prunedPlacements: [],
      droppedActions: [],
      catchUp: { applied: false, skipped: "no_gap", gapMs: 0, failures: [] },
    });
    const actual = run(simulation, M, spawnLater(simulation));

    expect(actual).toEqual(expected);
    // The run crosses dusk into night after the restore.
    expect(actual.flat().some((e) => e.type === "day_phase_changed")).toBe(true);
    expect(simulation.save(0)).toEqual(unbroken.save(0));
    expect(simulation.snapshot({ debug: true })).toEqual(unbroken.snapshot({ debug: true }));
  });

  it("never reuses a creature ID", () => {
    const { simulation } = restored(throughDisk(populated(20).save(SAVED_AT)));
    const spawned = simulation.spawn(MOSSLING);
    expect(spawned.ok && spawned.value.id).toBe("creature-5");
    // `species_introduced` fired before the save, so not again.
    const spawnEvents = simulation
      .step()
      .filter((e) => e.type.endsWith("spawned") || e.type === "species_introduced");
    expect(spawnEvents.map((e) => e.type)).toEqual(["creature_spawned"]);
  });

  it("emits no day-phase change when the phase hasn't changed", () => {
    // Saved at night; the fresh world it's restored into was at noon.
    const night = populated(0);
    night.setTimeOfDay(22 * 60);
    night.step();
    const save = night.save(SAVED_AT);
    expect(save.dayPhase).toBe("night");
    const { simulation, report } = restored(save, {
      nowMs: SAVED_AT + 60_000,
      minutes: 22 * 60 + 1,
    });
    expect(report.gapMs).toBe(60_000);
    expect(simulation.snapshot().timeOfDay).toBe(22 * 60 + 1);
    expect(simulation.step().filter((e) => e.type === "day_phase_changed")).toEqual([]);
  });

  it("announces a phase change that really happened since the save, once", () => {
    const night = populated(0);
    night.setTimeOfDay(22 * 60);
    night.step();
    const { simulation } = restored(night.save(SAVED_AT), { nowMs: SAVED_AT, minutes: 9 * 60 });
    const changes = [...simulation.step(), ...simulation.step()].filter(
      (e) => e.type === "day_phase_changed",
    );
    expect(changes).toEqual([{ type: "day_phase_changed", tick: 1, from: "night", to: "day" }]);
  });

  it("keeps a day phase that lags the time of day, as the unbroken run does", () => {
    const dusk = populated(0);
    dusk.setTimeOfDay(19 * 60 + 59);
    dusk.step();
    dusk.setTimeOfDay(20 * 60 + 1); // Not yet taken up by a step.
    const save = dusk.save(SAVED_AT);
    expect(save).toMatchObject({ minutes: 20 * 60 + 1, dayPhase: "dusk" });
    const { simulation } = restored(save);
    expect(simulation.step().filter((e) => e.type === "day_phase_changed")).toEqual([
      { type: "day_phase_changed", tick: 1, from: "dusk", to: "night" },
    ]);
  });

  it("counts a clock that went backwards as no gap", () => {
    const save = populated(0).save(SAVED_AT);
    expect(restored(save, { nowMs: SAVED_AT - 5000, minutes: 12 * 60 }).report.gapMs).toBe(0);
  });
});

describe("a save that doesn't fit the world", () => {
  const base = () => throughDisk(populated(300).save(SAVED_AT));

  /** Restores `save` into a fresh world with one creature; the world must be unchanged on failure. */
  function rejected(save: WorldSave, code: string) {
    const simulation = create(1);
    simulation.spawn(MOSSLING);
    const before = simulation.save(0);
    const result = simulation.restore(save, { nowMs: SAVED_AT, minutes: 12 * 60 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostics.map((d) => d.code)).toEqual([code]);
    expect(simulation.save(0)).toEqual(before);
  }

  it("is discarded whole when it is of another world or world version", () => {
    rejected(
      { ...base(), world: { ...base().world, id: "hollow:elsewhere" } },
      "save_world_mismatch",
    );
    rejected({ ...base(), world: { ...base().world, version: "9.9.9" } }, "save_world_mismatch");
  });

  it("is discarded whole when its fields disagree", () => {
    rejected({ ...base(), species: {} }, "save_inconsistent");
    const save = base();
    rejected(
      { ...save, species: { [MOSSLING]: `${save.species[MOSSLING]}-other` } },
      "save_inconsistent",
    );
    rejected({ ...save, nextCreature: 4 }, "save_inconsistent");
  });

  it("drops creatures whose species is missing or of another major version", () => {
    const save = base();
    const [first, second, third] = save.creatures;
    const registered = save.species[MOSSLING]!;
    const [major, minor] = registered.split(".").map(Number);
    const sameMajor = `${major}.${minor! + 1}.0`;
    const otherMajor = `${major! + 1}.0.0`;
    first!.speciesId = "hollow:ghost";
    second!.speciesVersion = otherMajor;
    third!.speciesVersion = sameMajor;
    // Two versions of one species can't both be listed; give the newer ones their own species.
    const { report, simulation } = restored({
      ...save,
      species: { "hollow:ghost": first!.speciesVersion, [MOSSLING]: otherMajor },
      creatures: [first!, second!],
    });
    expect(report.droppedCreatures).toEqual([
      {
        creatureId: first!.id,
        speciesId: "hollow:ghost",
        speciesVersion: first!.speciesVersion,
        reason: "species_missing",
      },
      {
        creatureId: second!.id,
        speciesId: MOSSLING,
        speciesVersion: otherMajor,
        reason: "species_major_mismatch",
        registeredVersion: registered,
      },
    ]);
    expect(simulation.snapshot().creatures).toEqual([]);

    const kept = restored({ ...save, species: { [MOSSLING]: sameMajor }, creatures: [third!] });
    expect(kept.report.droppedCreatures).toEqual([]);
    expect(kept.simulation.snapshot().creatures.map((c) => c.id)).toEqual([third!.id]);
    // Nothing drops a creature after the restore either.
    run(kept.simulation, 50);
  });

  it("loses references to placements the world no longer has", () => {
    const save = base();
    const creature = save.creatures[0]!;
    const known = Object.values(creature.knowledge.places).flat();
    creature.home = "gone-home";
    creature.knowledge.places["core:food"] = [
      ...(creature.knowledge.places["core:food"] ?? []),
      { placementId: "gone-food", lastSeenTick: 1 },
    ];
    creature.usedStructures.push("gone-bridge");
    creature.memory["core:feed"] = { target: "gone-food", avoid: { "gone-food": 999 } };
    const { simulation, report } = restored(save);
    expect(report.prunedPlacements).toEqual([
      { creatureId: creature.id, placementId: "gone-home", where: "home" },
      { creatureId: creature.id, placementId: "gone-food", where: "knowledge" },
      { creatureId: creature.id, placementId: "gone-bridge", where: "used_structures" },
    ]);
    const after = simulation.save(0).creatures[0]!;
    expect(after.home).toBeNull();
    expect(Object.values(after.knowledge.places).flat()).toEqual(known);
    expect(after.usedStructures).not.toContain("gone-bridge");
    // `core:feed` forgets the placement in its own memory.
    expect(after.memory["core:feed"]).toEqual({ avoid: {} });
    run(simulation, 50);
  });

  it("takes a creature of another version of the same major to the registered version", () => {
    const save = base();
    const registered = save.species[MOSSLING]!;
    const older = `${registered}-old`;
    for (const c of save.creatures) c.speciesVersion = older;
    const first = restored(throughDisk({ ...save, species: { [MOSSLING]: older } }));
    expect(first.report.droppedCreatures).toEqual([]);
    expect(first.simulation.spawn(MOSSLING).ok).toBe(true);
    // The next save lists one version of the species, which every creature is of.
    const next = throughDisk(first.simulation.save(SAVED_AT));
    expect(next.species).toEqual({ [MOSSLING]: registered });
    expect(new Set(next.creatures.map((c) => c.speciesVersion))).toEqual(new Set([registered]));
    const second = restored(next);
    expect(second.report.droppedCreatures).toEqual([]);
    expect(second.simulation.snapshot().creatures).toHaveLength(save.creatures.length + 1);
  });

  it("loses a behavior's memory when the behavior fails to prune it", () => {
    const simulation = create(1);
    const save = base();
    const creature = save.creatures[0]!;
    creature.memory = { "core:feed": { target: "x" }, "core:wander": { kept: true } };
    const failing: BehaviorProvider = {
      ...feedBehavior,
      forgetPlacements: () => {
        throw new Error("unexpected memory");
      },
    };
    const checked = checkSave(
      save,
      simulation.state.model,
      simulation.state.registries,
      new Map([[failing.id, failing]]),
      new Map(),
    );
    expect(checked.ok && checked.value.creatures[0]!.memory).toEqual({
      "core:wander": { kept: true },
    });
  });
});
