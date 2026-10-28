import {
  error,
  type Drawing,
  type Result,
  type SpeciesDefinition,
} from "@living-diorama/content-schema";
import { createMemoryLibraryStore, type LibraryStore } from "@living-diorama/desktop-integration";
import { describe, expect, it, vi } from "vitest";
import { openSpeciesLibrary, type LibraryWorld } from "./species-library";
import { userSpeciesIds } from "./user-species";

const UUIDS = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
const PNG = new Uint8Array([137, 80, 78, 71]);
const DRAWING: Drawing = {
  schemaVersion: 1,
  canvas: { width: 256, height: 256 },
  strokes: [{ tool: "pen", color: "#336633", width: 12, points: [10, 10, 1, 20, 20, 0.5] }],
};

/** A world that registers every species but those named "Rejected". */
function fakeWorld() {
  const creatures: { id: string; speciesId: string }[] = [];
  const registered: string[] = [];
  let next = 1;
  const world = {
    registerSpecies: vi.fn((input: unknown, url: string) => {
      const species = input as SpeciesDefinition;
      expect(url).toMatch(/^blob:/);
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

describe("saving", () => {
  it("registers and stores a drawn species with the defaults", async () => {
    const { library, registered, store } = await open();
    const saved = value(await library.save(DRAWING, PNG, "Puddle", "small"));
    const { speciesId, appearanceId } = userSpeciesIds(UUIDS[0]);

    expect(saved).toEqual({
      speciesId,
      name: "Puddle",
      sizeClass: "small",
      createdAt: "2026-10-27T12:00:00.000Z",
      available: true,
      limits: [],
    });
    expect(registered).toEqual([speciesId]);
    const [stored] = await store.list();
    expect(stored?.entry).toMatchObject({
      schemaVersion: 1,
      species: {
        id: speciesId,
        appearance: appearanceId,
        capabilities: { "core:walk": 1 },
        baseSpeed: 0.6,
        behaviors: ["core:wander"],
      },
    });
    expect(await store.loadDrawing(UUIDS[0] ?? "")).toEqual(DRAWING);
    expect(library.list()).toEqual([saved]);
  });

  it("stores nothing the world rejects", async () => {
    const { library, store } = await open();
    const result = await library.save(DRAWING, PNG, "Rejected", "small");
    expect(result.ok).toBe(false);
    expect(await store.list()).toEqual([]);
    expect(library.list()).toEqual([]);
  });

  it("checks the name and the drawing before registering", async () => {
    const { library, world } = await open();
    expect((await library.save(DRAWING, PNG, "", "small")).ok).toBe(false);
    const broken = { ...DRAWING, strokes: [{ ...DRAWING.strokes[0], points: [1, 2] }] } as Drawing;
    expect((await library.save(broken, PNG, "Puddle", "small")).ok).toBe(false);
    expect(world.registerSpecies).not.toHaveBeenCalled();
  });

  it("reports a failed save and keeps the species out of the library", async () => {
    const store = createMemoryLibraryStore();
    store.save = () => Promise.reject(new Error("Disk full"));
    const { library } = await open(store);
    const result = await library.save(DRAWING, PNG, "Puddle", "small");
    expect(result).toMatchObject({ ok: false, diagnostics: [{ code: "library_io" }] });
    expect(library.list()).toEqual([]);
    expect((await library.addCreature(userSpeciesIds(UUIDS[0]).speciesId)).ok).toBe(false);
  });
});

describe("startup", () => {
  it("registers every stored species without creatures", async () => {
    const first = await open();
    value(await first.library.save(DRAWING, PNG, "Puddle", "small"));
    value(await first.library.save(DRAWING, PNG, "Twig", "tiny"));

    const relaunched = await open(first.store);
    expect(relaunched.library.list().map((s) => [s.name, s.available])).toEqual([
      ["Puddle", true],
      ["Twig", true],
    ]);
    expect(relaunched.registered).toHaveLength(2);
    expect(relaunched.world.spawn).not.toHaveBeenCalled();
  });

  it("lists a species the world rejects as unavailable", async () => {
    const first = await open();
    value(await first.library.save(DRAWING, PNG, "Puddle", "small"));
    const [stored] = await first.store.list();
    const { species } = stored?.entry as { species: SpeciesDefinition };
    species.name = "Rejected";
    const store = createMemoryLibraryStore();
    await store.save(UUIDS[0] ?? "", { ...(stored?.entry as object), species }, DRAWING, PNG);

    const { library } = await open(store);
    expect(library.list()).toMatchObject([
      { name: "Rejected", available: false, reasons: [{ code: "too_big" }] },
    ]);
  });

  it("skips entries that fail their schema or hold another ID, and leaves their files", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemoryLibraryStore();
    await store.save(UUIDS[0] ?? "", { schemaVersion: 2 }, DRAWING, PNG);
    const other = userSpeciesIds(UUIDS[0]);
    await store.save(
      UUIDS[1] ?? "",
      {
        schemaVersion: 1,
        createdAt: "2026-10-27T12:00:00Z",
        species: {
          schemaVersion: 1,
          id: other.speciesId,
          version: "1.0.0",
          name: "Copy",
          appearance: other.appearanceId,
          sizeClass: "small",
          capabilities: { "core:walk": 1 },
          baseSpeed: 0.6,
          behaviors: ["core:wander"],
        },
      },
      DRAWING,
      PNG,
    );

    const { library, registered } = await open(store);
    expect(library.list()).toEqual([]);
    expect(registered).toEqual([]);
    expect(await store.list()).toHaveLength(2);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("unsupported_schema_version"),
      expect.stringContaining("library_id_mismatch"),
    ]);
    warn.mockRestore();
  });
});

describe("creatures", () => {
  it("adds and removes creatures of a species", async () => {
    const { library, creatures } = await open();
    const { speciesId } = value(await library.save(DRAWING, PNG, "Puddle", "small"));
    const creatureId = value(await library.addCreature(speciesId));
    expect(creatures).toEqual([{ id: creatureId, speciesId }]);
    value(await library.removeCreature(creatureId));
    expect(creatures).toEqual([]);
  });

  it("deletes a species, its creatures and its files", async () => {
    const { library, creatures, store } = await open();
    const puddle = value(await library.save(DRAWING, PNG, "Puddle", "small"));
    const twig = value(await library.save(DRAWING, PNG, "Twig", "tiny"));
    await library.addCreature(puddle.speciesId);
    await library.addCreature(puddle.speciesId);
    await library.addCreature(twig.speciesId);

    value(await library.deleteSpecies(puddle.speciesId));
    expect(creatures.map((c) => c.speciesId)).toEqual([twig.speciesId]);
    expect(library.list()).toEqual([twig]);
    expect((await store.list()).map((s) => s.id)).toEqual([UUIDS[1]]);
    expect(await library.addCreature(puddle.speciesId)).toMatchObject({
      ok: false,
      diagnostics: [{ code: "species_deleted" }],
    });
    expect(await library.deleteSpecies(puddle.speciesId)).toMatchObject({ ok: false });
  });
});

it("tells when the list changes", async () => {
  const onChange = vi.fn();
  const { library } = await open(createMemoryLibraryStore(), onChange);
  expect(onChange).not.toHaveBeenCalled();
  const { speciesId } = value(await library.save(DRAWING, PNG, "Puddle", "small"));
  await library.save(DRAWING, PNG, "Rejected", "small");
  expect(onChange).toHaveBeenCalledTimes(1);
  value(await library.deleteSpecies(speciesId));
  expect(onChange).toHaveBeenCalledTimes(2);
});
