import {
  error,
  type Drawing,
  type Result,
  type SizeClass,
  type SpeciesDefinition,
} from "@living-diorama/content-schema";
import {
  createMemoryLibraryStore,
  createMemoryWindowBus,
  openStudioChannel,
  serveStudio,
  type LibraryStore,
} from "@living-diorama/desktop-integration";
import type { Limit } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { openSpeciesLibrary, type SpeciesLibrary } from "./species-library";
import { DRAWN_SPECIES_DEFAULTS } from "./startup";
import {
  countBySpecies,
  librarySnapshot,
  studioHandlers,
  worldFullMessage,
  type LibrarySnapshot,
  type ReleaseParams,
  type StudioRequests,
  type StudioServices,
} from "./studio-protocol";
import { userSpeciesIds } from "./user-species";

const bridge: Limit = {
  severity: "warning",
  code: "portal_unusable",
  message: "unusable",
  path: ["structures", 0, "connections", 0, "portal"],
  structure: { id: "bridge", name: "Wooden bridge" },
};

const DRAWING: Drawing = {
  schemaVersion: 2,
  canvas: { width: 256, height: 256 },
  history: [
    { kind: "stroke", tool: "pen", color: "#336633", width: 12, points: [10, 10, 1, 20, 20, 0.5] },
  ],
};
const RELEASE_ID = "00000000-0000-4000-8000-00000000000a";
const PNG = [137, 80, 78, 71];

const releaseParams = (overrides: Partial<ReleaseParams> = {}): ReleaseParams => ({
  releaseId: RELEASE_ID,
  drawing: DRAWING,
  image: PNG,
  name: "Puddle",
  sizeClass: "small",
  thickness: 0.25,
  ...overrides,
});

/** A world holding one built-in creature, with a cap of `maxCreatures`. */
function fakeWorld() {
  const creatures = [{ id: "m1", speciesId: "core:mossling" }];
  let next = 1;
  return {
    creatures,
    registerSpecies: vi.fn((input: unknown) => {
      const species = input as SpeciesDefinition;
      return Promise.resolve({ ok: true as const, value: { speciesId: species.id, limits: [] } });
    }),
    spawn: vi.fn((speciesId: string): Promise<Result<string>> => {
      const id = `c${next++}`;
      creatures.push({ id, speciesId });
      return Promise.resolve({ ok: true, value: id });
    }),
    despawn: vi.fn((creatureId: string) => {
      creatures.splice(
        creatures.findIndex((c) => c.id === creatureId),
        1,
      );
      return Promise.resolve({ ok: true as const, value: creatureId });
    }),
  };
}

async function setUp({
  maxCreatures = 20,
  store = createMemoryLibraryStore(),
  open = true,
  checkLimits = () => Promise.reject(new Error("unused")),
}: {
  maxCreatures?: number;
  store?: LibraryStore;
  open?: boolean;
  checkLimits?: StudioServices["checkLimits"];
} = {}) {
  const world = fakeWorld();
  const changed = vi.fn();
  let library: SpeciesLibrary | undefined;
  if (open) {
    library = await openSpeciesLibrary(
      store,
      { ...world, creatures: () => world.creatures },
      { onChange: changed },
    );
  }
  const services: StudioServices = {
    library: () => library,
    creatures: () => world.creatures,
    maxCreatures,
    checkLimits,
  };
  const bus = createMemoryWindowBus();
  serveStudio<StudioRequests, LibrarySnapshot>(studioHandlers(services), bus.connect("main"));
  const studio = openStudioChannel<StudioRequests, LibrarySnapshot>({
    transport: bus.connect("studio"),
  });
  return { studio, world, store, services, changed, library };
}

describe("the Studio's requests", () => {
  it("checks a size's limits with the capabilities every drawn species has", async () => {
    const checkLimits = vi.fn((sizeClass: SizeClass) =>
      Promise.resolve({ ok: true as const, value: sizeClass === "large" ? [bridge] : [] }),
    );
    const { studio } = await setUp({ checkLimits });
    await expect(studio.request("limits", { sizeClass: "large" })).resolves.toEqual([bridge]);
    await expect(studio.request("limits", { sizeClass: "small" })).resolves.toEqual([]);
    expect(checkLimits).toHaveBeenCalledWith("large", DRAWN_SPECIES_DEFAULTS.capabilities);
  });

  it("passes a rejected query on as an error", async () => {
    const { studio } = await setUp({
      checkLimits: () =>
        Promise.resolve({
          ok: false,
          diagnostics: [error("unknown_size_class", "No size huge", [])],
        }),
    });
    await expect(studio.request("limits", { sizeClass: "huge" as SizeClass })).rejects.toThrow(
      "No size huge",
    );
  });

  it("answers with the library and the world's creatures", async () => {
    const { studio } = await setUp({ maxCreatures: 12 });
    await expect(studio.request("snapshot", undefined)).resolves.toEqual({
      species: [],
      creatures: 1,
      maxCreatures: 12,
    });
  });
});

