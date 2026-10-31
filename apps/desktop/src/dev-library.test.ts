import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import {
  checkAssemblyFit,
  error,
  formatDiagnostic,
  measureAssembly,
} from "@living-diorama/content-schema";
import { describeVoxelParts, type PartSummary } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { loadContent } from "./content";
import {
  assembleStarter,
  assembleVoxelSample,
  listStarterParts,
  randomSeed,
  saveStarterCreature,
  saveVoxelSample,
  saveVoxelSamples,
  starterRoots,
  type StarterParts,
  VOXEL_SAMPLE_PLANS,
  VOXEL_SAMPLES,
} from "./dev-library";
import { partFitLookup } from "./part-types";
import type { SpeciesLibrary } from "./species-library";

describe("the voxel sample", () => {
  const library = () =>
    ({
      saveVoxel: vi.fn(() =>
        Promise.resolve({ ok: true as const, value: { speciesId: "user:1" } }),
      ),
      addCreature: vi.fn(() => Promise.resolve({ ok: true as const, value: "creature-1" })),
    }) as unknown as SpeciesLibrary & {
      saveVoxel: ReturnType<typeof vi.fn>;
      addCreature: ReturnType<typeof vi.fn>;
    };

  it("saves the sample assembly with the plan's ways of moving and adds a creature", async () => {
    const lib = library();
    const saved = await saveVoxelSample(lib, "land+swim");
    expect(saved).toEqual({
      ok: true,
      value: { species: { speciesId: "user:1" }, creatureId: "creature-1" },
    });
    expect(lib.saveVoxel).toHaveBeenCalledWith(
      expect.objectContaining({ instances: expect.any(Array) }),
      "Voxel land+swim",
      { locomotion: { land: true, gait: "walk", swim: true } },
    );
    expect(lib.addCreature).toHaveBeenCalledWith("user:1");
  });

  it("refuses a plan it doesn't know", async () => {
    const lib = library();
    const saved = await saveVoxelSample(lib, "fly" as never);
    expect(saved.ok ? [] : saved.diagnostics.map((d) => d.code)).toEqual(["unknown_plan"]);
    expect(lib.saveVoxel).not.toHaveBeenCalled();
  });
});

