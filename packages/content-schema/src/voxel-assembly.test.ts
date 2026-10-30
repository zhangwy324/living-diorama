import { describe, expect, it } from "vitest";
import {
  assembleParts,
  assemblyWarnings,
  checkAssemblyFit,
  decodeVoxels,
  encodeVoxels,
  MAX_ASSEMBLY_FACES,
  MAX_ASSEMBLY_INSTANCES,
  validate,
  visibleFaces,
  VoxelAssemblySchema,
  VoxelPartSchema,
  type LibraryPart,
  type PartFitLookup,
  type PartTypeDefinition,
  type VoxelAssembly,
  type VoxelPart,
  type VoxelPartInput,
} from "./index";

// Fixture parts built here, like the built-in sample creature's but smaller: content-schema
// imports no content pack.

/** A part from its input, as the schema reads it. */
function part(input: VoxelPartInput): VoxelPart {
  const result = validate(VoxelPartSchema, input);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  return result.value;
}

/** A box of `x × y × z` cubes, 2.5 cm unless `options` says otherwise, all of one colour. */
function box(x: number, y: number, z: number, options: Partial<VoxelPartInput> = {}): VoxelPart {
  return part({
    type: "test:torso",
    size: { x, y, z },
    step: 0.025,
    colors: ["#7fae5a"],
    voxels: [x * y * z, 1],
    attach: { x: x / 2, y: 0, z: z / 2 },
    sockets: [],
    ...options,
  });
}

const hips = (front: number, back: number) => [
  { id: "front-left", type: "test:hip", position: { x: front, y: 1, z: 1.5 } },
  {
    id: "front-right",
    type: "test:hip",
    position: { x: front, y: 1, z: 4.5 },
    mirrors: "front-left",
  },
  { id: "back-left", type: "test:hip", position: { x: back, y: 1, z: 1.5 } },
  {
    id: "back-right",
    type: "test:hip",
    position: { x: back, y: 1, z: 4.5 },
    mirrors: "back-left",
  },
];

/** A torso of 8 × 4 × 6 cubes with two pairs of hips, a neck and a tail root. */
const TORSO: LibraryPart = {
  id: "test:torso",
  part: box(8, 4, 6, {
    attach: { x: 4, y: 2, z: 3 },
    sockets: [
      ...hips(6.5, 1.5),
      { id: "neck", type: "test:neck", position: { x: 7, y: 3, z: 3 } },
      { id: "tail", type: "test:tail-root", position: { x: 1, y: 2.5, z: 3 } },
    ],
  }),
};

/** A head with two eye mounts half a cube in from its front. */
const HEAD: LibraryPart = {
  id: "test:head",
  part: box(3, 3, 4, {
    type: "test:head",
    attach: { x: 0, y: 1, z: 2 },
    sockets: [
      { id: "left-eye", type: "test:eye-mount", position: { x: 2.5, y: 2, z: 1 } },
      {
        id: "right-eye",
        type: "test:eye-mount",
        position: { x: 2.5, y: 2, z: 3 },
        mirrors: "left-eye",
      },
    ],
  }),
};

const THIN_LEG: LibraryPart = {
  id: "test:legs/thin",
  part: box(1, 3, 1, { type: "test:leg", attach: { x: 0.5, y: 3, z: 0.5 } }),
};
/** A leg of 1.25 cm cubes. */
const FINE_LEG: LibraryPart = {
  id: "test:legs/fine",
  part: box(2, 6, 2, { type: "test:leg", step: 0.0125, attach: { x: 1, y: 6, z: 1 } }),
};
/** A leg two cubes wide: on the torso's hips, half a cube off its grid. */
const FAT_LEG: LibraryPart = {
  id: "test:legs/fat",
  part: box(2, 3, 2, { type: "test:leg", attach: { x: 1, y: 3, z: 1 } }),
};
/** An eye of 1.25 cm cubes. */
const EYE: LibraryPart = {
  id: "test:eye",
  part: box(2, 2, 2, { type: "test:eye", step: 0.0125, attach: { x: 0, y: 1, z: 1 } }),
};
/** An eye of 2.5 cm cubes: its mount isn't a 2.5 cm cube deep in the head. */
const BIG_EYE: LibraryPart = {
  id: "test:big-eye",
  part: box(2, 2, 2, { type: "test:eye", attach: { x: 0, y: 1, z: 1 } }),
};
const TAIL: LibraryPart = {
  id: "test:tail",
  part: box(2, 1, 2, { type: "test:tail", attach: { x: 2, y: 0.5, z: 1 } }),
};
/** A leg of an unregistered type, and one with a socket of an unregistered type. */
const WING: LibraryPart = {
  id: "test:wing",
  part: box(1, 3, 1, { type: "test:wing", attach: { x: 0.5, y: 3, z: 0.5 } }),
};
const CLAWED_LEG: LibraryPart = {
  id: "test:legs/clawed",
  part: box(1, 3, 1, {
    type: "test:leg",
    attach: { x: 0.5, y: 3, z: 0.5 },
    sockets: [{ id: "claw", type: "test:claw", position: { x: 0.5, y: 1, z: 0.5 } }],
  }),
};

