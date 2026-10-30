import { describe, expect, it } from "vitest";
import {
  assembleParts,
  attachPart,
  compatibleSockets,
  MAX_ASSEMBLY_INSTANCES,
  MAX_UNDO_STEPS,
  measureAssembly,
  mirrorImage,
  placeInstances,
  recolorPart,
  recordEdit,
  redoEdit,
  removePart,
  replacePart,
  rotatePart,
  scoreSockets,
  startHistory,
  stepAssembly,
  stepPart,
  stepUnits,
  undoEdit,
  validate,
  VOXEL_UNIT,
  VoxelAssemblySchema,
  VoxelPartSchema,
  type AssemblyEditResult,
  type LibraryPart,
  type PartFitLookup,
  type VoxelAssembly,
  type VoxelPart,
  type VoxelPartInput,
} from "./index";

// Fixture parts built here, all on 2.5 cm cubes unless they say otherwise.

function part(input: VoxelPartInput): VoxelPart {
  const result = validate(VoxelPartSchema, input);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  return result.value;
}

function box(x: number, y: number, z: number, options: Partial<VoxelPartInput> = {}): VoxelPart {
  return part({
    type: "test:torso",
    size: { x, y, z },
    step: 0.025,
    colors: ["#7fae5a", "#334455"],
    voxels: [x * y * z, 1],
    attach: { x: x / 2, y: 0, z: z / 2 },
    sockets: [],
    ...options,
  });
}

/** A torso of 8 × 4 × 6 cubes: two pairs of hips, a neck, a tail root and a belly. */
const TORSO: LibraryPart = {
  id: "test:torso",
  part: box(8, 4, 6, {
    attach: { x: 4, y: 2, z: 3 },
    sockets: [
      { id: "left-hip", type: "test:hip", position: { x: 2, y: 1, z: 2 } },
      { id: "right-hip", type: "test:hip", position: { x: 2, y: 1, z: 4 }, mirrors: "left-hip" },
      { id: "front-left-hip", type: "test:hip", position: { x: 6, y: 1, z: 2 } },
      {
        id: "front-right-hip",
        type: "test:hip",
        position: { x: 6, y: 1, z: 4 },
        mirrors: "front-left-hip",
      },
      { id: "neck", type: "test:neck", position: { x: 7, y: 3, z: 3 } },
      { id: "tail", type: "test:tail-root", position: { x: 1, y: 2, z: 3 } },
      { id: "belly", type: "test:belly", position: { x: 4.5, y: 1, z: 3 } },
    ],
  }),
};

/** A torso whose right hip is half a cube off: a leg fits its left hip but not, mirrored, its right. */
const LOPSIDED: LibraryPart = {
  id: "test:lopsided",
  part: box(8, 4, 6, {
    attach: { x: 4, y: 2, z: 3 },
    sockets: [
      { id: "left-hip", type: "test:hip", position: { x: 2, y: 1, z: 2 } },
      { id: "right-hip", type: "test:hip", position: { x: 2, y: 1, z: 4.5 }, mirrors: "left-hip" },
    ],
  }),
};

/** A leg with a foot socket. */
const LEG: LibraryPart = {
  id: "test:legs/long",
  part: box(2, 4, 2, {
    type: "test:leg",
    attach: { x: 1, y: 4, z: 1 },
    sockets: [{ id: "foot", type: "test:foot", position: { x: 1, y: 1, z: 1 } }],
  }),
};
/** A leg with a foot socket under another name. */
const PEG: LibraryPart = {
  id: "test:legs/peg",
  part: box(2, 4, 2, {
    type: "test:leg",
    attach: { x: 1, y: 4, z: 1 },
    sockets: [{ id: "toe", type: "test:foot", position: { x: 1, y: 1, z: 1 } }],
  }),
};
/** A short leg whose foot socket has the same ID as `LEG`'s. */
const STUMP: LibraryPart = {
  id: "test:legs/stump",
  part: box(2, 3, 2, {
    type: "test:leg",
    colors: ["#aa0000"],
    attach: { x: 1, y: 3, z: 1 },
    sockets: [{ id: "foot", type: "test:foot", position: { x: 1, y: 1, z: 1 } }],
  }),
};
/** A leg with a mirror pair of claw sockets of its own. */
const CLAWED: LibraryPart = {
  id: "test:legs/clawed",
  part: box(2, 4, 4, {
    type: "test:leg",
    attach: { x: 1, y: 4, z: 2 },
    sockets: [
      { id: "left-claw", type: "test:foot", position: { x: 1, y: 1, z: 1 } },
      { id: "right-claw", type: "test:foot", position: { x: 1, y: 1, z: 3 }, mirrors: "left-claw" },
    ],
  }),
};
/** Another foot. */
const PAD: LibraryPart = {
  id: "test:pad",
  part: box(2, 1, 2, { type: "test:foot", colors: ["#123123"], attach: { x: 1, y: 1, z: 1 } }),
};
const FOOT: LibraryPart = {
  id: "test:foot",
  part: box(2, 1, 2, { type: "test:foot", attach: { x: 1, y: 1, z: 1 } }),
};
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
/** An eye of 1.25 cm cubes. */
const EYE: LibraryPart = {
  id: "test:eye",
  part: box(2, 2, 2, { type: "test:eye", step: 0.0125, attach: { x: 0, y: 1, z: 1 } }),
};
/** A fin whose attach point is off its middle: only half turns keep it on the grid. */
const FIN: LibraryPart = {
  id: "test:fin",
  part: box(2, 2, 2, { type: "test:fin", attach: { x: 0.5, y: 2, z: 1 } }),
};
/** A fin on the grid at its own step only. */
const STICK: LibraryPart = {
  id: "test:stick",
  part: box(1, 4, 2, { type: "test:fin", attach: { x: 0.5, y: 4, z: 1 } }),
};
/** A tail segment with a tail root of its own. */
const SEGMENT: LibraryPart = {
  id: "test:segment",
  part: box(2, 2, 2, {
    type: "test:tail",
    attach: { x: 2, y: 1, z: 1 },
    sockets: [{ id: "tail", type: "test:tail-root", position: { x: 1, y: 1, z: 1 } }],
  }),
};
/** A part of a type that isn't registered. */
const WING: LibraryPart = {
  id: "test:wing",
  part: box(2, 4, 2, { type: "test:wing", attach: { x: 1, y: 4, z: 1 } }),
};

