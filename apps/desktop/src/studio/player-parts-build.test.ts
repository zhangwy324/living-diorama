import { formatDiagnostic, type VoxelAssembly } from "@living-diorama/content-schema";
import { createMemoryLibraryStore } from "@living-diorama/desktop-integration";
import { checkAssemblyTypes } from "@living-diorama/extension-api";
import { Simulation } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { loadContent } from "../content";
import { openSpeciesLibrary, type LibraryWorld } from "../species-library";
import { STARTUP } from "../startup";
import {
  fillEmpty,
  pickPart,
  placeAt,
  randomize,
  startBuild,
  type BuildState,
} from "./assembly-state";
import { builtInParts } from "./fixtures/built-in-parts";
import { drawnPartEntry } from "./fixtures/player-parts";
import { partsKit, withPlayerParts } from "./parts-kit";
import { playerPartSummary } from "./player-parts";

// Building with the player's own parts (ADR 0025 §9, §10): they sit in the tray beside the packs'
// parts and are placed by hand as those are, but Randomize and Fill empty never use them, and a
// creature built with them is released as any other.

const studioParts = builtInParts();
const packKit = partsKit(studioParts);
if (!packKit) throw new Error("No kit");
const UUID = "00000000-0000-4000-8000-0000000000aa";
const stiltEntry = drawnPartEntry(studioParts, { uuid: UUID, type: "hollow:leg", name: "Stilt" });
const stilt = playerPartSummary(stiltEntry);
const blob = playerPartSummary(
  drawnPartEntry(studioParts, {
    uuid: "00000000-0000-4000-8000-0000000000bb",
    type: "hollow:torso",
    name: "Blob",
    width: 20,
    height: 12,
    createdAt: "2026-10-30T12:01:00.000Z",
  }),
);
const kit = withPlayerParts(packKit, [stilt, blob]);
const present = (state: BuildState) => state.history.present;
const sources = (assembly: VoxelAssembly) =>
  Object.values(assembly.parts).map((part) => part.source);
const ROOT = packKit.start.instances[0]?.id ?? "";

/** The default torso with the stilts on its back legs, placed by hand. */
function withStilts(on = kit) {
  const picked = pickPart(startBuild(on), on, stilt.id);
  expect(picked.picked).toBe(stilt.id);
  return placeAt(picked, on, { instance: ROOT, socket: "back-left" });
}

describe("the tray with the player's parts", () => {
  it("lists each after the packs' parts of its type, and nowhere else", () => {
    const legs = kit.sections.find((section) => section.type === "hollow:leg");
    const torsos = kit.sections.find((section) => section.type === "hollow:torso");
    expect(legs?.parts).toEqual(packKit.sections.find((s) => s.type === "hollow:leg")?.parts);
    expect(legs?.mine).toEqual([stilt]);
    expect(torsos?.mine).toEqual([blob]);
    expect(kit.sections.flatMap((section) => section.mine)).toHaveLength(2);
    // The order of the sections doesn't change.
    expect(kit.sections.map((s) => s.type)).toEqual(packKit.sections.map((s) => s.type));
    expect(kit.byId.get(stilt.id)).toBe(stilt);
  });

  it("leaves out a part of a type with no section, and is the packs' kit with none", () => {
    const stray = { ...stilt, id: "user-part:x", part: { ...stilt.part, type: "other:wing" } };
    const withStray = withPlayerParts(packKit, [stilt, stray]);
    expect(withStray.sections.flatMap((s) => s.mine)).toEqual([stilt]);
    // Not pickable either: what can be picked is what the tray shows.
    expect(withStray.byId.has(stray.id)).toBe(false);
    expect(withPlayerParts(packKit, [stray])).toBe(packKit);
    expect(withPlayerParts(packKit, [])).toBe(packKit);
  });
});

