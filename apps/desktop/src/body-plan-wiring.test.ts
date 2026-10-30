import {
  formatDiagnostic,
  type Drawing,
  type Result,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import { createMemoryLibraryStore } from "@living-diorama/desktop-integration";
import { Simulation } from "@living-diorama/simulation";
import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import { checkAssemblyTypes } from "@living-diorama/extension-api";
import { describe, expect, it } from "vitest";
import {
  defaultPlan,
  locomotionCapabilities,
  type BodyPlanChoice,
  type LocomotionChoice,
} from "./body-plan";
import { VOXEL_SAMPLE_PLANS, type VoxelSamplePlan } from "./dev-library";
import { loadContent } from "./content";
import { openSpeciesLibrary, type LibraryWorld } from "./species-library";
import { STARTUP } from "./startup";

// A released body plan reaches the running world (ADR 0020 §14): saved through the species library
// as the Studio's release does, into a headless simulation of the startup world.

const PNG = new Uint8Array([137, 80, 78, 71]);
const DRAWING: Drawing = {
  schemaVersion: 2,
  canvas: { width: 256, height: 256 },
  history: [{ kind: "stroke", tool: "pen", color: "#336633", width: 12, points: [10, 10, 1] }],
};

function headlessWorld() {
  const content = loadContent();
  if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
  const created = Simulation.create(content.value, { worldId: STARTUP.worldId, seed: 3 });
  if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
  const simulation = created.value;
  const world: LibraryWorld = {
    registerSpecies: (species, url, kind) => {
      const registered = simulation.registerSpecies(species, url, kind);
      return Promise.resolve(
        registered.ok
          ? {
              ok: true as const,
              value: { speciesId: registered.value.species.id, limits: registered.value.limits },
            }
          : registered,
      );
    },
    spawn: (speciesId, { released = false } = {}) => {
      const spawned = simulation.spawn(speciesId, undefined, { released });
      return Promise.resolve(spawned.ok ? { ok: true as const, value: spawned.value.id } : spawned);
    },
    despawn: (creatureId) => {
      const despawned = simulation.despawn(creatureId);
      return Promise.resolve(despawned.ok ? { ok: true as const, value: creatureId } : despawned);
    },
    creatures: () => [...simulation.state.creatures.values()],
    checkAssembly: (assembly) =>
      Promise.resolve({
        ok: true as const,
        value: checkAssemblyTypes(simulation.state.registries, assembly as VoxelAssembly),
      }),
  };
  return { simulation, world };
}

const value = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
};

describe("a released body plan", () => {
  it("gives the creature its gait and capabilities in the world", async () => {
    const { simulation, world } = headlessWorld();
    const library = await openSpeciesLibrary(createMemoryLibraryStore(), world);
    const release = async (name: string, plan: BodyPlanChoice) => {
      const { speciesId } = value(
        await library.save(DRAWING, PNG, name, "medium", { thickness: 0.4, plan }),
      );
      const id = value(await library.addCreature(speciesId));
      const creature = simulation.snapshot().creatures.find((c) => c.id === id);
      const kind = simulation.state.model.regions.get(creature?.position.regionId ?? "")?.kind;
      return { species: simulation.state.registries.species.get(speciesId), creature, kind };
    };

    // Released walkers and hoppers appear at a spawn point on land.
    const hopper = await release("Hopper", {
      locomotion: { land: true, gait: "hop", swim: false },
      anchors: {},
    });
    expect(hopper.species?.capabilities).toEqual({ "core:land": 1 });
    expect(hopper.species?.body.locomotion.land.gait).toBe("hop");
    expect(hopper.kind).not.toBe("water");
    expect(hopper.creature).toMatchObject({ animation: "hop", submersion: 0 });

    const amphibian = await release("Newt", {
      locomotion: { land: true, gait: "walk", swim: true },
      anchors: { centerOfGravity: { x: 120, y: 200 }, tail: { x: 40, y: 180 } },
    });
    expect(amphibian.species?.capabilities).toEqual({ "core:land": 1, "core:swim": 1 });
    expect(amphibian.species?.body).toMatchObject({
      anchors: { centerOfGravity: { x: 120, y: 200 }, tail: { x: 40, y: 180 } },
    });
    // It may appear on land or at the river's spawn point; either way it moves as it should there.
    expect(amphibian.creature).toMatchObject(
      amphibian.kind === "water"
        ? { animation: "swim", submersion: 0.5 }
        : { animation: "walk", submersion: 0 },
    );
  });

  it("puts a water-only creature in the water, at the river's spawn point", async () => {
    const { simulation, world } = headlessWorld();
    const library = await openSpeciesLibrary(createMemoryLibraryStore(), world);
    const saved = await library.save(DRAWING, PNG, "Minnow", "small", {
      plan: { ...defaultPlan(), locomotion: { land: false, gait: "walk", swim: true } },
    });
    const { speciesId } = value(saved);
    const id = value(await library.addCreature(speciesId));
    const species = simulation.state.registries.species.get(speciesId);
    expect(species?.capabilities).toEqual({ "core:swim": 1 });
    const creature = simulation.snapshot().creatures.find((c) => c.id === id);
    expect(simulation.state.model.regions.get(creature?.position.regionId ?? "")?.kind).toBe(
      "water",
    );
    expect(creature).toMatchObject({
      animation: "swim",
      submersion: 0.5,
    });
  });
});