const FITS = new Map([
  ["test:torso", []],
  ["test:leg", ["test:hip"]],
  ["test:foot", ["test:foot"]],
  ["test:head", ["test:neck"]],
  ["test:eye", ["test:eye-mount"]],
  ["test:fin", ["test:belly"]],
  ["test:tail", ["test:tail-root"]],
]);
const lookup: PartFitLookup = {
  fitsOf: (id) => FITS.get(id),
  isSocketType: () => true,
  roleOf: (id) => (id === "test:torso" ? "root" : undefined),
};
const MIRROR = { mirror: true };
const SINGLE = { mirror: false };

/** A fresh creature: the torso alone. */
const start = (root: LibraryPart = TORSO): VoxelAssembly =>
  assembleParts({ start: root, parts: [], lookup, seed: 0 });

/** The assembly an edit made, failing the test on a refusal. */
function ok(result: AssemblyEditResult): VoxelAssembly {
  if (!result.ok) throw new Error(`${result.refusal.code}: ${result.refusal.message}`);
  expect(VoxelAssemblySchema.safeParse(result.assembly).success).toBe(true);
  return result.assembly;
}

/** The refusal code of an edit, failing the test when it went through. */
function refusal(result: AssemblyEditResult): string {
  if (result.ok) throw new Error("The edit went through");
  return result.refusal.code;
}

const ids = (assembly: VoxelAssembly) => assembly.instances.map((i) => i.id);
const byId = (assembly: VoxelAssembly, id: string) => {
  const instance = assembly.instances.find((i) => i.id === id);
  if (!instance) throw new Error(`No instance "${id}"`);
  return instance;
};
const partOf = (assembly: VoxelAssembly, id: string) => {
  const found = assembly.parts[byId(assembly, id).part];
  if (!found) throw new Error(`No part for "${id}"`);
  return found;
};

/** The torso with legs on both hips and a foot on each leg. */
function legged(): VoxelAssembly {
  let a = ok(attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR));
  a = ok(attachPart(a, { instance: "left-hip", socket: "foot" }, FOOT, lookup, SINGLE));
  return ok(attachPart(a, { instance: "right-hip", socket: "foot" }, FOOT, lookup, SINGLE));
}