describe("starter creatures", () => {
  // The sample creature's parts as `ready` would list them, and the built-in types' lookups.
  const content = loadContent();
  if (!content.ok) throw new Error("The built-in content doesn't load");
  const ready = describeVoxelParts(content.value);
  const lookup = partFitLookup(ready.partTypes, ready.socketTypes);
  const parts: PartSummary[] = Object.entries(sampleVoxelAssembly().parts)
    .map(([key, part]) => ({
      id: `test:${key}`,
      name: key,
      version: "1.0.0",
      part,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1)); // By ID, as `ready` lists them.
  const starter: StarterParts = { parts, lookup };

  const library = () =>
    ({
      saveVoxel: vi.fn((_assembly: unknown, name: string) =>
        Promise.resolve({ ok: true as const, value: { speciesId: "user:1", name } }),
      ),
      addCreature: vi.fn(() => Promise.resolve({ ok: true as const, value: "creature-1" })),
    }) as unknown as SpeciesLibrary & {
      saveVoxel: ReturnType<typeof vi.fn>;
      addCreature: ReturnType<typeof vi.fn>;
    };

  it("starts from the parts whose type has the root role", () => {
    expect(starterRoots(starter).map((p) => p.id)).toEqual(["test:torso"]);
    // A second torso is a root too, and the head, which nothing hangs it from here, is not.
    const torso = parts.find((p) => p.id === "test:torso");
    if (!torso) throw new Error("No torso");
    const two = [...parts.filter((p) => p.id !== "test:head"), { ...torso, id: "test:a-torso" }];
    expect(starterRoots({ ...starter, parts: two }).map((p) => p.id)).toEqual([
      "test:a-torso",
      "test:torso",
    ]);
    // In any order, by ID, so a seed picks the same root.
    const reversed = { ...starter, parts: [...two].reverse() };
    expect(starterRoots(reversed)).toEqual(starterRoots({ ...starter, parts: two }));
    expect(assembleStarter(reversed, { seed: 5 })).toEqual(
      assembleStarter({ ...starter, parts: two }, { seed: 5 }),
    );
    // Without the torso, none is a root.
    const headless = { ...starter, parts: parts.filter((p) => p.id !== "test:torso") };
    expect(starterRoots(headless)).toEqual([]);
  });

  it("starts from the four torsos with the built-in starter parts", () => {
    expect(starterRoots({ ...starter, parts: ready.parts }).map((p) => p.id)).toEqual([
      "hollow:fish-torso",
      "hollow:four-legged-torso",
      "hollow:mossling-torso",
      "hollow:upright-torso",
    ]);
  });

  it("builds the same creature for the same seed, one that fits the registered types", () => {
    const first = assembleStarter(starter, { seed: 7 });
    if (!first.ok) throw new Error(first.diagnostics.map(formatDiagnostic).join("\n"));
    expect(first.value).toMatchObject({ root: "test:torso", seed: 7 });
    expect(assembleStarter(starter, { seed: 7 })).toEqual(first);
    const typeLookup = {
      partType: (id: string) => content.value.partTypes.get(id),
      socketType: (id: string) => content.value.socketTypes.get(id),
    };
    expect(checkAssemblyFit(first.value.assembly, typeLookup)).toEqual([]);
    // Every socket of the sample torso and head is filled.
    expect(first.value.assembly.instances).toHaveLength(9);
  });

  it("builds on the root asked for", () => {
    const built = assembleStarter(starter, { root: "test:head", seed: 1 });
    expect(built.ok && built.value.assembly.instances.map((i) => i.id)).toEqual([
      "head",
      "left-eye",
      "right-eye",
    ]);
  });

  it("picks a random whole-number seed when none is given", () => {
    const seeds = Array.from({ length: 20 }, () => randomSeed());
    for (const seed of seeds) {
      expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff).toBe(true);
    }
    expect(new Set(seeds).size).toBeGreaterThan(1);
    const built = assembleStarter(starter);
    expect(built.ok && Number.isInteger(built.value.seed)).toBe(true);
  });

  it("refuses a seed that isn't a whole number from 0 to 2³² − 1, an unknown root and no root", () => {
    const codes = (result: { ok: boolean; diagnostics?: { code: string }[] }) =>
      result.ok ? [] : result.diagnostics?.map((d) => d.code);
    for (const seed of [0.5, -1, 2 ** 32]) {
      expect(codes(assembleStarter(starter, { seed }))).toEqual(["invalid_seed"]);
    }
    expect(codes(assembleStarter(starter, { root: "test:wing", seed: 1 }))).toEqual([
      "unknown_part",
    ]);
    const none = assembleStarter({ ...starter, parts: [] }, { seed: 1 });
    expect(none.ok ? [] : none.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["no_root", "No voxel parts are registered"],
    ]);
    const rootless = assembleStarter(
      { ...starter, parts: parts.filter((p) => p.id !== "test:torso") },
      { seed: 1 },
    );
    expect(rootless.ok ? [] : rootless.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["no_root", "None of the 4 registered voxel parts is a root"],
    ]);
  });

  it("saves the creature, adds it to the world and says how to build it again", async () => {
    const lib = library();
    const saved = await saveStarterCreature(lib, starter, { seed: 42, plan: "hop" });
    expect(saved).toEqual({
      ok: true,
      value: {
        species: { speciesId: "user:1", name: "Starter 42" },
        creatureId: "creature-1",
        root: "test:torso",
        seed: 42,
      },
    });
    const built = assembleStarter(starter, { seed: 42 });
    expect(lib.saveVoxel).toHaveBeenCalledWith(built.ok && built.value.assembly, "Starter 42", {
      locomotion: { land: true, gait: "hop", swim: false },
    });
    expect(lib.addCreature).toHaveBeenCalledWith("user:1");
  });

  it("saves nothing when the creature can't be assembled", async () => {
    const lib = library();
    const saved = await saveStarterCreature(lib, { ...starter, parts: [] });
    expect(saved.ok).toBe(false);
    expect(lib.saveVoxel).not.toHaveBeenCalled();
  });

  it("lists the starter parts with their types", () => {
    expect(listStarterParts(starter)).toContainEqual({
      id: "test:leg",
      name: "leg",
      type: "hollow:leg",
    });
  });
});