/**
 * A torso with back hips a cube in from its corners: the fat leg is on the grid there, but
 * flush with the torso's back and sides; the fine leg isn't.
 */
const CORNER: LibraryPart = {
  id: "test:corner-torso",
  part: box(8, 4, 4, {
    attach: { x: 4, y: 2, z: 2 },
    sockets: [
      { id: "back-left", type: "test:hip", position: { x: 1, y: 1, z: 1 } },
      {
        id: "back-right",
        type: "test:hip",
        position: { x: 1, y: 1, z: 3 },
        mirrors: "back-left",
      },
    ],
  }),
};

/** A tail segment with a tail root of its own: segments would hang from segments forever. */
const SEGMENT: LibraryPart = {
  id: "test:segment",
  part: box(2, 3, 2, {
    type: "test:tail",
    attach: { x: 2, y: 1.5, z: 1 },
    sockets: [{ id: "tail", type: "test:tail-root", position: { x: 1, y: 1.5, z: 1 } }],
  }),
};

const LIBRARY = [THIN_LEG, FINE_LEG, FAT_LEG, HEAD, EYE, BIG_EYE, TAIL, WING, CLAWED_LEG];

const partType = (id: string, fits: string[]): PartTypeDefinition => ({
  schemaVersion: 1,
  id,
  version: "1.0.0",
  name: id,
  fits,
});
const PART_TYPES = new Map([
  ["test:torso", partType("test:torso", [])],
  ["test:leg", partType("test:leg", ["test:hip"])],
  ["test:head", partType("test:head", ["test:neck"])],
  ["test:eye", partType("test:eye", ["test:eye-mount"])],
  ["test:tail", partType("test:tail", ["test:tail-root"])],
]);
const SOCKET_TYPES = new Set(["test:hip", "test:neck", "test:eye-mount", "test:tail-root"]);
const lookup = (parts = PART_TYPES) => ({
  partType: (id: string) => parts.get(id),
  socketType: (id: string) =>
    SOCKET_TYPES.has(id)
      ? { schemaVersion: 1 as const, id, version: "1.0.0", name: id }
      : undefined,
});

/** The registered types as the assembler sees them. */
const fitLookup = (parts = PART_TYPES): PartFitLookup => ({
  fitsOf: (id) => parts.get(id)?.fits,
  isSocketType: (id) => SOCKET_TYPES.has(id),
  roleOf: (id) => parts.get(id)?.role,
});

const assemble = (seed: number, parts = LIBRARY, start: LibraryPart | VoxelAssembly = TORSO) =>
  assembleParts({ start, parts, lookup: fitLookup(), seed });

const SEEDS = Array.from({ length: 20 }, (_, i) => i * 7919 + 1);

/** Expects an assembly the validator, the fit check and the flush-face check all pass. */
function expectSound(assembly: VoxelAssembly): void {
  const result = validate(VoxelAssemblySchema, assembly);
  expect(result.ok ? [] : result.diagnostics.map((d) => d.message)).toEqual([]);
  expect(checkAssemblyFit(assembly, lookup())).toEqual([]);
}

/** The part key of each instance by ID. */
const partsById = (assembly: VoxelAssembly) =>
  Object.fromEntries(assembly.instances.map((instance) => [instance.id, instance.part]));