describe("attachPart", () => {
  it("hangs a part on a free socket and its mirror pair", () => {
    const before = start();
    const result = attachPart(
      before,
      { instance: "torso", socket: "left-hip" },
      LEG,
      lookup,
      MIRROR,
    );
    const after = ok(result);
    expect(result.ok && result.instances).toEqual(["left-hip", "right-hip"]);
    expect(after.instances.slice(1)).toEqual([
      {
        id: "left-hip",
        part: "legs-long",
        parent: { instance: "torso", socket: "left-hip" },
        rotation: [0, 0, 0, 1],
        mirrored: false,
      },
      {
        id: "right-hip",
        part: "legs-long",
        parent: { instance: "torso", socket: "right-hip" },
        rotation: [0, 0, 0, 1],
        mirrored: true,
      },
    ]);
    expect(after.parts["legs-long"]).toEqual({ ...LEG.part, source: LEG.id });
    expect(after.parts["legs-long"]).not.toBe(LEG.part);
    // Structural sharing: the input is untouched and its objects reused.
    expect(before.instances).toHaveLength(1);
    expect(after.instances[0]).toBe(before.instances[0]);
    expect(after.parts.torso).toBe(before.parts.torso);
  });

  it("mirrors from the mirrored socket of a pair too", () => {
    const after = ok(
      attachPart(start(), { instance: "torso", socket: "right-hip" }, LEG, lookup, MIRROR),
    );
    expect(ids(after)).toEqual(["torso", "right-hip", "left-hip"]);
    expect(byId(after, "left-hip").mirrored).toBe(false);
  });

  it("hangs a part on one socket alone without mirroring", () => {
    const after = ok(
      attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, SINGLE),
    );
    expect(ids(after)).toEqual(["torso", "left-hip"]);
  });

  it("leaves a taken other socket as it is", () => {
    const one = ok(
      attachPart(start(), { instance: "torso", socket: "right-hip" }, STUMP, lookup, SINGLE),
    );
    const both = ok(
      attachPart(one, { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR),
    );
    expect(ids(both)).toEqual(["torso", "right-hip", "left-hip"]);
    expect(byId(both, "right-hip").part).toBe("legs-stump");
  });

  it("reuses an unedited copy of a library part and copies an edited one again", () => {
    const one = ok(
      attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, SINGLE),
    );
    const two = ok(
      attachPart(one, { instance: "torso", socket: "right-hip" }, LEG, lookup, SINGLE),
    );
    expect(Object.keys(two.parts)).toEqual(["torso", "legs-long"]);
    const red = ok(recolorPart(one, "left-hip", 0, "#ff0000", SINGLE));
    const again = ok(
      attachPart(red, { instance: "torso", socket: "right-hip" }, LEG, lookup, SINGLE),
    );
    expect(Object.keys(again.parts)).toEqual(["torso", "legs-long", "legs-long-2"]);
    expect(byId(again, "right-hip").part).toBe("legs-long-2");
    expect(again.parts["legs-long-2"]?.colors[0]).toBe("#7fae5a");
  });

  it("names a new instance after its socket, numbered on a clash", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR));
    a = ok(attachPart(a, { instance: "left-hip", socket: "foot" }, FOOT, lookup, SINGLE));
    a = ok(attachPart(a, { instance: "right-hip", socket: "foot" }, FOOT, lookup, SINGLE));
    expect(ids(a)).toEqual(["torso", "left-hip", "right-hip", "foot", "foot-2"]);
  });

  it("refuses what can't go there", () => {
    const a = start();
    expect(refusal(attachPart(a, { instance: "nope", socket: "neck" }, HEAD, lookup, MIRROR))).toBe(
      "unknown_instance",
    );
    expect(
      refusal(attachPart(a, { instance: "torso", socket: "nope" }, HEAD, lookup, MIRROR)),
    ).toBe("unknown_socket");
    expect(refusal(attachPart(a, { instance: "torso", socket: "neck" }, LEG, lookup, MIRROR))).toBe(
      "does_not_fit",
    );
    expect(
      refusal(attachPart(a, { instance: "torso", socket: "left-hip" }, WING, lookup, MIRROR)),
    ).toBe("does_not_fit");
    const head = ok(attachPart(a, { instance: "torso", socket: "neck" }, HEAD, lookup, MIRROR));
    expect(
      refusal(attachPart(head, { instance: "torso", socket: "neck" }, HEAD, lookup, MIRROR)),
    ).toBe("socket_taken");
  });

  it("refuses a pair when the mirrored side breaks the grid, both or neither", () => {
    const a = start(LOPSIDED);
    expect(
      refusal(attachPart(a, { instance: "lopsided", socket: "left-hip" }, LEG, lookup, MIRROR)),
    ).toBe("invalid");
    expect(
      ids(ok(attachPart(a, { instance: "lopsided", socket: "left-hip" }, LEG, lookup, SINGLE))),
    ).toEqual(["lopsided", "left-hip"]);
  });

  it(`holds at most ${MAX_ASSEMBLY_INSTANCES} parts`, () => {
    let a = start();
    let tip = { instance: "torso", socket: "tail" };
    while (a.instances.length < MAX_ASSEMBLY_INSTANCES - 1) {
      const result = attachPart(a, tip, SEGMENT, lookup, SINGLE);
      a = ok(result);
      tip = { instance: result.ok ? (result.instances[0] ?? "") : "", socket: "tail" };
    }
    expect(
      refusal(attachPart(a, { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR)),
    ).toBe("too_many_parts");
    a = ok(attachPart(a, { instance: "torso", socket: "left-hip" }, LEG, lookup, SINGLE));
    expect(a.instances).toHaveLength(MAX_ASSEMBLY_INSTANCES);
    expect(refusal(attachPart(a, tip, SEGMENT, lookup, SINGLE))).toBe("too_many_parts");
  });

  it("is deterministic", () => {
    const run = () => legged();
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe("compatibleSockets", () => {
  it("lists the free sockets a part fits, in order", () => {
    const a = legged();
    expect(compatibleSockets(start(), LEG, lookup, MIRROR)).toEqual([
      { instance: "torso", socket: "left-hip" },
      { instance: "torso", socket: "right-hip" },
      { instance: "torso", socket: "front-left-hip" },
      { instance: "torso", socket: "front-right-hip" },
    ]);
    expect(compatibleSockets(a, LEG, lookup, MIRROR)).toEqual([
      { instance: "torso", socket: "front-left-hip" },
      { instance: "torso", socket: "front-right-hip" },
    ]);
    expect(compatibleSockets(start(), HEAD, lookup, MIRROR)).toEqual([
      { instance: "torso", socket: "neck" },
    ]);
    expect(compatibleSockets(start(), WING, lookup, MIRROR)).toEqual([]);
  });

  it("leaves out sockets the part can't go on, as attachPart would", () => {
    expect(compatibleSockets(start(LOPSIDED), LEG, lookup, MIRROR)).toEqual([]);
    expect(compatibleSockets(start(LOPSIDED), LEG, lookup, SINGLE)).toEqual([
      { instance: "lopsided", socket: "left-hip" },
    ]);
  });
});

describe("mirrorImage", () => {
  it("finds the instance on the other socket of the pair", () => {
    const a = legged();
    expect(mirrorImage(a, "left-hip")?.id).toBe("right-hip");
    expect(mirrorImage(a, "right-hip")?.id).toBe("left-hip");
    expect(mirrorImage(a, "torso")).toBeUndefined();
    const one = ok(removePart(a, "right-hip", SINGLE));
    expect(mirrorImage(one, "left-hip")).toBeUndefined();
  });

  it("follows the same sockets down the other side of the nearest pair", () => {
    const a = legged();
    expect(mirrorImage(a, "foot")?.id).toBe("foot-2");
    expect(mirrorImage(a, "foot-2")?.id).toBe("foot");
    expect(mirrorImage(ok(removePart(a, "foot-2", SINGLE)), "foot")).toBeUndefined();
  });

  it("finds no image when the sides differ", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, SINGLE));
    a = ok(attachPart(a, { instance: "torso", socket: "right-hip" }, PEG, lookup, SINGLE));
    a = ok(attachPart(a, { instance: "left-hip", socket: "foot" }, FOOT, lookup, MIRROR));
    a = ok(attachPart(a, { instance: "right-hip", socket: "toe" }, FOOT, lookup, MIRROR));
    expect(ids(a)).toEqual(["torso", "left-hip", "right-hip", "foot", "toe"]);
    expect(mirrorImage(a, "foot")).toBeUndefined();
    expect(mirrorImage(a, "toe")).toBeUndefined();
  });

  it("counts only the nearest pair, so images never compound", () => {
    let a = ok(
      attachPart(start(), { instance: "torso", socket: "left-hip" }, CLAWED, lookup, MIRROR),
    );
    a = ok(attachPart(a, { instance: "left-hip", socket: "left-claw" }, FOOT, lookup, MIRROR));
    // The pair of claws on the left leg, not one on each leg.
    expect(ids(a)).toEqual(["torso", "left-hip", "right-hip", "left-claw", "right-claw"]);
    expect(byId(a, "right-claw").parent).toEqual({ instance: "left-hip", socket: "right-claw" });
    expect(mirrorImage(a, "left-claw")?.id).toBe("right-claw");
    a = ok(attachPart(a, { instance: "right-hip", socket: "left-claw" }, FOOT, lookup, MIRROR));
    expect(ids(a)).toHaveLength(7);
    expect(mirrorImage(a, "left-claw")?.id).toBe("right-claw");
    expect(mirrorImage(a, "left-claw-2")?.id).toBe("right-claw-2");
  });
});