describe("placing a player part", () => {
  it("takes a frozen copy, as a pack part is taken", () => {
    const placed = withStilts();
    expect(sources(present(placed))).toContain(stilt.id);
    const copy = Object.values(present(placed).parts).find((part) => part.source === stilt.id);
    expect(copy?.voxels).toEqual(stilt.part.voxels);
    expect(
      present(placed).instances.filter((i) => i.part !== present(placed).instances[0]?.part),
    ).toHaveLength(2);
  });

  it("swaps the torso for a drawn one", () => {
    const swapped = pickPart(startBuild(kit), kit, blob.id);
    expect(sources(present(swapped))).toEqual([blob.id]);
  });

  it("keeps the copy it holds when the part is edited, and places the new version after", () => {
    const placed = withStilts();
    const longer = playerPartSummary(
      drawnPartEntry(studioParts, {
        uuid: UUID,
        type: "hollow:leg",
        name: "Stilt",
        version: 2,
        height: 20,
      }),
    );
    const edited = withPlayerParts(packKit, [longer, blob]);
    // The assembly in progress still holds the first version.
    const held = () =>
      Object.values(present(placed).parts).filter((part) => part.source === stilt.id);
    expect(held().map((part) => part.size)).toEqual([stilt.part.size]);
    // Picked again, it has one place left, the front legs, and the new version goes there.
    const front = pickPart(placed, edited, longer.id);
    expect(front.picked).toBeUndefined();
    const copies = Object.values(present(front).parts).filter((p) => p.source === stilt.id);
    expect(copies.map((part) => part.size)).toEqual([stilt.part.size, longer.part.size]);
  });
});

describe("Randomize and Fill empty", () => {
  it("never use the player's parts", () => {
    for (let seed = 0; seed < 40; seed++) {
      const random = present(randomize(startBuild(kit), kit, seed));
      expect(sources(random).filter((id) => id?.startsWith("user-part:"))).toEqual([]);
      const filled = present(fillEmpty(startBuild(kit), kit, seed));
      expect(sources(filled).filter((id) => id?.startsWith("user-part:"))).toEqual([]);
    }
    // But keep the ones placed by hand.
    const kept = present(fillEmpty(withStilts(), kit, 3));
    expect(sources(kept)).toContain(stilt.id);
  });
});

describe("releasing a creature with a player part", () => {
  it("passes the world's checks and is saved, with no registering of the part", async () => {
    const content = loadContent();
    if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
    const created = Simulation.create(content.value, {
      worldId: STARTUP.worldId,
      seed: 5,
      tickRateHz: 2,
      minutes: 600,
    });
    if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
    const simulation = created.value;
    const assembly = present(withStilts());
    // Fits are checked by part and socket type only (ADR 0025 §6).
    expect(checkAssemblyTypes(simulation.state.registries, assembly)).toEqual([]);

    const world: LibraryWorld = {
      registerSpecies: (species, url, appearanceKind) => {
        const registered = simulation.registerSpecies(species, url, appearanceKind);
        return Promise.resolve(
          registered.ok
            ? { ok: true as const, value: { speciesId: registered.value.species.id, limits: [] } }
            : registered,
        );
      },
      spawn: () => Promise.resolve({ ok: true as const, value: "c1" }),
      despawn: (id) => Promise.resolve({ ok: true as const, value: id }),
      creatures: () => [],
      checkAssembly: (input) =>
        Promise.resolve({
          ok: true as const,
          value: checkAssemblyTypes(simulation.state.registries, input as VoxelAssembly),
        }),
    };
    const library = await openSpeciesLibrary(createMemoryLibraryStore(), world);
    const saved = await library.saveVoxel(assembly, "Stilty", {
      locomotion: { land: true, gait: "walk", swim: false },
    });
    if (!saved.ok) throw new Error(saved.diagnostics.map(formatDiagnostic).join("\n"));
    expect(simulation.state.registries.species.get(saved.value.speciesId)).toBeDefined();
  });
});