describe("releasing", () => {
  it("saves the drawing under the Studio's ID and adds one creature", async () => {
    const { studio, world, store, changed } = await setUp();
    const { speciesId } = userSpeciesIds(RELEASE_ID);
    await expect(studio.request("release", releaseParams({ name: "  Puddle " }))).resolves.toEqual({
      speciesId,
      name: "Puddle",
    });
    const stored = await store.list();
    expect(stored.map((entry) => entry.id)).toEqual([RELEASE_ID]);
    expect(stored[0]?.entry).toMatchObject({ species: { body: { thickness: 0.25 } } });
    expect(await store.loadImage(RELEASE_ID)).toEqual(new Uint8Array(PNG));
    expect(world.spawn).toHaveBeenCalledWith(speciesId, { released: true });
    expect(changed).toHaveBeenCalledOnce();

    const snapshot = await studio.request("snapshot", undefined);
    expect(snapshot.creatures).toBe(2);
    expect(snapshot.species).toMatchObject([
      { speciesId, libraryId: RELEASE_ID, name: "Puddle", inWorld: 1, available: true },
    ]);
  });

  it("saves once and adds once when the same release comes again", async () => {
    const { studio, world, store } = await setUp();
    const [first, second] = await Promise.all([
      studio.request("release", releaseParams()),
      studio.request("release", releaseParams()),
    ]);
    const third = await studio.request("release", releaseParams());
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(await store.list()).toHaveLength(1);
    expect(world.registerSpecies).toHaveBeenCalledOnce();
    expect(world.spawn).toHaveBeenCalledOnce();
  });

  it("after the strip reloads, adds a creature of a species an earlier try kept", async () => {
    const store = createMemoryLibraryStore();
    await (await setUp({ store })).studio.request("release", releaseParams());
    const reloaded = await setUp({ store });
    await reloaded.studio.request("release", releaseParams());
    expect(await store.list()).toHaveLength(1);
    expect(reloaded.world.spawn).toHaveBeenCalledOnce();
  });

  it("refuses an empty name, and while the library is still opening", async () => {
    const { studio, store } = await setUp();
    await expect(studio.request("release", releaseParams({ name: "  " }))).rejects.toThrow(
      "Give your creature a name first.",
    );
    expect(await store.list()).toEqual([]);
    const starting = await setUp({ open: false });
    await expect(starting.studio.request("release", releaseParams())).rejects.toThrow(
      "The world is still starting",
    );
  });

  it("refuses a full world before saving anything, and can try again after", async () => {
    const { studio, world, store } = await setUp({ maxCreatures: 1 });
    await expect(studio.request("release", releaseParams())).rejects.toThrow(worldFullMessage(1));
    expect(await store.list()).toEqual([]);
    world.creatures.length = 0;
    await expect(studio.request("release", releaseParams())).resolves.toMatchObject({
      name: "Puddle",
    });
  });

  it("says when the species was kept but its creature couldn't join", async () => {
    const { studio, world, store } = await setUp();
    world.spawn.mockResolvedValueOnce({
      ok: false,
      diagnostics: [error("world_full", worldFullMessage(20), [])],
    });
    await expect(studio.request("release", releaseParams())).resolves.toMatchObject({
      notAdded: worldFullMessage(20),
    });
    expect(await store.list()).toHaveLength(1);
  });
});

describe("My creatures", () => {
  it("adds and removes creatures of a species, newest first", async () => {
    const { studio, world } = await setUp();
    const { speciesId } = await studio.request("release", releaseParams());
    const added = await studio.request("addCreature", { speciesId });
    expect(world.creatures.map((c) => c.id)).toEqual(["m1", "c1", added]);
    await expect(studio.request("removeCreature", { speciesId })).resolves.toBe(added);
    await studio.request("removeCreature", { speciesId });
    await expect(studio.request("removeCreature", { speciesId })).rejects.toThrow(
      "None of them are in the world.",
    );
    expect(world.creatures.map((c) => c.id)).toEqual(["m1"]);
  });

  it("says the world is full instead of adding past the cap", async () => {
    const { studio, world } = await setUp({ maxCreatures: 2 });
    const { speciesId } = await studio.request("release", releaseParams());
    await expect(studio.request("addCreature", { speciesId })).rejects.toThrow(
      "The world is full (2 creatures). Remove one to add another.",
    );
    expect(world.spawn).toHaveBeenCalledOnce();
  });

  it("deletes a species and takes its creatures out of the world", async () => {
    const { studio, world, store } = await setUp();
    const { speciesId } = await studio.request("release", releaseParams());
    await studio.request("addCreature", { speciesId });
    await expect(studio.request("deleteSpecies", { speciesId })).resolves.toBeNull();
    expect(world.creatures.map((c) => c.speciesId)).toEqual(["core:mossling"]);
    expect(await store.list()).toEqual([]);
    expect((await studio.request("snapshot", undefined)).species).toEqual([]);
    await expect(studio.request("deleteSpecies", { speciesId })).rejects.toThrow(
      "is not in the library",
    );
  });
});

describe("the library snapshot", () => {
  it("counts each species' creatures in the world", () => {
    expect(
      countBySpecies([
        { id: "a", speciesId: "x" },
        { id: "b", speciesId: "y" },
        { id: "c", speciesId: "x" },
      ]),
    ).toEqual(
      new Map([
        ["x", 2],
        ["y", 1],
      ]),
    );
  });

  it("lists nothing while the library is opening", async () => {
    const { services } = await setUp({ open: false });
    expect(librarySnapshot(services)).toEqual({ species: [], creatures: 1, maxCreatures: 20 });
  });
});