describe("whole-branch mirroring", () => {
  it("puts a hand on the left arm on the right arm too", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR));
    const result = attachPart(a, { instance: "left-hip", socket: "foot" }, FOOT, lookup, MIRROR);
    a = ok(result);
    expect(result.ok && result.instances).toEqual(["foot", "foot-2"]);
    expect(byId(a, "foot-2")).toEqual({
      id: "foot-2",
      part: "foot",
      parent: { instance: "right-hip", socket: "foot" },
      rotation: [0, 0, 0, 1],
      mirrored: false,
    });
    expect(compatibleSockets(ok(removePart(a, "foot", MIRROR)), FOOT, lookup, MIRROR)).toEqual([
      { instance: "left-hip", socket: "foot" },
      { instance: "right-hip", socket: "foot" },
    ]);
  });

  it("acts on the image in every edit", () => {
    const a = legged();
    expect(ids(ok(removePart(a, "foot", MIRROR)))).toEqual(["torso", "left-hip", "right-hip"]);
    expect(ok(rotatePart(a, "foot", MIRROR)).instances.map((i) => i.rotation)).toEqual([
      [0, 0, 0, 1],
      [0, 0, 0, 1],
      [0, 0, 0, 1],
      [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    ]);
    const red = ok(recolorPart(a, "foot", 0, "#ff0000", MIRROR));
    expect(Object.keys(red.parts)).toEqual(Object.keys(a.parts));
    expect(partOf(red, "foot-2").colors[0]).toBe("#ff0000");
    const replaced = ok(replacePart(a, "foot-2", PAD, lookup, MIRROR));
    expect(partOf(replaced, "foot")).toBe(partOf(replaced, "foot-2"));
    expect(byId(replaced, "foot").part).toBe("pad");
    const stepped = ok(stepPart(a, "foot", -1, MIRROR));
    expect(partOf(stepped, "foot-2").step).toBe(0.0125);
  });
});

