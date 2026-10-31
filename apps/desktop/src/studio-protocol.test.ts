import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import {
  error,
  type Diagnostic,
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
import { describeVoxelParts, type CheckedLimits, type Limit } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { MAX_ASSEMBLY_BYTES, openSpeciesLibrary, type SpeciesLibrary } from "./species-library";
import { loadContent } from "./content";
import {
  countBySpecies,
  librarySnapshot,
  studioClient,
  studioErrorCode,
  studioHandlers,
  studioParts,
  tooLargeMessage,
  worldFullMessage,
  NO_LOCOMOTION,
  type LibrarySnapshot,
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

const LAND = { land: true, swim: false };
const BOTH = { land: true, swim: true };
const VOXEL_ID = "00000000-0000-4000-8000-00000000000b";

const voxelParams = (overrides: Partial<ReleaseVoxelParams> = {}): ReleaseVoxelParams => ({
  releaseId: VOXEL_ID,
  assembly: sampleVoxelAssembly(),
  name: "Pebble",
  plan: { locomotion: { land: true, gait: "hop", swim: false } },
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
  it("says when the species was kept but its creature couldn't join", async () => {
    const { studio, world, store } = await setUp();
    world.spawn.mockResolvedValueOnce({
      ok: false,
      diagnostics: [error("world_full", worldFullMessage(20), [])],
    });
    await expect(studioClient(studio).releaseVoxel(voxelParams())).resolves.toMatchObject({
      notAdded: worldFullMessage(20),
    });
    expect(await store.list()).toHaveLength(1);
  });

  it("gives the species the capabilities and gait chosen in the confirm panel", async () => {
    const { studio, world } = await setUp();
    const plan = { locomotion: { land: true, gait: "hop" as const, swim: true } };
    await studioClient(studio).releaseVoxel(voxelParams({ plan }));
    const registered = world.registerSpecies.mock.calls[0]?.[0] as SpeciesDefinition;
    expect(registered.capabilities).toEqual({ "core:land": 1, "core:swim": 1 });
    expect(registered.body).toEqual({ locomotion: { land: { gait: "hop" } } });
  });
});

describe("My creatures", () => {
  it("adds and removes creatures of a species, newest first", async () => {
    const { studio, world } = await setUp();
    const { speciesId } = await studioClient(studio).releaseVoxel(voxelParams());
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
    const { speciesId } = await studioClient(studio).releaseVoxel(voxelParams());
    await expect(studio.request("addCreature", { speciesId })).rejects.toThrow(
      "The world is full (2 creatures). Remove one to add another.",
    );
    expect(world.spawn).toHaveBeenCalledOnce();
  });

  it("deletes a species and takes its creatures out of the world", async () => {
    const { studio, world, store } = await setUp();
    const { speciesId } = await studioClient(studio).releaseVoxel(voxelParams());
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
      socketTypes: ["hollow:leg-mount"],
      suggestedColors: ["#479571"],
    };

    it("answers with the parts, part types, socket types and suggested colours from `ready`", async () => {
      const { studio } = await setUp({ parts: PARTS });
      await expect(studioClient(studio).parts()).resolves.toEqual(PARTS);
    });

    it("keeps the built-in parts, part types, socket types and palette from `ready`", () => {
      const content = loadContent();
      if (!content.ok) throw new Error("The built-in content doesn't load");
      const ready = { ...describeVoxelParts(content.value), propCategories: [] };
      const kept = studioParts(ready);
      expect(Object.keys(kept).sort()).toEqual([
        "partTypes",
        "parts",
        "socketTypes",
        "suggestedColors",
      ]);
      expect(kept.suggestedColors).toEqual(content.value.palettes.get("hollow:woodland")?.colors);
      expect(kept.partTypes.find((t) => t.role === "root")?.id).toBe("hollow:torso");
      expect(kept.parts).toHaveLength(25);
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

    it("refuses an unknown species, and while the library is opening", async () => {
      const { studio } = await setUp();
      const codeOf = async (speciesId: string, channel = studio) =>
        (await refusal(studioClient(channel).assembly(speciesId))).code;
      expect(await codeOf("user:missing")).toBe("unknown_species");
      const starting = await setUp({ open: false });
      expect(await codeOf(userSpeciesIds(VOXEL_ID).speciesId, starting.studio)).toBe("not_ready");
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
        assembly: sampleVoxelAssembly(),
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
          "Pebble has nowhere to appear in this world at its size. Try adding or removing parts to change its size.",
      });
      world.registerSpecies.mockResolvedValueOnce(noSpawn);
      const swimmer = voxelParams({
        plan: { locomotion: { land: false, gait: "walk", swim: true } },
      });
      await expect(refusal(studioClient(studio).releaseVoxel(swimmer))).resolves.toEqual({
        code: "no_spawn_point",
        message:
          "Pebble has nowhere to appear in this world: no starting spot in the water suits it. Let it move on land too, or change its size.",
      });
      expect(await store.list()).toEqual([]);
    });

    it("refuses an assembly that isn't JSON as a failed release", async () => {
      // The channel carries only JSON, so this reaches the handler directly.
      const { services, store } = await setUp();
      const notJson = { parts: {}, instances: [], count: 1n } as unknown as VoxelAssembly;
      const refused = await refusal(
        Promise.resolve(studioHandlers(services).releaseVoxel(voxelParams({ assembly: notJson }))),
      );
      expect(refused.code).toBe("release_failed");
      expect(refused.message).toContain("Pebble's assembly isn't JSON");
      expect(await store.list()).toEqual([]);
    });

    it("checks the size cap first even when an earlier try kept the species", async () => {
      const store = createMemoryLibraryStore();
      await studioClient((await setUp({ store })).studio).releaseVoxel(voxelParams());
      // After the strip reloads, the retry map is empty: the cap comes before the kept species.
      const reloaded = await setUp({ store });
      const refused = await refusal(
        studioClient(reloaded.studio).releaseVoxel(voxelParams({ assembly: HUGE })),
      );
      expect(refused.code).toBe("assembly_too_big");
      expect(reloaded.world.spawn).not.toHaveBeenCalled();
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
