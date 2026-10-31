import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import {
  error,
  libraryAppearance,
  parseLibraryEntry,
  type Diagnostic,
  type Result,
  type SpeciesDefinition,
} from "@living-diorama/content-schema";
import { createMemoryLibraryStore, type LibraryStore } from "@living-diorama/desktop-integration";
import type { SpeciesAppearanceKind } from "@living-diorama/extension-api";
import { describe, expect, it, vi } from "vitest";
import {
  assemblyBytes,
  MAX_ASSEMBLY_BYTES,
  openSpeciesLibrary,
  type LibraryWorld,
  type SpeciesLibrary,
} from "./species-library";
import { userSpeciesIds } from "./user-species";

const UUIDS = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
/** A world that registers every species but those named "Rejected". */
function fakeWorld() {
  const creatures: { id: string; speciesId: string }[] = [];
  const registered: string[] = [];
  let next = 1;
  const world = {
    registerSpecies: vi.fn((input: unknown, url: string, kind: SpeciesAppearanceKind) => {
      const species = input as SpeciesDefinition;
      expect(url).toMatch(/^blob:/);
      expect(kind).toBe("voxel");
      if (species.name === "Rejected") {
        return Promise.resolve<Result<never>>({
          ok: false,
          diagnostics: [error("too_big", "Doesn't fit", [])],
        });
      }
      registered.push(species.id);
      return Promise.resolve({ ok: true as const, value: { speciesId: species.id, limits: [] } });
    }),
    spawn: vi.fn((speciesId: string) => {
      const id = `c${next++}`;
      creatures.push({ id, speciesId });
      return Promise.resolve({ ok: true as const, value: id });
    }),
    despawn: vi.fn((creatureId: string) => {
      creatures.splice(
        creatures.findIndex((c) => c.id === creatureId),
        1,
      );
      return Promise.resolve({ ok: true as const, value: creatureId });
    }),
    creatures: () => creatures,
    checkAssembly: vi.fn<(assembly: unknown) => Promise<Result<Diagnostic[]>>>(() =>
      Promise.resolve({ ok: true, value: [] }),
    ),
  } satisfies LibraryWorld;
  return { world, creatures, registered };
}

async function open(store: LibraryStore = createMemoryLibraryStore(), onChange = () => {}) {
  const { world, creatures, registered } = fakeWorld();
  const uuids = [...UUIDS];
  let minutes = 0;
  const library = await openSpeciesLibrary(store, world, {
    uuid: () => uuids.shift() ?? "",
    now: () => new Date(Date.UTC(2026, 9, 27, 12, minutes++)),
    onChange,
  });
  return { library, world, creatures, registered, store };
}

const value = <T>(result: Result<T>) => {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  return result.value;
};

const HOP = { locomotion: { land: true, gait: "hop", swim: false } } as const;

/** Saves the sample voxel creature as a hopping species. */
const save = (library: SpeciesLibrary, name: string, id?: string) =>
  library.saveVoxel(sampleVoxelAssembly(), name, HOP, id === undefined ? {} : { id });

describe("saving", () => {
  it("keeps a species under the ID it is given, and refuses one already used", async () => {
    const { library, registered } = await open();
    const id = "00000000-0000-4000-8000-0000000000ff";
    const saved = value(await save(library, "Pebble", id));
    expect(saved.speciesId).toBe(userSpeciesIds(id).speciesId);
    const again = await save(library, "Pebble", id);
    expect(again.ok).toBe(false);
    expect(registered).toHaveLength(1);
  });

  it("stores nothing the world rejects", async () => {
    const { library, store } = await open();
    const result = await save(library, "Rejected");
    expect(result.ok).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(library.list()).toEqual([]);
  });

  it("checks the name before registering", async () => {
    const { library, world } = await open();
    expect((await save(library, "")).ok).toBe(false);
    expect(world.registerSpecies).not.toHaveBeenCalled();
  });

  it("reports a failed save and keeps the species out of the library", async () => {
    const store = createMemoryLibraryStore();
    store.save = () => Promise.reject(new Error("Disk full"));
    const { library } = await open(store);
    const result = await save(library, "Pebble");
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "library_io" }] });
    expect(library.list()).toEqual([]);
    expect((await library.addCreature(userSpeciesIds(UUIDS[0]).speciesId)).ok).toBe(false);
  });
});