describe("replacePart", () => {
  it("replaces a part and its twin, re-hanging children by socket ID", () => {
    const before = legged();
    const result = replacePart(before, "left-hip", STUMP, lookup, MIRROR);
    const after = ok(result);
    expect(result.ok && result.instances).toEqual(["left-hip", "right-hip"]);
    expect(ids(after)).toEqual(ids(before));
    expect(byId(after, "left-hip").part).toBe("legs-stump");
    expect(byId(after, "right-hip").part).toBe("legs-stump");
    expect(Object.keys(after.parts)).toEqual(["torso", "foot", "legs-stump"]);
    expect(byId(after, "foot")).toBe(byId(before, "foot"));
  });

  it("shares what it doesn't change", () => {
    let before = legged();
    before = ok(attachPart(before, { instance: "torso", socket: "neck" }, HEAD, lookup, MIRROR));
    const after = ok(replacePart(before, "left-hip", STUMP, lookup, MIRROR));
    expect(after.parts.torso).toBe(before.parts.torso);
    expect(after.parts.head).toBe(before.parts.head);
    for (const id of ["torso", "neck", "foot", "foot-2"]) {
      expect(byId(after, id)).toBe(byId(before, id));
    }
  });

  it("removes children the new part has no socket for", () => {
    const after = ok(replacePart(legged(), "left-hip", PEG, lookup, MIRROR));
    expect(ids(after)).toEqual(["torso", "left-hip", "right-hip"]);
    expect(Object.keys(after.parts)).toEqual(["torso", "legs-peg"]);
  });

  it("replaces one side alone without mirroring", () => {
    const after = ok(replacePart(legged(), "left-hip", PEG, lookup, SINGLE));
    expect(ids(after)).toEqual(["torso", "left-hip", "right-hip", "foot-2"]);
    expect(byId(after, "right-hip").part).toBe("legs-long");
  });

  it("re-hangs a child only when it still fits", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "neck" }, HEAD, lookup, MIRROR));
    a = ok(attachPart(a, { instance: "neck", socket: "left-eye" }, EYE, lookup, MIRROR));
    // A head whose eye sockets take feet: the eyes no longer fit.
    const footHead: LibraryPart = {
      id: "test:foot-head",
      part: {
        ...HEAD.part,
        sockets: HEAD.part.sockets.map((s) => ({ ...s, type: "test:foot" })),
      },
    };
    expect(ids(ok(replacePart(a, "neck", footHead, lookup, MIRROR)))).toEqual(["torso", "neck"]);
    expect(ids(ok(replacePart(a, "neck", HEAD, lookup, MIRROR)))).toEqual(ids(a));
  });

  it("re-hangs a child only where the assembly stays valid", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "neck" }, HEAD, lookup, MIRROR));
    a = ok(attachPart(a, { instance: "neck", socket: "left-eye" }, EYE, lookup, MIRROR));
    // A head whose right eye mount is on its front face, not a cube deep.
    const flat: LibraryPart = {
      id: "test:flat-head",
      part: {
        ...HEAD.part,
        sockets: HEAD.part.sockets.map((s) =>
          s.id === "right-eye" ? { ...s, position: { ...s.position, x: 3 } } : s,
        ),
      },
    };
    expect(ids(ok(replacePart(a, "neck", flat, lookup, MIRROR)))).toEqual([
      "torso",
      "neck",
      "left-eye",
    ]);
  });

  it("replaces the root, re-hanging what fits", () => {
    const after = ok(replacePart(legged(), "torso", LOPSIDED, lookup, MIRROR));
    // The lopsided torso's right hip is off the grid for a mirrored leg.
    expect(ids(after)).toEqual(["torso", "left-hip", "foot"]);
    expect(Object.keys(after.parts)).toEqual(["legs-long", "foot", "lopsided"]);
  });

  it("replaces the root only with a part of a root type", () => {
    expect(refusal(replacePart(legged(), "torso", HEAD, lookup, MIRROR))).toBe("not_root");
    const noRoles = { ...lookup, roleOf: () => undefined };
    expect(refusal(replacePart(legged(), "torso", LOPSIDED, noRoles, MIRROR))).toBe("not_root");
  });

  it("refuses a part that doesn't fit the socket", () => {
    expect(refusal(replacePart(legged(), "left-hip", HEAD, lookup, MIRROR))).toBe("does_not_fit");
    expect(refusal(replacePart(legged(), "nope", LEG, lookup, MIRROR))).toBe("unknown_instance");
  });

  it("refuses when the new part itself breaks a joint, on either side", () => {
    let a = ok(
      attachPart(
        start(LOPSIDED),
        { instance: "lopsided", socket: "left-hip" },
        LEG,
        lookup,
        SINGLE,
      ),
    );
    a = ok(attachPart(a, { instance: "lopsided", socket: "right-hip" }, ODD_LEG, lookup, SINGLE));
    expect(refusal(replacePart(a, "left-hip", STUMP, lookup, MIRROR))).toBe("invalid");
    expect(ok(replacePart(a, "left-hip", STUMP, lookup, SINGLE)).instances).toHaveLength(3);
  });
});

/** A leg one cube deep: on the grid on the lopsided torso's right hip, mirrored. */
const ODD_LEG: LibraryPart = {
  id: "test:legs/odd",
  part: box(2, 4, 1, { type: "test:leg", attach: { x: 1, y: 4, z: 0.5 } }),
};

describe("removePart", () => {
  it("removes a subtree and its twin's, dropping unused parts", () => {
    const before = legged();
    const result = removePart(before, "left-hip", MIRROR);
    const after = ok(result);
    expect(result.ok && result.instances).toEqual(["left-hip", "right-hip", "foot", "foot-2"]);
    expect(ids(after)).toEqual(["torso"]);
    expect(Object.keys(after.parts)).toEqual(["torso"]);
    expect(after.parts.torso).toBe(before.parts.torso);
  });

  it("removes one side alone without mirroring", () => {
    const after = ok(removePart(legged(), "right-hip", SINGLE));
    expect(ids(after)).toEqual(["torso", "left-hip", "foot"]);
    expect(Object.keys(after.parts)).toEqual(["torso", "legs-long", "foot"]);
  });

  it("lists the one asked for first", () => {
    const result = removePart(legged(), "right-hip", MIRROR);
    expect(result.ok && result.instances).toEqual(["right-hip", "left-hip", "foot", "foot-2"]);
  });

  it("refuses the root, children and all", () => {
    const before = legged();
    expect(before.instances.length).toBeGreaterThan(1);
    expect(refusal(removePart(before, "torso", MIRROR))).toBe("root");
    expect(refusal(removePart(before, "torso", SINGLE))).toBe("root");
    expect(refusal(removePart(before, "nope", MIRROR))).toBe("unknown_instance");
  });
});

