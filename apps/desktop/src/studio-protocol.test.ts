import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import {
  error,
  type Diagnostic,
  type Drawing,
  type Result,
  type SizeClass,
  type SpeciesDefinition,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import {
  createMemoryLibraryStore,
  createMemoryWindowBus,
  openStudioChannel,
  RequestTimeoutError,
  serveStudio,
  StudioRequestError,
  type LibraryStore,
} from "@living-diorama/desktop-integration";
import type { CheckedLimits, Limit } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { MAX_ASSEMBLY_BYTES, openSpeciesLibrary, type SpeciesLibrary } from "./species-library";
import { defaultPlan } from "./body-plan";
import {
  countBySpecies,
  librarySnapshot,
  studioClient,
  studioErrorCode,
  studioHandlers,
  tooLargeMessage,
  worldFullMessage,
  NO_LOCOMOTION,
  type LibrarySnapshot,
  type ReleaseParams,
  type ReleaseVoxelParams,
  type StudioErrorCode,
  type StudioParts,
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
const LAND = { land: true, swim: false };
const BOTH = { land: true, swim: true };
const RELEASE_ID = "00000000-0000-4000-8000-00000000000a";
const PNG = [137, 80, 78, 71];

const releaseParams = (overrides: Partial<ReleaseParams> = {}): ReleaseParams => ({
  releaseId: RELEASE_ID,
  drawing: DRAWING,
  image: PNG,
  name: "Puddle",
  sizeClass: "small",
  thickness: 0.25,
  plan: defaultPlan(),
  ...overrides,
});

/** A world holding one built-in creature, with a cap of `maxCreatures`. */
function fakeWorld() {
  const creatures = [{ id: "m1", speciesId: "core:mossling" }];
  let next = 1;
  return {
    creatures,
    registerSpecies: vi.fn(
      (input: unknown): Promise<Result<{ speciesId: string; limits: Limit[] }>> => {
        const species = input as SpeciesDefinition;
        return Promise.resolve({ ok: true, value: { speciesId: species.id, limits: [] } });
      },
    ),
    spawn: vi.fn((speciesId: string): Promise<Result<string>> => {
      const id = `c${next++}`;
      creatures.push({ id, speciesId });
      return Promise.resolve({ ok: true, value: id });
    }),
    checkAssembly: vi.fn(() => Promise.resolve<Result<Diagnostic[]>>({ ok: true, value: [] })),
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
  parts,
}: {
  maxCreatures?: number;
  store?: LibraryStore;
  open?: boolean;
  checkLimits?: StudioServices["checkLimits"];
  parts?: StudioParts;
} = {}) {
  const world = fakeWorld();
  const changed = vi.fn();
  let library: SpeciesLibrary | undefined;
  if (open) {
    library = await openSpeciesLibrary(
      store,
      {
        ...world,
        creatures: () => world.creatures,
      },
      { onChange: changed },
    );
  }
  const services: StudioServices = {
    library: () => library,
    creatures: () => world.creatures,
    maxCreatures,
    parts: () => parts,
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
  it("checks a size's limits with the capabilities of the chosen ways of moving", async () => {
    const swim = { regionKinds: ["water" as const], animation: "swim", submersion: 0.5 };
    const checkLimits = vi.fn((sizeClass: SizeClass) =>
      Promise.resolve<Result<CheckedLimits>>({
        ok: true,
        value:
          sizeClass === "large"
            ? { limits: [bridge], locomotion: {} }
            : { limits: [], locomotion: { "core:swim": swim } },
      }),
    );
    const { studio } = await setUp({ checkLimits });
    await expect(
      studio.request("limits", { sizeClass: "large", locomotion: LAND }),
    ).resolves.toEqual({ limits: [bridge], locomotion: {} });
    // The capabilities' locomotion rules pass through for the preview (issue #136).
    await expect(
      studio.request("limits", { sizeClass: "small", locomotion: BOTH }),
    ).resolves.toEqual({ limits: [], locomotion: { "core:swim": swim } });
    expect(checkLimits).toHaveBeenCalledWith("large", { "core:land": 1 });
    expect(checkLimits).toHaveBeenCalledWith("small", { "core:land": 1, "core:swim": 1 });
    await expect(
      studio.request("limits", { sizeClass: "small", locomotion: { land: false, swim: false } }),
    ).rejects.toThrow(NO_LOCOMOTION);
    expect(checkLimits).toHaveBeenCalledTimes(2);
  });

  it("passes a rejected query on as an error", async () => {
    const { studio } = await setUp({
      checkLimits: () =>
        Promise.resolve({
          ok: false,
          diagnostics: [error("unknown_size_class", "No size huge", [])],
        }),
    });
    await expect(
      studio.request("limits", { sizeClass: "huge" as SizeClass, locomotion: LAND }),
    ).rejects.toThrow("No size huge");
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

  it("gives the species the body plan and capabilities chosen in the confirm panel", async () => {
    const { studio, world, store } = await setUp();
    const plan = {
      locomotion: { land: true, gait: "hop" as const, swim: true },
      anchors: { tail: { x: 30, y: 120 } },
    };
    await studio.request("release", releaseParams({ plan }));
    const registered = world.registerSpecies.mock.calls[0]?.[0] as SpeciesDefinition;
    expect(registered.capabilities).toEqual({ "core:land": 1, "core:swim": 1 });
    expect(registered.body).toEqual({
      thickness: 0.25,
      locomotion: { land: { gait: "hop" } },
      anchors: { tail: { x: 30, y: 120 } },
    });
    // The library entry (version 5) keeps the plan.
    expect((await store.list())[0]?.entry).toMatchObject({
      schemaVersion: 5,
      species: { body: { anchors: { tail: { x: 30, y: 120 } } }, capabilities: { "core:swim": 1 } },
    });
  });

  it("refuses a body plan with no way of moving before saving anything", async () => {
    const { studio, store } = await setUp();
    const plan = {
      ...defaultPlan(),
      locomotion: { land: false, gait: "walk" as const, swim: false },
    };
    await expect(studio.request("release", releaseParams({ plan }))).rejects.toThrow(NO_LOCOMOTION);
    expect(await store.list()).toEqual([]);
  });

  it("says in the player's words when the world has nowhere for it to appear", async () => {
    const { studio, world, store } = await setUp();
    const noSpawn = {
      ok: false as const,
      diagnostics: [error("no_spawn_point", "No spawn point is walkable for user:x", [])],
    };
    world.registerSpecies.mockResolvedValueOnce(noSpawn);
    await expect(
      studio.request(
        "release",
        releaseParams({
          plan: { ...defaultPlan(), locomotion: { land: false, gait: "walk", swim: true } },
        }),
      ),
    ).rejects.toThrow(
      "Puddle has nowhere to appear in this world: no starting spot in the water suits it.",
    );
    world.registerSpecies.mockResolvedValueOnce(noSpawn);
    await expect(studio.request("release", releaseParams())).rejects.toThrow(
      "Puddle has nowhere to appear in this world at this size. Try another size.",
    );
    expect(await store.list()).toEqual([]);
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

describe("building voxel creatures", () => {
  const VOXEL_ID = "00000000-0000-4000-8000-00000000000b";
  const voxelParams = (overrides: Partial<ReleaseVoxelParams> = {}): ReleaseVoxelParams => ({
    releaseId: VOXEL_ID,
    assembly: sampleVoxelAssembly(),
    name: "Pebble",
    plan: { locomotion: { land: true, gait: "hop", swim: false } },
    ...overrides,
  });
  /** One 32-cube block of 10 cm cubes: 3.2 m, larger than `large`. */
  const BOULDER: VoxelAssembly = {
    parts: {
      block: {
        type: "hollow:torso",
        size: { x: 32, y: 32, z: 32 },
        step: 0.1,
        colors: ["#888888"],
        voxels: [32 * 32 * 32, 1],
        attach: { x: 0, y: 0, z: 0 },
        sockets: [],
      },
    },
    instances: [{ id: "block", part: "block", rotation: [0, 0, 0, 1], mirrored: false }],
  };
  /** Bigger than the cap as JSON, and not even a valid assembly: the cap is checked first. */
  const HUGE = {
    parts: {},
    instances: [],
    padding: "x".repeat(MAX_ASSEMBLY_BYTES),
  } as unknown as VoxelAssembly;

  /** The code and message the request was refused with. */
  const refusal = (request: Promise<unknown>) =>
    request.then(
      () => expect.unreachable("the request was answered"),
      (error: unknown) => ({
        code: studioErrorCode(error),
        message: error instanceof Error ? error.message : String(error),
      }),
    );

  describe("parts", () => {
    const [part] = Object.values(sampleVoxelAssembly().parts);
    if (!part) throw new Error("The sample creature has no parts");
    const PARTS: StudioParts = {
      parts: [{ id: "hollow:pebble", name: "Pebble", version: "1.0.0", part }],
      partTypes: [{ id: "hollow:torso", name: "Torso", fits: [] }],
      socketTypes: ["hollow:hip"],
    };

    it("answers with the parts, part types and socket types from `ready`", async () => {
      const { studio } = await setUp({ parts: PARTS });
      await expect(studioClient(studio).parts()).resolves.toEqual(PARTS);
    });

    it("says the world is still starting before `ready`", async () => {
      const { studio } = await setUp();
      await expect(refusal(studio.request("parts", undefined))).resolves.toEqual({
        code: "not_ready",
        message: "The world is still starting. Try again in a moment.",
      });
    });
  });

  describe("assembly", () => {
    it("gives a released voxel species' assembly and version", async () => {
      const { studio } = await setUp();
      const client = studioClient(studio);
      const { speciesId } = await client.releaseVoxel(voxelParams());
      await expect(client.assembly(speciesId)).resolves.toEqual({
        speciesId,
        version: "1.0.0",
        assembly: sampleVoxelAssembly(),
      });
    });

    it("refuses a drawn species, an unknown one, and while the library is opening", async () => {
      const { studio } = await setUp();
      const drawn = await studio.request("release", releaseParams());
      const codeOf = async (speciesId: string, channel = studio) =>
        (await refusal(studioClient(channel).assembly(speciesId))).code;
      expect(await codeOf(drawn.speciesId)).toBe("not_voxel");
      expect(await codeOf("user:missing")).toBe("unknown_species");
      const starting = await setUp({ open: false });
      expect(await codeOf(drawn.speciesId, starting.studio)).toBe("not_ready");
    });
  });

  describe("releaseVoxel", () => {
    it("saves the assembly under the Studio's ID and adds one creature", async () => {
      const { studio, world, store, changed } = await setUp();
      const { speciesId } = userSpeciesIds(VOXEL_ID);
      await expect(
        studioClient(studio).releaseVoxel(voxelParams({ name: "  Pebble " })),
      ).resolves.toEqual({ speciesId, name: "Pebble" });
      const [stored] = await store.list();
      expect(stored?.id).toBe(VOXEL_ID);
      expect(stored?.entry).toMatchObject({
        species: { name: "Pebble", sizeClass: "medium", body: { locomotion: { land: {} } } },
        body: { kind: "voxel", assembly: sampleVoxelAssembly() },
      });
      expect(world.checkAssembly).toHaveBeenCalledOnce();
      expect(world.spawn).toHaveBeenCalledWith(speciesId, { released: true });
      expect(changed).toHaveBeenCalledOnce();
    });

    it("saves once and adds once when the same release comes again", async () => {
      const { studio, world, store } = await setUp();
      const client = studioClient(studio);
      const [first, second] = await Promise.all([
        client.releaseVoxel(voxelParams()),
        client.releaseVoxel(voxelParams()),
      ]);
      const third = await client.releaseVoxel(voxelParams());
      expect(second).toEqual(first);
      expect(third).toEqual(first);
      expect(await store.list()).toHaveLength(1);
      expect(world.registerSpecies).toHaveBeenCalledOnce();
      expect(world.spawn).toHaveBeenCalledOnce();
    });

    it("after the strip reloads, adds a creature of a species an earlier try kept", async () => {
      const store = createMemoryLibraryStore();
      await studioClient((await setUp({ store })).studio).releaseVoxel(voxelParams());
      const reloaded = await setUp({ store });
      await studioClient(reloaded.studio).releaseVoxel(voxelParams());
      expect(await store.list()).toHaveLength(1);
      expect(reloaded.world.checkAssembly).not.toHaveBeenCalled();
      expect(reloaded.world.spawn).toHaveBeenCalledOnce();
    });

    it("refuses an assembly over the size cap before anything else (#208)", async () => {
      // A full world and a library still opening would refuse it too, but the cap comes first.
      const { studio } = await setUp({ open: false, maxCreatures: 1 });
      await expect(
        refusal(studioClient(studio).releaseVoxel(voxelParams({ assembly: HUGE }))),
      ).resolves.toEqual({
        code: "assembly_too_big",
        message: "Pebble has too much detail to save. Use fewer or smaller parts.",
      });
    });

    it("refuses one larger than `large`, saving nothing (ADR 0023 §14)", async () => {
      const { studio, world, store } = await setUp();
      const boulder = voxelParams({ name: "Boulder", assembly: BOULDER });
      await expect(refusal(studioClient(studio).releaseVoxel(boulder))).resolves.toEqual({
        code: "too_large",
        message: tooLargeMessage("Boulder"),
      });
      expect(world.registerSpecies).not.toHaveBeenCalled();
      expect(await store.list()).toEqual([]);
    });

    it("refuses one with nowhere to appear, in the player's words (ADR 0023 §14)", async () => {
      const { studio, world, store } = await setUp();
      const noSpawn = {
        ok: false as const,
        diagnostics: [error("no_spawn_point", "No spawn point is walkable for user:x", [])],
      };
      world.registerSpecies.mockResolvedValueOnce(noSpawn);
      await expect(refusal(studioClient(studio).releaseVoxel(voxelParams()))).resolves.toEqual({
        code: "no_spawn_point",
        message:
          "Pebble has nowhere to appear in this world at its size. Try making it bigger or smaller.",
      });
      world.registerSpecies.mockResolvedValueOnce(noSpawn);
      const swimmer = voxelParams({
        plan: { locomotion: { land: false, gait: "walk", swim: true } },
      });
      const refused = await refusal(studioClient(studio).releaseVoxel(swimmer));
      expect(refused.code).toBe("no_spawn_point");
      expect(refused.message).toContain("no starting spot in the water suits it");
      expect(await store.list()).toEqual([]);
    });

    it("refuses one whose parts don't fit, as a failed release", async () => {
      const { studio, world } = await setUp();
      world.checkAssembly.mockResolvedValueOnce({
        ok: true,
        value: [error("part_does_not_fit", "The leg doesn't fit the neck", [])],
      });
      await expect(refusal(studioClient(studio).releaseVoxel(voxelParams()))).resolves.toEqual({
        code: "release_failed",
        message: "Pebble couldn't be released: The leg doesn't fit the neck",
      });
    });

    it("refuses bad settings and a full world, and the same ID may try again after", async () => {
      const { studio, world, store } = await setUp({ maxCreatures: 1 });
      const client = studioClient(studio);
      const codeOf = async (params: ReleaseVoxelParams) =>
        (await refusal(client.releaseVoxel(params))).code;
      const still = { land: false, gait: "walk", swim: false } as const;
      const expected: [ReleaseVoxelParams, StudioErrorCode][] = [
        [voxelParams({ name: " " }), "invalid_request"],
        [voxelParams({ plan: { locomotion: still } }), "invalid_request"],
        [voxelParams({ releaseId: "not-a-uuid" }), "invalid_request"],
        [voxelParams(), "world_full"],
      ];
      for (const [params, code] of expected) expect(await codeOf(params)).toBe(code);
      expect(await store.list()).toEqual([]);
      world.creatures.splice(0);
      await expect(client.releaseVoxel(voxelParams())).resolves.toMatchObject({ name: "Pebble" });
    });

    it("refuses while the library is still opening", async () => {
      const { studio } = await setUp({ open: false });
      const refused = await refusal(studioClient(studio).releaseVoxel(voxelParams()));
      expect(refused.code).toBe("not_ready");
    });
  });

  it("reads no code from a failure the strip didn't refuse", () => {
    expect(studioErrorCode(new StudioRequestError("too_large", "Big"))).toBe("too_large");
    expect(studioErrorCode(new RequestTimeoutError("releaseVoxel"))).toBeUndefined();
    expect(studioErrorCode(new Error("Lost"))).toBeUndefined();
  });
});