describe("startup", () => {
  it("registers every stored species without creatures", async () => {
    const first = await open();
    value(await save(first.library, "Pebble"));
    value(await save(first.library, "Twig"));

    const relaunched = await open(first.store);
    expect(relaunched.library.list().map((s) => [s.name, s.available])).toEqual([
      ["Pebble", true],
      ["Twig", true],
    ]);
    expect(relaunched.registered).toHaveLength(2);
    expect(relaunched.world.spawn).not.toHaveBeenCalled();
  });

  it("lists a species the world rejects as unavailable", async () => {
    const first = await open();
    value(await save(first.library, "Pebble"));
    const [stored] = await first.store.list();
    const { species } = stored?.entry as { species: SpeciesDefinition };
    species.name = "Rejected";
    const store = createMemoryLibraryStore();
    await store.save(UUIDS[0] ?? "", { ...(stored?.entry as object), species });

    const { library } = await open(store);
    expect(library.list()).toMatchObject([
      { name: "Rejected", available: false, reasons: [{ code: "too_big" }] },
    ]);
  });

  it("skips entries that fail their schema, such as a drawn one from before M23", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemoryLibraryStore();
    await store.save(UUIDS[0] ?? "", { schemaVersion: 7 });
    const other = userSpeciesIds(UUIDS[1]);
    await store.save(UUIDS[1] ?? "", {
      schemaVersion: 5,
      body: { kind: "drawn" },
      createdAt: "2026-10-27T12:00:00Z",
      species: {
        schemaVersion: 1,
        id: other.speciesId,
        version: "1.0.0",
        name: "Puddle",
        appearance: libraryAppearance(other.speciesId),
        sizeClass: "small",
        capabilities: { "core:land": 1 },
        baseSpeed: 0.6,
        behaviors: ["core:wander"],
      },
    });

    const { library, registered } = await open(store);
    expect(library.list()).toEqual([]);
    expect(registered).toEqual([]);
    // Their files are left alone.
    expect(await store.list()).toHaveLength(2);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("unsupported_schema_version"),
      expect.stringContaining("missing_migration"),
    ]);
    warn.mockRestore();
  });
});

describe("creatures", () => {
  it("adds and removes creatures of a species", async () => {
    const { library, creatures } = await open();
    const { speciesId } = value(await save(library, "Pebble"));
    const creatureId = value(await library.addCreature(speciesId));
    expect(creatures).toEqual([{ id: creatureId, speciesId }]);
    value(await library.removeCreature(creatureId));
    expect(creatures).toEqual([]);
  });

  it("deletes a species, its creatures and its files", async () => {
    const { library, creatures, store } = await open();
    const pebble = value(await save(library, "Pebble"));
    const twig = value(await save(library, "Twig"));
    await library.addCreature(pebble.speciesId);
    await library.addCreature(pebble.speciesId);
    await library.addCreature(twig.speciesId);

    value(await library.deleteSpecies(pebble.speciesId));
    expect(creatures.map((c) => c.speciesId)).toEqual([twig.speciesId]);
    expect(library.list()).toEqual([twig]);
    expect((await store.list()).map((s) => s.id)).toEqual([UUIDS[1]]);
    expect(await library.addCreature(pebble.speciesId)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "species_deleted" }],
    });
    expect(await library.deleteSpecies(pebble.speciesId)).toMatchObject({ ok: false });
  });
});