describe("rotatePart", () => {
  const HALF = Math.SQRT1_2;

  it("cycles quarter turns about the socket's Y axis, pair together", () => {
    let a = legged();
    const seen: number[][] = [];
    for (let i = 0; i < 4; i++) {
      a = ok(rotatePart(a, "left-hip", MIRROR));
      seen.push([...byId(a, "left-hip").rotation]);
      expect(byId(a, "right-hip").rotation).toEqual(byId(a, "left-hip").rotation);
    }
    expect(seen).toEqual([
      [0, HALF, 0, HALF],
      [0, 1, 0, 0],
      [0, HALF, 0, -HALF].map((v) => -v + 0),
      [0, 0, 0, 1],
    ]);
  });

  it("turns one side alone without mirroring", () => {
    const a = ok(rotatePart(legged(), "left-hip", SINGLE));
    expect(byId(a, "right-hip").rotation).toEqual([0, 0, 0, 1]);
  });

  it("skips turns that break the grid", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "belly" }, FIN, lookup, MIRROR));
    a = ok(rotatePart(a, "belly", MIRROR));
    expect(byId(a, "belly").rotation).toEqual([0, 1, 0, 0]);
    a = ok(rotatePart(a, "belly", MIRROR));
    expect(byId(a, "belly").rotation).toEqual([0, 0, 0, 1]);
  });

  it("never drifts off exact quarter turns", () => {
    let a = legged();
    for (let i = 0; i < 400; i++) a = ok(rotatePart(a, "left-hip", MIRROR));
    expect(byId(a, "left-hip").rotation).toEqual([0, 0, 0, 1]);
  });

  it("sets the twin to the turned part's rotation, bringing a pair back in step", () => {
    let a = ok(rotatePart(legged(), "left-hip", SINGLE));
    expect(byId(a, "right-hip").rotation).toEqual([0, 0, 0, 1]);
    a = ok(rotatePart(a, "left-hip", MIRROR));
    expect(byId(a, "left-hip").rotation).toEqual([0, 1, 0, 0]);
    expect(byId(a, "right-hip").rotation).toEqual([0, 1, 0, 0]);
  });

  it("refuses the root", () => {
    expect(refusal(rotatePart(legged(), "torso", MIRROR))).toBe("root");
    expect(refusal(rotatePart(legged(), "nope", MIRROR))).toBe("unknown_instance");
  });
});

describe("stepPart", () => {
  it("steps the instance and its twin, copying a copy shared beyond them", () => {
    let before = ok(
      attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR),
    );
    before = ok(
      attachPart(before, { instance: "torso", socket: "front-left-hip" }, LEG, lookup, MIRROR),
    );
    expect(before.instances.filter((i) => i.part === "legs-long")).toHaveLength(4);
    const result = stepPart(before, "left-hip", 1, MIRROR);
    const after = ok(result);
    expect(result.ok && result.instances).toEqual(["left-hip", "right-hip"]);
    expect(partOf(after, "left-hip").step).toBe(0.05);
    expect(byId(after, "left-hip").part).toBe("legs-long-2");
    expect(byId(after, "right-hip").part).toBe("legs-long-2");
    expect(byId(after, "front-left-hip")).toBe(byId(before, "front-left-hip"));
    expect(after.parts["legs-long"]).toBe(before.parts["legs-long"]);
  });

  it("edits a copy in place when the pair alone uses it", () => {
    const before = legged();
    const after = ok(stepPart(before, "left-hip", -1, MIRROR));
    expect(Object.keys(after.parts)).toEqual(Object.keys(before.parts));
    expect(after.parts["legs-long"]?.step).toBe(0.0125);
    expect(after.parts["legs-long"]?.voxels).toBe(before.parts["legs-long"]?.voxels);
    expect(after.instances).toBe(before.instances);
  });

  it("shares what it doesn't change", () => {
    const before = legged();
    const after = ok(stepPart(before, "left-hip", 1, SINGLE));
    expect(after.parts.torso).toBe(before.parts.torso);
    expect(after.parts.foot).toBe(before.parts.foot);
    expect(after.parts["legs-long"]).toBe(before.parts["legs-long"]);
    for (const id of ["torso", "right-hip", "foot", "foot-2"]) {
      expect(byId(after, id)).toBe(byId(before, id));
    }
  });

  it("steps one side alone without mirroring, copying the shared copy", () => {
    const after = ok(stepPart(legged(), "left-hip", 1, SINGLE));
    expect(partOf(after, "left-hip").step).toBe(0.05);
    expect(partOf(after, "right-hip").step).toBe(0.025);
    expect(byId(after, "left-hip").part).toBe("legs-long-2");
  });

  it("refuses at the ladder's ends and where the grid snap breaks", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "neck" }, HEAD, lookup, MIRROR));
    a = ok(attachPart(a, { instance: "neck", socket: "left-eye" }, EYE, lookup, MIRROR));
    expect(refusal(stepPart(a, "left-eye", -1, MIRROR))).toBe("ladder_end");
    const stick = ok(
      attachPart(start(), { instance: "torso", socket: "belly" }, STICK, lookup, MIRROR),
    );
    expect(refusal(stepPart(stick, "belly", 1, MIRROR))).toBe("invalid");
    expect(refusal(stepPart(stick, "belly", -1, MIRROR))).toBe("invalid");
    expect(refusal(stepPart(stick, "nope", 1, MIRROR))).toBe("unknown_instance");
  });

  it("refuses where a joint breaks", () => {
    // A 2.5 cm eye: its mount, half a cube in from the head's front, isn't a whole cube deep.
    let a = ok(attachPart(start(), { instance: "torso", socket: "neck" }, HEAD, lookup, MIRROR));
    a = ok(attachPart(a, { instance: "neck", socket: "left-eye" }, EYE, lookup, MIRROR));
    const result = stepPart(a, "left-eye", 1, MIRROR);
    expect(refusal(result)).toBe("invalid");
    expect(!result.ok && result.refusal.message).toMatch(/deep inside/);
  });
});

