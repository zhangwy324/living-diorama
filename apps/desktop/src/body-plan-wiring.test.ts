import { formatDiagnostic, type Result, type VoxelAssembly } from "@living-diorama/content-schema";
import { createMemoryLibraryStore } from "@living-diorama/desktop-integration";
import { Simulation } from "@living-diorama/simulation";
import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import { checkAssemblyTypes } from "@living-diorama/extension-api";
import { describe, expect, it } from "vitest";
import { locomotionCapabilities, type LocomotionChoice } from "./body-plan";
import { VOXEL_SAMPLE_PLANS, type VoxelSamplePlan } from "./dev-library";
import { loadContent } from "./content";
import { openSpeciesLibrary, type LibraryWorld } from "./species-library";
import { STARTUP } from "./startup";

// A released body plan reaches the running world (ADR 0020 §14): saved through the species library
// as the Studio's release does, into a headless simulation of the startup world.

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
      expect(saved).toMatchObject({ sizeClass: "medium", available: true });
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
    expect(reopened.list()).toMatchObject([{ speciesId, available: true }]);
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
    // Arms fit shoulders, not the legs' mounts.
    leg.type = "hollow:arm";
    const refused = await library.saveVoxel(assembly, "Misfit", { locomotion: plans.walk });
    expect(refused.ok ? [] : refused.diagnostics.map((d) => d.code)).toContain("part_does_not_fit");
    expect(await store.list()).toEqual([]);
  });
});