describe("assembleParts", () => {
  it("fills every socket with a part that fits, the root's first", () => {
    for (const seed of SEEDS) {
      const assembly = assemble(seed);
      expectSound(assembly);
      expect(assemblyWarnings(assembly)).toEqual([]);
      expect(assembly.instances.map((instance) => instance.id)).toEqual([
        "torso",
        "front-left",
        "front-right",
        "back-left",
        "back-right",
        "neck",
        "tail",
        "left-eye",
        "right-eye",
      ]);
      const parts = partsById(assembly);
      expect(parts.neck).toBe("head");
      expect(parts.tail).toBe("tail");
      expect(parts["left-eye"]).toBe("eye");
      expect(["legs-thin", "legs-fine"]).toContain(parts["front-left"]);
    }
  });

  it("gives the same assembly for the same seed and parts, in any order", () => {
    for (const seed of SEEDS) {
      expect(assemble(seed, [...LIBRARY].reverse())).toEqual(assemble(seed));
    }
  });

  it("picks different parts for different seeds", () => {
    const legs = new Set(SEEDS.map((seed) => partsById(assemble(seed))["front-left"]));
    expect([...legs].sort()).toEqual(["legs-fine", "legs-thin"]);
  });

  it("gives every socket of a type the same part where it can", () => {
    for (const seed of SEEDS) {
      const parts = partsById(assemble(seed));
      expect(new Set([parts["front-left"], parts["back-left"]]).size).toBe(1);
    }
  });

  it("puts the same part on both sockets of a pair, the mirrored one mirrored", () => {
    const assembly = assemble(SEEDS[0]!);
    const byId = new Map(assembly.instances.map((instance) => [instance.id, instance]));
    for (const [left, right] of [
      ["front-left", "front-right"],
      ["back-left", "back-right"],
      ["left-eye", "right-eye"],
    ] as const) {
      expect(byId.get(right)?.part).toBe(byId.get(left)?.part);
      expect(byId.get(left)?.mirrored).toBe(false);
      expect(byId.get(right)?.mirrored).toBe(true);
    }
  });

  it("holds each library part once, a deep copy with its ID as source", () => {
    const assembly = assemble(SEEDS[0]!);
    expect(Object.keys(assembly.parts).sort()).toEqual(
      ["eye", "head", "tail", "torso", partsById(assembly)["front-left"]!].sort(),
    );
    expect(assembly.parts.head).toEqual({ ...HEAD.part, source: "test:head" });
    expect(assembly.parts.head).not.toBe(HEAD.part);
    expect(assembly.parts.head!.sockets).not.toBe(HEAD.part.sockets);
    expect(assembly.parts.torso?.source).toBe("test:torso");
  });

  it("uses no part whose types aren't registered or that misses the grid or joint depth", () => {
    const used = new Set(
      SEEDS.flatMap((seed) => Object.values(assemble(seed).parts).map((p) => p.source)),
    );
    // Wing: unregistered type. Clawed leg: unregistered socket type. Fat leg: off the grid on
    // every hip. Big eye: its mount isn't one of its cubes deep.
    for (const id of ["test:wing", "test:legs/clawed", "test:legs/fat", "test:big-eye"]) {
      expect(used.has(id), id).toBe(false);
    }
  });

  it("leaves a socket empty when no part can go there", () => {
    const assembly = assemble(SEEDS[0]!, [FAT_LEG, BIG_EYE, HEAD]);
    expectSound(assembly);
    expect(assembly.instances.map((instance) => instance.id)).toEqual(["torso", "neck"]);
  });

  it("passes over a part that would make faces flush, unless every part would", () => {
    for (const seed of SEEDS) {
      const assembly = assemble(seed, [FAT_LEG, FINE_LEG], CORNER);
      expect(partsById(assembly)["back-left"]).toBe("legs-fine");
      expect(assemblyWarnings(assembly)).toEqual([]);
    }
    const flush = assemble(SEEDS[0]!, [FAT_LEG], CORNER);
    expectSound(flush);
    expect(partsById(flush)["back-left"]).toBe("legs-fat");
    expect(assemblyWarnings(flush)).not.toEqual([]);
  });

  it("passes over a part whose two sides of a pair would be flush with each other", () => {
    // Hips half a fat leg apart: two fat legs there overlap, their sides flush with each other's,
    // though with no other part's; two fine legs just touch.
    const close: LibraryPart = {
      id: "test:close-torso",
      part: box(8, 4, 6, {
        attach: { x: 4, y: 2, z: 3 },
        sockets: [
          { id: "left", type: "test:hip", position: { x: 4, y: 1, z: 2 } },
          { id: "right", type: "test:hip", position: { x: 4, y: 1, z: 3 }, mirrors: "left" },
        ],
      }),
    };
    for (const seed of SEEDS) {
      const assembly = assemble(seed, [FAT_LEG, FINE_LEG], close);
      expect(partsById(assembly).left).toBe("legs-fine");
      expect(assemblyWarnings(assembly)).toEqual([]);
    }
    const fat = assemble(SEEDS[0]!, [FAT_LEG], close);
    expect(assemblyWarnings(fat).map((found) => found.message)).toEqual([
      'Parts "left" and "right" have faces flush in one plane',
    ]);
  });

  it("stops at the cap on parts", () => {
    const assembly = assemble(SEEDS[0]!, [THIN_LEG, HEAD, EYE, SEGMENT]);
    expectSound(assembly);
    expect(assembly.instances).toHaveLength(MAX_ASSEMBLY_INSTANCES);
    expect(assembly.instances.at(-1)?.part).toBe("segment");
  });

  it("keeps within the cap on faces, leaving out a pair it can't afford", () => {
    // A checkerboard of 1.25 cm cubes, every cube's six faces drawn: one fits, two don't.
    const size = { x: 32, y: 32, z: 22 };
    const grid = new Uint8Array(size.x * size.y * size.z);
    grid.forEach((_, i) => {
      const x = i % size.x;
      const y = Math.floor(i / size.x) % size.y;
      const z = Math.floor(i / (size.x * size.y));
      grid[i] = (x + y + z) % 2 === 0 ? 1 : 0;
    });
    const noisy = part({
      type: "test:noisy",
      size,
      step: 0.0125,
      colors: ["#7fae5a"],
      voxels: encodeVoxels(grid),
      attach: { x: 16, y: 32, z: 11 },
    });
    const faces = visibleFaces(decodeVoxels(noisy.voxels, noisy.size), noisy.size);
    expect(faces * 2).toBeGreaterThan(MAX_ASSEMBLY_FACES);
    expect(faces).toBeLessThan(MAX_ASSEMBLY_FACES - 1000);

    const types = new Map(PART_TYPES);
    types.set("test:noisy", partType("test:noisy", ["test:hip", "test:tail-root"]));
    const assembly = assembleParts({
      start: TORSO,
      parts: [{ id: "test:noisy", part: noisy }],
      lookup: fitLookup(types),
      seed: 1,
    });
    expect(validate(VoxelAssemblySchema, assembly).ok).toBe(true);
    expect(assembly.instances.map((instance) => instance.id)).toEqual(["torso", "tail"]);
  });

  it("takes a whole-number seed from 0 to 2³² − 1 and refuses others", () => {
    expect(assemble(0xffffffff).instances.length).toBeGreaterThan(1);
    for (const seed of [0.5, Math.random() / 2 + 0.25, -1, 2 ** 32, Number.NaN]) {
      expect(() => assemble(seed), String(seed)).toThrow(RangeError);
    }
  });

  it("refuses a library that lists a part twice", () => {
    expect(() => assemble(1, [THIN_LEG, { ...THIN_LEG }])).toThrow(
      'Part "test:legs/thin" is listed twice',
    );
  });

  it("holds a root that is also in the library once", () => {
    const assembly = assemble(SEEDS[0]!, [SEGMENT], SEGMENT);
    expectSound(assembly);
    expect(Object.keys(assembly.parts)).toEqual(["segment"]);
    expect(assembly.instances).toHaveLength(MAX_ASSEMBLY_INSTANCES);
  });

  describe("filling an assembly", () => {
    /** A torso with its front left leg (a thin one) and a head of its own, without eyes. */
    function started(): VoxelAssembly {
      const leg = { ...THIN_LEG.part, colors: ["#5a4632"] };
      return {
        parts: { torso: TORSO.part, "dark-leg": leg, head: HEAD.part },
        instances: [
          { id: "torso", part: "torso", rotation: [0, 0, 0, 1], mirrored: false },
          {
            id: "leg",
            part: "dark-leg",
            parent: { instance: "torso", socket: "front-left" },
            rotation: [0, 0, 0, 1],
            mirrored: false,
          },
          {
            id: "head",
            part: "head",
            parent: { instance: "torso", socket: "neck" },
            rotation: [0, 0, 0, 1],
            mirrored: false,
          },
        ],
      };
    }

    it("keeps its parts and fills only its free sockets", () => {
      for (const seed of SEEDS) {
        const start = started();
        const assembly = assemble(seed, LIBRARY, start);
        expectSound(assembly);
        expect(assembly.instances.slice(0, 3)).toEqual(start.instances);
        const parts = partsById(assembly);
        // The other side of the pair gets the leg already there.
        expect(parts["front-right"]).toBe("dark-leg");
        expect(parts["left-eye"]).toBe("eye");
        expect(parts.tail).toBe("tail");
        expect(Object.keys(assembly.parts)).not.toContain("head-2");
      }
    });

    it("changes nothing it was given and shares nothing with it", () => {
      const start = started();
      const before = JSON.parse(JSON.stringify(start)) as unknown;
      const assembly = assemble(SEEDS[0]!, LIBRARY, start);
      expect(start).toEqual(before);
      assembly.instances[0]!.rotation[0] = 1;
      assembly.parts.torso!.sockets[0]!.position.x = 0;
      expect(start).toEqual(before);
    });

    it("uses a library part it holds already rather than copying it again", () => {
      for (const seed of SEEDS) {
        const whole = assemble(seed);
        // Without its back legs and its eyes.
        const kept = new Set(["torso", "front-left", "front-right", "neck", "tail"]);
        const partial: VoxelAssembly = {
          parts: Object.fromEntries(Object.entries(whole.parts).filter(([key]) => key !== "eye")),
          instances: whole.instances.filter((instance) => kept.has(instance.id)),
        };
        const refilled = assemble(seed, LIBRARY, partial);
        expectSound(refilled);
        expect(Object.keys(refilled.parts).sort()).toEqual(Object.keys(whole.parts).sort());
        expect(partsById(refilled)["back-left"]).toBe(partsById(whole)["front-left"]);
      }
    });

    it("gives a pair's free side the part on its other side, flush faces or not", () => {
      const fat = assemble(SEEDS[0]!, [FAT_LEG], CORNER);
      const start: VoxelAssembly = {
        parts: fat.parts,
        instances: fat.instances.filter((instance) => instance.id !== "back-right"),
      };
      for (const seed of SEEDS) {
        const assembly = assemble(seed, [FINE_LEG], start);
        expectSound(assembly);
        expect(partsById(assembly)["back-right"]).toBe("legs-fat");
      }
    });

    it("copies a library part afresh when the copy it holds can't go where it can", () => {
      const held = (changes: Partial<VoxelPart>): VoxelAssembly => ({
        parts: {
          torso: TORSO.part,
          segment: { ...SEGMENT.part, source: "test:segment", ...changes },
        },
        instances: [
          { id: "torso", part: "torso", rotation: [0, 0, 0, 1], mirrored: false },
          {
            id: "tail",
            part: "segment",
            parent: { instance: "torso", socket: "tail" },
            rotation: [0, 0, 0, 1],
            mirrored: false,
          },
        ],
      });
      const unregistered = {
        sockets: [
          ...SEGMENT.part.sockets,
          { id: "claw", type: "test:claw", position: { x: 1, y: 1.5, z: 1 } },
        ],
      };
      // A copy edited to another type, which doesn't fit a tail root, or given a socket of a
      // type that isn't registered.
      for (const changes of [{ type: "test:leg" }, unregistered]) {
        const assembly = assemble(SEEDS[0]!, [SEGMENT], held(changes));
        expect(validate(VoxelAssemblySchema, assembly).ok).toBe(true);
        expect(assembly.parts["segment-2"]).toEqual({ ...SEGMENT.part, source: "test:segment" });
        expect(new Set(assembly.instances.slice(2).map((instance) => instance.part))).toEqual(
          new Set(["segment-2"]),
        );
      }
    });
  });
});