describe("stepAssembly", () => {
  it("steps every part together, keeping their ratios", () => {
    const before = legged();
    const up = ok(stepAssembly(before, 1));
    expect(Object.values(up.parts).map((p) => p.step)).toEqual([0.05, 0.05, 0.05]);
    expect(up.instances).toBe(before.instances);
    const size = (a: VoxelAssembly) => measureAssembly(a).height;
    expect(size(up)).toBeCloseTo(size(before) * 2);
    expect(ok(stepAssembly(up, -1))).toEqual(before);
  });

  it("refuses when a part is at the end of the ladder", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "neck" }, HEAD, lookup, MIRROR));
    a = ok(attachPart(a, { instance: "neck", socket: "left-eye" }, EYE, lookup, MIRROR));
    expect(refusal(stepAssembly(a, -1))).toBe("ladder_end");
    let top = start();
    top = ok(stepAssembly(top, 1));
    top = ok(stepAssembly(top, 1));
    expect(refusal(stepAssembly(top, 1))).toBe("ladder_end");
  });
});

describe("recolorPart", () => {
  it("recolours the pair's copy in place when they alone use it", () => {
    const before = legged();
    const result = recolorPart(before, "right-hip", 1, "#123456", MIRROR);
    const after = ok(result);
    expect(result.ok && result.instances).toEqual(["right-hip", "left-hip"]);
    expect(after.parts["legs-long"]?.colors).toEqual(["#7fae5a", "#123456"]);
    expect(before.parts["legs-long"]?.colors).toEqual(["#7fae5a", "#334455"]);
    expect(after.instances).toBe(before.instances);
  });

  it("copies a copy shared beyond the pair first", () => {
    // Four legs of one copy: recolouring a pair copies it.
    let before = ok(
      attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR),
    );
    before = ok(
      attachPart(before, { instance: "torso", socket: "front-left-hip" }, LEG, lookup, MIRROR),
    );
    const after = ok(recolorPart(before, "right-hip", 0, "#000000", MIRROR));
    expect(byId(after, "right-hip").part).toBe("legs-long-2");
    expect(byId(after, "left-hip").part).toBe("legs-long-2");
    expect(byId(after, "front-left-hip")).toBe(byId(before, "front-left-hip"));
    expect(after.parts["legs-long"]).toBe(before.parts["legs-long"]);
    expect(after.parts["legs-long-2"]?.colors[0]).toBe("#000000");
  });

  it("recolours one side alone without mirroring", () => {
    const after = ok(recolorPart(legged(), "left-hip", 0, "#000000", SINGLE));
    expect(partOf(after, "left-hip").colors[0]).toBe("#000000");
    expect(partOf(after, "right-hip").colors[0]).toBe("#7fae5a");
  });

  it("leaves a twin without that colour alone", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, SINGLE));
    a = ok(attachPart(a, { instance: "torso", socket: "right-hip" }, STUMP, lookup, SINGLE));
    const after = ok(recolorPart(a, "left-hip", 1, "#000000", MIRROR));
    expect(partOf(after, "right-hip")).toBe(partOf(a, "right-hip"));
  });

  it("returns the assembly as it is when the colour is already that", () => {
    const before = legged();
    const result = recolorPart(before, "foot", 0, "#7FAE5A", MIRROR);
    expect(ok(result)).toBe(before);
    expect(result.ok && result.instances).toEqual(["foot", "foot-2"]);
    const history = startHistory(before);
    expect(recordEdit(history, ok(result))).toBe(history);
  });

  it("recolours only the side that differs", () => {
    const one = ok(recolorPart(legged(), "left-hip", 0, "#000000", SINGLE));
    const both = ok(recolorPart(one, "left-hip", 0, "#000000", MIRROR));
    expect(partOf(both, "right-hip").colors[0]).toBe("#000000");
    expect(partOf(both, "left-hip")).toBe(partOf(one, "left-hip"));
  });

  it("names a copy of a copy from the base key", () => {
    let a = ok(attachPart(start(), { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR));
    a = ok(attachPart(a, { instance: "torso", socket: "front-left-hip" }, LEG, lookup, MIRROR));
    a = ok(stepPart(a, "left-hip", 1, MIRROR));
    expect(byId(a, "left-hip").part).toBe("legs-long-2");
    a = ok(recolorPart(a, "left-hip", 0, "#000000", SINGLE));
    expect(byId(a, "left-hip").part).toBe("legs-long-3");
    expect(Object.keys(a.parts)).toEqual(["torso", "legs-long", "legs-long-2", "legs-long-3"]);
  });

  it("refuses an unknown colour index and an invalid colour", () => {
    expect(refusal(recolorPart(legged(), "left-hip", 2, "#000000", MIRROR))).toBe("unknown_color");
    expect(refusal(recolorPart(legged(), "left-hip", -1, "#000000", MIRROR))).toBe("unknown_color");
    expect(refusal(recolorPart(legged(), "left-hip", 0, "red", MIRROR))).toBe("invalid_color");
  });
});