describe("the performance samples", () => {
  const content = loadContent();
  if (!content.ok) throw new Error("The built-in content doesn't load");
  const ready = describeVoxelParts(content.value);
  const starter: StarterParts = {
    parts: ready.parts,
    lookup: partFitLookup(ready.partTypes, ready.socketTypes),
  };
  const typeLookup = {
    partType: (id: string) => content.value.partTypes.get(id),
    socketType: (id: string) => content.value.socketTypes.get(id),
  };
  const built = VOXEL_SAMPLES.map((sample) => {
    const assembly = assembleVoxelSample(starter, sample);
    if (!assembly.ok) throw new Error(assembly.diagnostics.map(formatDiagnostic).join("\n"));
    const root = assembleStarter(starter, { seed: sample.seed });
    return { ...sample, assembly: assembly.value, root: root.ok ? root.value.root : undefined };
  });

  it("are twenty differently named species that fit the built-in types", () => {
    expect(new Set(VOXEL_SAMPLES.map((s) => s.name)).size).toBe(20);
    for (const { assembly } of built) expect(checkAssemblyFit(assembly, typeLookup)).toEqual([]);
    // The same every time.
    expect(VOXEL_SAMPLES.map((s) => assembleVoxelSample(starter, s))).toEqual(
      built.map(({ assembly }) => ({ ok: true, value: assembly })),
    );
  });

  it("vary in root, size and way of moving, and only fish swim", () => {
    const count = (values: (string | undefined)[]) =>
      Object.fromEntries(
        [...new Set(values)].map((v) => [v, values.filter((x) => x === v).length]),
      );
    expect(count(built.map((s) => s.root))).toEqual({
      "hollow:fish-torso": 4,
      "hollow:four-legged-torso": 6,
      "hollow:mossling-torso": 5,
      "hollow:upright-torso": 5,
    });
    expect(count(built.map((s) => measureAssembly(s.assembly).sizeClass))).toEqual({
      small: 8,
      medium: 9,
      large: 3,
    });
    expect(count(built.map((s) => s.plan))).toEqual({
      walk: 11,
      hop: 5,
      swim: 2,
      "land+swim": 2,
    });
    for (const { plan, root } of built) {
      expect(VOXEL_SAMPLE_PLANS[plan].swim).toBe(root === "hollow:fish-torso");
    }
  });

  it("are saved in order without adding creatures", async () => {
    const saveVoxel = vi.fn(() => Promise.resolve({ ok: true as const, value: {} }));
    const addCreature = vi.fn();
    const lib = { saveVoxel, addCreature } as unknown as SpeciesLibrary;
    await expect(saveVoxelSamples(lib, starter)).resolves.toEqual([]);
    expect(saveVoxel.mock.calls).toEqual(
      built.map(({ assembly, name, plan }) => [
        assembly,
        name,
        { locomotion: VOXEL_SAMPLE_PLANS[plan] },
      ]),
    );
    expect(addCreature).not.toHaveBeenCalled();
  });

  it("say which could not be saved and why", async () => {
    const saveVoxel = vi.fn((_assembly: unknown, name: string) =>
      Promise.resolve(
        name === "Pip"
          ? { ok: false as const, diagnostics: [error("too_large", "Pip is too large")] }
          : { ok: true as const, value: {} },
      ),
    );
    const lib = { saveVoxel } as unknown as SpeciesLibrary;
    const failed = await saveVoxelSamples(lib, starter);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatch(/^Pip: .*too_large/);
    // Nothing to build on: every sample fails, and nothing is saved.
    saveVoxel.mockClear();
    expect(await saveVoxelSamples(lib, { ...starter, parts: [] })).toHaveLength(20);
    expect(saveVoxel).not.toHaveBeenCalled();
  });
});
