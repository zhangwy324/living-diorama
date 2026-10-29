import { formatDiagnostic, type Drawing, type Result } from "@living-diorama/content-schema";
import { createMemoryLibraryStore } from "@living-diorama/desktop-integration";
import { Simulation } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { templatePlan, type BodyPlanChoice } from "./body-plan";
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
    registerSpecies: (species, url) => {
      const registered = simulation.registerSpecies(species, url);
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
    const hopper = await release("Hopper", templatePlan("hopper"));
    expect(hopper.species?.capabilities).toEqual({ "core:land": 1 });
    expect(hopper.species?.body.locomotion.land.gait).toBe("hop");
    expect(hopper.kind).not.toBe("water");
    expect(hopper.creature).toMatchObject({ animation: "hop", submersion: 0 });

    const amphibian = await release("Newt", {
      ...templatePlan("walker"),
      locomotion: { land: true, gait: "walk", swim: true },
      anchors: { centerOfGravity: { x: 120, y: 200 } },
    });
    expect(amphibian.species?.capabilities).toEqual({ "core:land": 1, "core:swim": 1 });
    expect(amphibian.species?.body).toMatchObject({
      template: "walker",
      anchors: { centerOfGravity: { x: 120, y: 200 } },
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
      plan: templatePlan("swimmer"),
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