describe("scoreSockets", () => {
  const sockets = [
    { instance: "torso", socket: "left-hip" },
    { instance: "torso", socket: "right-hip" },
    { instance: "torso", socket: "neck" },
  ];

  it("places a socket where a part on it has its attach point", () => {
    const a = legged();
    const [scored] = scoreSockets(a, [{ instance: "left-hip", socket: "foot" }], {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    });
    const foot = a.instances.findIndex((i) => i.id === "foot");
    const { linear, offset } = placeInstances(a)[foot] ?? { linear: [], offset: [0, 0, 0] };
    const footPart = partOf(a, "foot");
    const step = stepUnits(footPart.step);
    const attach = [footPart.attach.x * step, footPart.attach.y * step, footPart.attach.z * step];
    const { origin } = measureAssembly(a);
    const at = [0, 1, 2].map(
      (row) =>
        ((linear[row * 3] ?? 0) * (attach[0] ?? 0) +
          (linear[row * 3 + 1] ?? 0) * (attach[1] ?? 0) +
          (linear[row * 3 + 2] ?? 0) * (attach[2] ?? 0) +
          (offset[row] ?? 0) -
          (origin[row] ?? 0)) *
        VOXEL_UNIT,
    );
    expect(scored?.position.x).toBeCloseTo(at[0] ?? NaN);
    expect(scored?.position.y).toBeCloseTo(at[1] ?? NaN);
    expect(scored?.position.z).toBeCloseTo(at[2] ?? NaN);
  });

  it("ranks the socket the probe points at first", () => {
    const a = start();
    const [neck] = scoreSockets(a, [{ instance: "torso", socket: "neck" }], {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    });
    const from = { x: 1, y: 0.5, z: 1 };
    const at = (p: { x: number; y: number; z: number }) => ({
      origin: from,
      direction: { x: p.x - from.x, y: p.y - from.y, z: p.z - from.z },
    });
    const ranked = scoreSockets(a, sockets, at(neck?.position ?? from));
    expect(ranked).toHaveLength(3);
    expect(ranked[0]?.socket).toBe("neck");
    expect(ranked[0]?.angle).toBeCloseTo(0);
  });

  it("breaks a tie in angle by distance", () => {
    const a = start();
    const [left, right] = scoreSockets(a, sockets.slice(0, 2), {
      origin: { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
    });
    // From far out along the line through both hips, both lie dead ahead; the nearer one wins.
    const dz = (right?.position.z ?? 0) - (left?.position.z ?? 0);
    const origin = {
      x: left?.position.x ?? 0,
      y: left?.position.y ?? 0,
      z: (left?.position.z ?? 0) - 10 * dz,
    };
    const ranked = scoreSockets(a, [...sockets.slice(0, 2)].reverse(), {
      origin,
      direction: { x: 0, y: 0, z: 1 },
    });
    expect(ranked.map((s) => s.socket)).toEqual(["left-hip", "right-hip"]);
  });

  it("throws on an unknown socket and a zero direction", () => {
    const probe = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } };
    expect(() => scoreSockets(start(), [{ instance: "torso", socket: "nope" }], probe)).toThrow();
    expect(() =>
      scoreSockets(start(), sockets, { ...probe, direction: { x: 0, y: 0, z: 0 } }),
    ).toThrow(RangeError);
  });
});

describe("history", () => {
  it("undoes and redoes whole snapshots", () => {
    const a0 = start();
    const a1 = ok(attachPart(a0, { instance: "torso", socket: "left-hip" }, LEG, lookup, MIRROR));
    const a2 = ok(rotatePart(a1, "left-hip", MIRROR));
    let h = recordEdit(recordEdit(startHistory(a0), a1), a2);
    expect(h.present).toBe(a2);
    h = undoEdit(h);
    expect(h.present).toBe(a1);
    h = undoEdit(h);
    expect(h.present).toBe(a0);
    expect(undoEdit(h)).toBe(h);
    h = redoEdit(h);
    expect(h.present).toBe(a1);
    expect(h.future).toEqual([a2]);
    // A new edit forgets the redo steps.
    const b = ok(removePart(a1, "left-hip", MIRROR));
    h = recordEdit(h, b);
    expect(h.future).toEqual([]);
    expect(redoEdit(h)).toBe(h);
    expect(h.past).toEqual([a0, a1]);
  });

  it("ignores recording the present again", () => {
    const h = startHistory(start());
    expect(recordEdit(h, h.present)).toBe(h);
  });

  it(`keeps at most ${MAX_UNDO_STEPS} undo steps`, () => {
    let a = legged();
    let h = startHistory(a);
    for (let i = 0; i < MAX_UNDO_STEPS + 10; i++) {
      a = ok(rotatePart(a, "left-hip", MIRROR));
      h = recordEdit(h, a);
    }
    expect(h.past).toHaveLength(MAX_UNDO_STEPS);
  });
});