describe("a voxel creature", () => {
  const plans = VOXEL_SAMPLE_PLANS;
  /** How each plan's creature may move where it appears: in the water, or on land. */
  const animations: Record<VoxelSamplePlan, string[]> = {
    walk: ["walk"],
    hop: ["hop"],
    swim: ["swim"],
    "land+swim": ["walk", "swim"],
  };

  it("moves as its body plan says, with its size class measured from its cubes", async () => {
    const { simulation, world } = headlessWorld();
    const library = await openSpeciesLibrary(createMemoryLibraryStore(), world);
    for (const [name, locomotion] of Object.entries(plans) as [
      VoxelSamplePlan,
      LocomotionChoice,
    ][]) {
      const saved = value(await library.saveVoxel(sampleVoxelAssembly(), name, { locomotion }));
      expect(saved).toMatchObject({ body: "voxel", sizeClass: "small", available: true });
      const species = simulation.state.registries.species.get(saved.speciesId);
      expect(species?.body.locomotion.land.gait).toBe(locomotion.gait);
      expect(species?.capabilities).toEqual(locomotionCapabilities(locomotion));
      expect(simulation.state.registries.assets.get(species?.appearance ?? "")?.kind).toBe("voxel");
      const id = value(await library.addCreature(saved.speciesId));
      const creature = simulation.snapshot().creatures.find((c) => c.id === id);
      expect(animations[name]).toContain(creature?.animation);
    }
  });

  it("is kept through a save and a relaunch, its species registered before the restore", async () => {
    const store = createMemoryLibraryStore();
    const first = headlessWorld();
    const library = await openSpeciesLibrary(store, first.world);
    const { speciesId } = value(
      await library.saveVoxel(sampleVoxelAssembly(), "Pebble", { locomotion: plans.hop }),
    );
    const id = value(await library.addCreature(speciesId));
    const saved = first.simulation.save(0);

    // A relaunch: the library registers its species, then the world is restored, as in the app.
    const second = headlessWorld();
    const reopened = await openSpeciesLibrary(store, second.world);
    expect(reopened.list()).toMatchObject([{ speciesId, body: "voxel", available: true }]);
    const report = value(second.simulation.restore(saved, { nowMs: 0, minutes: 12 * 60 }));
    expect(report.droppedCreatures).toEqual([]);
    expect(second.simulation.state.creatures.get(id)?.speciesId).toBe(speciesId);

    // Restored before the library registers it, the creature would be dropped.
    const early = headlessWorld();
    const dropped = value(early.simulation.restore(saved, { nowMs: 0, minutes: 12 * 60 }));
    expect(dropped.droppedCreatures).toMatchObject([{ creatureId: id, reason: "species_missing" }]);
  });

  it("is refused at release when a part doesn't fit its socket", async () => {
    const { world } = headlessWorld();
    const store = createMemoryLibraryStore();
    const library = await openSpeciesLibrary(store, world);
    const assembly = sampleVoxelAssembly();
    const leg = assembly.parts.leg;
    if (!leg) throw new Error("No leg");
    // Arms fit shoulders, not the back legs' hips.
    leg.type = "hollow:arm";
    const refused = await library.saveVoxel(assembly, "Misfit", { locomotion: plans.walk });
    expect(refused.ok ? [] : refused.diagnostics.map((d) => d.code)).toContain("part_does_not_fit");
    expect(await store.list()).toEqual([]);
  });
});
