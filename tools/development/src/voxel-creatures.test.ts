import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import { measureAssembly, VoxelAssemblySchema } from "@living-diorama/content-schema";
import { checkAssemblyTypes } from "@living-diorama/extension-api";
import { minutesAfter, type Simulation } from "@living-diorama/simulation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerHollowCreatures } from "./fixtures/hollow-creatures";
import { VOXEL_PLANS, VOXEL_SPECIES, type VoxelPlan } from "./fixtures/voxel-creatures";
import { firstDifference, restoreProblems, saveThroughText } from "./save-cycles";
import {
  createSimulation,
  LIVING_BEHAVIOR_CHECKS,
  loadContent,
  runWithInvariants,
} from "./simulation-run";

// Voxel creatures in the headless world (ADR 0022, M19): the sample voxel creature registered as
// the app registers a library species, with the appearance kind `voxel` and a URL nothing reads,
// one species per body plan. They save and restore when registered again before the restore, as
// the app does, and the simulation never sees a cube.

const HZ = 2;
const START = 12 * 60;
const PLANS = Object.keys(VOXEL_PLANS) as VoxelPlan[];
const ALL = Object.values(VOXEL_SPECIES);
const hollow = {
  register: registerHollowCreatures,
  worldId: "hollow:woodland-hollow",
  tickRateHz: HZ,
  startMinutes: START,
};

/** Runs `ticks` ticks with the time of day following simulation time from START. */
function run(simulation: Simulation, ticks: number) {
  for (let k = 0; k < ticks; k++) {
    simulation.setTimeOfDay(minutesAfter(START, (simulation.tick * 1000) / HZ));
    simulation.step();
  }
}

/** A world with one creature of each voxel species, run for `ticks` ticks. */
function populated(ticks: number): Simulation {
  const simulation = createSimulation({ ...hollow, seed: 5, runtimeSpecies: ALL });
  for (const { input } of ALL) expect(simulation.spawn(input.id).ok).toBe(true);
  run(simulation, ticks);
  return simulation;
}

afterEach(() => vi.restoreAllMocks());

describe("the voxel fixture species", () => {
  it("take their size class from the sample's cubes, and its types fit the built-in pack", () => {
    const assembly = sampleVoxelAssembly();
    expect(VoxelAssemblySchema.safeParse(assembly).success).toBe(true);
    const { sizeClass } = measureAssembly(assembly);
    for (const { input } of ALL) expect(input.sizeClass).toBe(sizeClass);
    const content = loadContent(registerHollowCreatures);
    if (!content.ok) throw new Error("content failed to load");
    expect(
      checkAssemblyTypes(content.value, assembly).filter((d) => d.severity === "error"),
    ).toEqual([]);
  });

  it.each(PLANS)("move as the %s plan says", (plan) => {
    const { land, gait, swim } = VOXEL_PLANS[plan];
    const { input } = VOXEL_SPECIES[plan];
    expect(Object.keys(input.capabilities as object).sort()).toEqual(
      [...(land ? ["core:land"] : []), ...(swim ? ["core:swim"] : [])].sort(),
    );
    expect(input.body).toEqual({ locomotion: { land: { gait } } });
  });

  it("register their appearance as a voxel asset, by URL only", () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const simulation = createSimulation({ ...hollow, seed: 1, runtimeSpecies: ALL });
    const { registries } = simulation.state;
    for (const { input, url } of ALL) {
      const asset = registries.assets.get(`${input.id}/assembly.json`);
      expect(asset).toMatchObject({ kind: "voxel", url });
      expect(Object.keys(asset ?? {}).sort()).toEqual(["id", "kind", "url", "version"]);
    }
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe("voxel creatures saved and restored", () => {
  it("come back when their species are registered again first, and carry on as before", () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const simulation = populated(600);
    const saved = saveThroughText(simulation, Date.UTC(2026, 9, 30, 12));
    if (!saved.ok) throw new Error(saved.problem);
    expect(saved.save.creatures.map((c) => c.speciesId).sort()).toEqual(
      ALL.map((s) => s.input.id).sort(),
    );

    // A fresh world of another seed, as the app's after a relaunch: library species first.
    const fresh = createSimulation({ ...hollow, seed: 99, runtimeSpecies: ALL });
    const restored = fresh.restore(saved.save, {
      nowMs: saved.save.savedAt,
      minutes: minutesAfter(START, (simulation.tick * 1000) / HZ),
    });
    if (!restored.ok) throw new Error("restore failed");
    expect(restoreProblems(restored.value)).toEqual([]);
    run(simulation, 600);
    run(fresh, 600);
    expect(firstDifference(fresh.snapshot(), simulation.snapshot())).toBeUndefined();
    expect(fetched).not.toHaveBeenCalled();
  });

  it("are dropped as species_missing if their species aren't registered again", () => {
    const saved = saveThroughText(populated(10), 0);
    if (!saved.ok) throw new Error(saved.problem);
    const fresh = createSimulation({ ...hollow, seed: 99 });
    const restored = fresh.restore(saved.save, { nowMs: 0, minutes: START });
    if (!restored.ok) throw new Error("restore failed");
    expect(restored.value.droppedCreatures.map((d) => d.reason)).toEqual(
      ALL.map(() => "species_missing"),
    );
  });

  it("never put a cube into the save", () => {
    const saved = saveThroughText(populated(10), 0);
    if (!saved.ok) throw new Error(saved.problem);
    const text = JSON.stringify(saved.save);
    for (const key of ["voxels", "instances", "sockets", "assembly"]) {
      expect(text).not.toContain(`"${key}"`);
    }
  });

  it("keep every invariant over half a day of saves and restores", { timeout: 60_000 }, () => {
    const report = runWithInvariants({
      ...hollow,
      speciesId: VOXEL_SPECIES["land+swim"].input.id,
      seed: 3,
      ticks: 12 * 3600 * HZ,
      creatures: 1,
      startMinutes: 18 * 60,
      alsoSpawn: { [VOXEL_SPECIES.hop.input.id]: 1, [VOXEL_SPECIES.swim.input.id]: 1 },
      runtimeSpecies: ALL,
      ...LIVING_BEHAVIOR_CHECKS,
      saveRestore: { cycles: 3, compareTicks: 10 * 60 * HZ, longGap: true },
    });
    expect(report.violations).toEqual([]);
    expect(report.saveRestore.restores).toBe(3);
    expect(Object.keys(report.creatures)).toHaveLength(3);
  });
});