it("tells when the list changes", async () => {
  const onChange = vi.fn();
  const { library } = await open(createMemoryLibraryStore(), onChange);
  expect(onChange).not.toHaveBeenCalled();
  const { speciesId } = value(await save(library, "Pebble"));
  await save(library, "Rejected");
  expect(onChange).toHaveBeenCalledTimes(1);
  value(await library.deleteSpecies(speciesId));
  expect(onChange).toHaveBeenCalledTimes(2);
});

describe("voxel species", () => {
  /** One 32-cube block of 10 cm cubes: 3.2 m, too large for every size class. */
  const BOULDER = {
    parts: {
      block: {
        type: "hollow:torso",
        size: { x: 32, y: 32, z: 32 },
        step: 0.1,
        colors: ["#888888"],
        voxels: [32 * 32 * 32, 1],
        attach: { x: 0, y: 0, z: 0 },
      },
    },
    instances: [{ id: "block", part: "block" }],
  };

  it("registers and stores one, its size class measured from its cubes and no image", async () => {
    const { library, world, store } = await open();
    const assembly = sampleVoxelAssembly();
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const saved = value(await library.saveVoxel(assembly, "Pebble", HOP));
    const { speciesId } = userSpeciesIds(UUIDS[0]);
    expect(saved).toEqual({
      speciesId,
      name: "Pebble",
      sizeClass: "medium",
      createdAt: "2026-10-27T12:00:00.000Z",
      available: true,
      limits: [],
    });
    expect(world.checkAssembly).toHaveBeenCalledWith(assembly);

    // Registered as a voxel asset, from the assembly as JSON.
    const [species, url, kind] = world.registerSpecies.mock.calls[0] ?? [];
    expect(kind).toBe("voxel");
    expect((species as SpeciesDefinition).appearance).toBe(`${speciesId}/assembly.json`);
    expect(url).toMatch(/^blob:/);
    const blob = createUrl.mock.calls[0]?.[0] as Blob;
    expect(JSON.parse(await blob.text())).toEqual(assembly);
    createUrl.mockRestore();

    const [stored] = await store.list();
    expect(stored?.entry).toEqual({
      schemaVersion: 6,
      species: {
        schemaVersion: 1,
        id: speciesId,
        version: "1.0.0",
        name: "Pebble",
        appearance: `${speciesId}/assembly.json`,
        sizeClass: "medium",
        // Its gait only: an entry holds no thickness or anchors.
        body: { locomotion: { land: { gait: "hop" } } },
        capabilities: { "core:land": 1 },
        baseSpeed: 0.6,
        behaviors: ["core:wander", "core:feed", "core:rest"],
        senses: { "core:vision": 8 },
        traits: {},
      },
      assembly,
      createdAt: "2026-10-27T12:00:00.000Z",
    });
  });

  it("registers it again at startup from its entry", async () => {
    const first = await open();
    value(await first.library.saveVoxel(sampleVoxelAssembly(), "Pebble", HOP));

    const relaunched = await open(first.store);
    expect(relaunched.library.list().map((s) => [s.name, s.available])).toEqual([["Pebble", true]]);
    expect(relaunched.world.registerSpecies.mock.calls.map(([, , kind]) => kind)).toEqual([
      "voxel",
    ]);
    // Fits are checked at release only.
    expect(relaunched.world.checkAssembly).not.toHaveBeenCalled();
  });

  it("loads an entry saved again as parsed, as M21's recolouring will", async () => {
    const first = await open();
    value(await first.library.saveVoxel(sampleVoxelAssembly(), "Pebble", HOP));
    const [stored] = await first.store.list();
    const parsed = value(parseLibraryEntry(stored?.entry));
    const store = createMemoryLibraryStore();
    await store.save(UUIDS[0] ?? "", parsed);

    const { library } = await open(store);
    expect(library.list()).toMatchObject([{ name: "Pebble", available: true }]);
  });

  it("skips an entry that holds another ID", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await open();
    value(await first.library.saveVoxel(sampleVoxelAssembly(), "Pebble", HOP));
    const [stored] = await first.store.list();
    const store = createMemoryLibraryStore();
    await store.save(UUIDS[1] ?? "", stored?.entry);

    const { library } = await open(store);
    expect(library.list()).toEqual([]);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("library_id_mismatch"),
    ]);
    warn.mockRestore();
  });

  it("refuses one too large for every size class, one that doesn't fit, and a bad one", async () => {
    const { library, world, store } = await open();
    const large = await library.saveVoxel(BOULDER, "Boulder", HOP);
    expect(large.ok ? [] : large.diagnostics.map((d) => d.code)).toEqual(["too_large"]);
    expect(world.checkAssembly).not.toHaveBeenCalled();

    world.checkAssembly.mockResolvedValueOnce({
      ok: true,
      value: [error("part_does_not_fit", "No", [])],
    });
    const misfit = await library.saveVoxel(sampleVoxelAssembly(), "Misfit", HOP);
    expect(misfit.ok ? [] : misfit.diagnostics.map((d) => d.code)).toEqual(["part_does_not_fit"]);

    const bad = await library.saveVoxel({ parts: {}, instances: [] }, "Nothing", HOP);
    expect(bad.ok).toBe(false);

    expect(world.registerSpecies).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it("refuses an assembly over the size cap before checking anything else (#208)", async () => {
    const { library, world, store } = await open();
    // Not even a valid assembly: the cap comes first.
    const huge = { parts: {}, instances: [], padding: "x".repeat(MAX_ASSEMBLY_BYTES) };
    const refused = await library.saveVoxel(huge, "Mountain", HOP);
    expect(refused.ok ? [] : refused.diagnostics.map((d) => d.code)).toEqual(["assembly_too_big"]);
    expect(world.checkAssembly).not.toHaveBeenCalled();
    expect(world.registerSpecies).not.toHaveBeenCalled();
    expect(await store.list()).toEqual([]);
  });

  it("counts an assembly's size in UTF-8 bytes of its JSON", () => {
    expect(assemblyBytes({ a: "é" })).toBe('{"a":"é"}'.length + 1);
    expect(assemblyBytes(sampleVoxelAssembly())).toBe(JSON.stringify(sampleVoxelAssembly()).length);
    expect(assemblyBytes(undefined)).toBeUndefined();
    expect(assemblyBytes({ a: 1n })).toBeUndefined();
  });

  it("gives a species' saved assembly and version, also after a relaunch", async () => {
    const first = await open();
    const assembly = sampleVoxelAssembly();
    const { speciesId } = value(await first.library.saveVoxel(assembly, "Pebble", HOP));
    const expected = { speciesId, version: "1.0.0", assembly };
    expect(value(first.library.assembly(speciesId))).toEqual(expected);

    const { library } = await open(first.store);
    expect(value(library.assembly(speciesId))).toEqual(expected);
    const codeOf = (result: Result<unknown>) => (result.ok ? [] : result.diagnostics)[0]?.code;
    expect(codeOf(library.assembly("user:missing"))).toBe("unknown_species");
    value(await library.deleteSpecies(speciesId));
    expect(codeOf(library.assembly(speciesId))).toBe("unknown_species");
  });

  it("gives the assembly of a species the world didn't take", async () => {
    const first = await open();
    const assembly = sampleVoxelAssembly();
    const { speciesId } = value(await first.library.saveVoxel(assembly, "Pebble", HOP));
    // Renamed so the fake world rejects it at the next launch.
    const [stored] = await first.store.list();
    const entry = stored?.entry as { species: Record<string, unknown> };
    const store = createMemoryLibraryStore();
    await store.save(UUIDS[0] ?? "", { ...entry, species: { ...entry.species, name: "Rejected" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { library } = await open(store);
    warn.mockRestore();
    expect(library.list()).toMatchObject([{ speciesId, available: false }]);
    expect(value(library.assembly(speciesId)).assembly).toEqual(assembly);
  });
});
