import { describe, expect, it } from "vitest";
import {
  assemblyWarnings,
  boneTransform,
  CHILD_PART_INSET,
  instanceInset,
  checkAssemblyFit,
  decodeVoxels,
  encodeVoxels,
  measureAssembly,
  mirrorQuaternion,
  placeInstances,
  quarterTurnMatrix,
  sizeClassFor,
  stepUnits,
  validate,
  visibleFaces,
  VoxelAssemblySchema,
  VoxelPartSchema,
  type InstancePlacement,
  type PartTypeDefinition,
  type Quaternion,
  type Result,
  type VoxelAssembly,
  type VoxelAssemblyInput,
  type VoxelPartInput,
} from "./index";

const messages = (result: Result<unknown>) =>
  result.ok ? [] : result.diagnostics.map((d) => d.message);
const paths = (result: Result<unknown>) =>
  result.ok ? [] : result.diagnostics.map((d) => d.path.join("."));

/** A box of `x × y × z` cubes of 2.5 cm, all of one colour. */
function box(
  x: number,
  y: number,
  z: number,
  options: Partial<VoxelPartInput> = {},
): VoxelPartInput {
  return {
    type: "test:torso",
    size: { x, y, z },
    step: 0.025,
    colors: ["#7fae5a"],
    voxels: [x * y * z, 1],
    attach: { x: x / 2, y: 0, z: z / 2 },
    sockets: [],
    ...options,
  };
}

const HALF_TURN_Y: Quaternion = [0, 1, 0, 0];
const QUARTER_TURN_Y: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

/**
 * A torso of 8 × 4 × 4 cubes of 2.5 cm with four legs 3 cubes long, one cube deep in its
 * underside, a head on its front and a tail at its back.
 */
function creature(): VoxelAssemblyInput {
  return {
    parts: {
      torso: box(8, 4, 4, {
        attach: { x: 4, y: 2, z: 2 },
        sockets: [
          { id: "front-left", type: "test:hip", position: { x: 6.5, y: 1, z: 1.5 } },
          {
            id: "front-right",
            type: "test:hip",
            position: { x: 6.5, y: 1, z: 2.5 },
            mirrors: "front-left",
          },
          { id: "back-left", type: "test:hip", position: { x: 1.5, y: 1, z: 1.5 } },
          {
            id: "back-right",
            type: "test:hip",
            position: { x: 1.5, y: 1, z: 2.5 },
            mirrors: "back-left",
          },
          { id: "neck", type: "test:neck", position: { x: 7, y: 3, z: 2 } },
          { id: "tail", type: "test:tail-root", position: { x: 1, y: 2.5, z: 2 } },
        ],
      }),
      leg: box(1, 3, 1, { type: "test:leg", attach: { x: 0.5, y: 3, z: 0.5 } }),
      head: box(3, 3, 2, { type: "test:head", attach: { x: 0, y: 1, z: 1 } }),
      tail: box(2, 1, 2, { type: "test:tail", attach: { x: 2, y: 0.5, z: 1 } }),
    },
    instances: [
      { id: "torso", part: "torso" },
      { id: "front-left", part: "leg", parent: { instance: "torso", socket: "front-left" } },
      {
        id: "front-right",
        part: "leg",
        parent: { instance: "torso", socket: "front-right" },
        mirrored: true,
      },
      { id: "back-left", part: "leg", parent: { instance: "torso", socket: "back-left" } },
      {
        id: "back-right",
        part: "leg",
        parent: { instance: "torso", socket: "back-right" },
        mirrored: true,
      },
      { id: "head", part: "head", parent: { instance: "torso", socket: "neck" } },
      { id: "tail", part: "tail", parent: { instance: "torso", socket: "tail" } },
    ],
  };
}

function parsed(input: VoxelAssemblyInput = creature()): VoxelAssembly {
  const result = validate(VoxelAssemblySchema, input);
  if (!result.ok) throw new Error(messages(result).join("\n"));
  return result.value;
}

/** Expects each number of `actual` close to `expected`'s. */
function close(actual: object, expected: Record<string, number>): void {
  const values = actual as Record<string, number>;
  for (const [key, value] of Object.entries(expected)) {
    expect(values[key], key).toBeCloseTo(value);
  }
}

describe("run-length encoding", () => {
  it("round-trips a grid, x fastest", () => {
    const size = { x: 3, y: 2, z: 2 };
    const grid = Uint8Array.from([0, 0, 1, 1, 1, 2, 2, 0, 0, 0, 0, 3]);
    const voxels = encodeVoxels(grid);
    expect(voxels).toEqual([2, 0, 3, 1, 2, 2, 4, 0, 1, 3]);
    expect(decodeVoxels(voxels, size)).toEqual(grid);
  });

  it("decodes into a grid padded with one empty cube on every side", () => {
    const size = { x: 2, y: 1, z: 1 };
    const padded = decodeVoxels([1, 5, 1, 0], size, { padded: true });
    expect(padded).toHaveLength(4 * 3 * 3);
    // Cube (0, 0, 0) is at (1, 1, 1) of the 4 × 3 × 3 grid; cube (1, 0, 0) is empty.
    const at = 1 + 4 * (1 + 3 * 1);
    expect([...padded.keys()].filter((i) => padded[i] !== 0)).toEqual([at]);
    expect(padded[at]).toBe(5);
  });

  it("counts the faces a mesher draws", () => {
    const solid = new Uint8Array(8).fill(1);
    expect(visibleFaces(solid, { x: 2, y: 2, z: 2 })).toBe(24);
    expect(visibleFaces(Uint8Array.from([1, 0, 0, 1]), { x: 2, y: 2, z: 1 })).toBe(12);
    expect(visibleFaces(new Uint8Array(8), { x: 2, y: 2, z: 2 })).toBe(0);
  });

  it("shrinks parts more the deeper they hang", () => {
    expect(instanceInset(0)).toBe(0);
    expect(instanceInset(2)).toBe(2 * CHILD_PART_INSET);
  });

  it("encodes an empty grid as nothing", () => {
    expect(encodeVoxels(new Uint8Array())).toEqual([]);
  });
});

describe("VoxelPartSchema", () => {
  const check = (part: unknown) => validate(VoxelPartSchema, part);

  it("accepts a part", () => {
    expect(check(box(2, 2, 2)).ok).toBe(true);
  });

  it("accepts every step of the ladder and nothing else", () => {
    for (const step of [0.0125, 0.025, 0.05, 0.1] as const) {
      expect(check(box(1, 1, 1, { step })).ok).toBe(true);
    }
    for (const step of [0.2, 0.03, 0]) {
      expect(paths(check({ ...box(1, 1, 1), step }))).toEqual(["step"]);
    }
    expect(([0.0125, 0.025, 0.05, 0.1] as const).map(stepUnits)).toEqual([2, 4, 8, 16]);
  });

  it("caps a part at 32 cubes along each axis and 255 colours", () => {
    expect(check(box(32, 32, 32)).ok).toBe(true);
    expect(paths(check(box(33, 1, 1)))).toContain("size.x");
    expect(paths(check(box(1, 0, 1)))).toContain("size.y");
    const colors = Array.from({ length: 256 }, () => "#000000");
    expect(paths(check(box(1, 1, 1, { colors })))).toEqual(["colors"]);
    expect(check(box(1, 1, 1, { colors: colors.slice(1), voxels: [1, 255] })).ok).toBe(true);
  });

  it.each([
    ["an odd number of values", [8], "Voxels come in pairs: run, colour index"],
    ["runs short of the size", [7, 1], "The runs add up to 7 cubes, not the part's 8"],
    ["runs past the size", [8, 1, 1, 0], "The runs add up to 9 cubes, not the part's 8"],
    ["a colour past the list", [8, 2], "Colour index 2 is past the part's 1 colours"],
    ["an empty run", [0, 1, 8, 1], "A run is at least 1 cube"],
    ["no cubes at all", [8, 0], "A part needs at least one cube"],
  ])("rejects voxels with %s", (_, voxels, message) => {
    expect(messages(check(box(2, 2, 2, { voxels })))).toEqual([message]);
  });

  it("allows half cubes but not quarters, inside the part", () => {
    expect(check(box(2, 2, 2, { attach: { x: 0.5, y: 2, z: 1.5 } })).ok).toBe(true);
    expect(paths(check(box(2, 2, 2, { attach: { x: 0.25, y: 0, z: 0 } })))).toEqual(["attach.x"]);
    expect(paths(check(box(2, 2, 2, { attach: { x: 0, y: 2.5, z: -0.5 } })))).toEqual([
      "attach.y",
      "attach.z",
    ]);
    const socket = { id: "s", type: "test:hip", position: { x: 3, y: 0, z: 0 } };
    expect(paths(check(box(2, 2, 2, { sockets: [socket] })))).toEqual(["sockets.0.position.x"]);
  });

  it("checks socket IDs and mirror pairs", () => {
    const socket = (id: string, mirrors?: string, type = "test:hip") => ({
      id,
      type,
      position: { x: 1, y: 1, z: 1 },
      ...(mirrors === undefined ? {} : { mirrors }),
    });
    const sockets = (...list: ReturnType<typeof socket>[]) =>
      messages(check(box(2, 2, 2, { sockets: list })));
    expect(sockets(socket("a"), socket("b", "a"))).toEqual([]);
    expect(sockets(socket("a"), socket("a"))).toEqual(['Duplicate socket ID "a"']);
    expect(sockets(socket("a", "x"))).toEqual([`Socket "x" isn't another socket of this part`]);
    expect(sockets(socket("a", "a"))).toEqual([`Socket "a" isn't another socket of this part`]);
    expect(sockets(socket("a"), socket("b", "a"), socket("c", "b"))).toEqual([
      `Socket "b" is itself a mirrored socket`,
    ]);
    expect(sockets(socket("a"), socket("b", "a"), socket("c", "a"))).toEqual([
      `Socket "a" is already mirrored by another socket`,
    ]);
    expect(sockets(socket("a"), socket("b", "a", "test:neck"))).toEqual([
      "A socket mirrors only a socket of its own type (a is test:hip)",
    ]);
  });
});

describe("quarterTurnMatrix", () => {
  it("turns quarter turns into whole-number matrices", () => {
    expect(quarterTurnMatrix([0, 0, 0, 1])).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(quarterTurnMatrix(QUARTER_TURN_Y)).toEqual([0, 0, 1, 0, 1, 0, -1, 0, 0]);
    expect(quarterTurnMatrix(HALF_TURN_Y)).toEqual([-1, 0, 0, 0, 1, 0, 0, 0, -1]);
    // A third of a turn about a cube's diagonal maps the axes onto each other too.
    expect(quarterTurnMatrix([0.5, 0.5, 0.5, 0.5])).toEqual([0, 0, 1, 1, 0, 0, 0, 1, 0]);
  });

  it("mirrors a rotation in the creature's XY plane", () => {
    const mirror = [1, 0, 0, 0, 1, 0, 0, 0, -1];
    const times = (a: number[], b: number[]) =>
      [0, 1, 2].flatMap((r) =>
        [0, 1, 2].map((c) => [0, 1, 2].reduce((sum, k) => sum + a[r * 3 + k]! * b[k * 3 + c]!, 0)),
      );
    for (const q of [QUARTER_TURN_Y, HALF_TURN_Y, [0.5, 0.5, 0.5, 0.5] as Quaternion]) {
      const turned = quarterTurnMatrix(q)!;
      expect(quarterTurnMatrix(mirrorQuaternion(q))).toEqual(
        times(times(mirror, turned), mirror).map((v) => v + 0),
      );
    }
  });

  it("refuses other turns and quaternions that aren't unit", () => {
    expect(quarterTurnMatrix([0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)])).toBeUndefined();
    expect(quarterTurnMatrix([0, 0, 0, 2])).toBeUndefined();
    expect(quarterTurnMatrix([0, 0, 0, 0])).toBeUndefined();
  });
});

describe("VoxelAssemblySchema", () => {
  const check = (assembly: VoxelAssemblyInput) => validate(VoxelAssemblySchema, assembly);

  it("accepts a creature", () => {
    expect(messages(check(creature()))).toEqual([]);
  });

  it("fills in the rest rotation and the mirror flag", () => {
    const [root] = parsed().instances;
    expect(root).toEqual({ id: "torso", part: "torso", rotation: [0, 0, 0, 1], mirrored: false });
  });

  it("caps an assembly at 32 instances, and needs one", () => {
    const assembly = creature();
    const legs = Array.from({ length: 32 }, (_, i) => ({
      id: `leg-${i}`,
      part: "leg",
      parent: { instance: "torso", socket: "front-left" },
    }));
    expect(paths(check({ ...assembly, instances: [assembly.instances[0]!, ...legs] }))).toEqual([
      "instances",
    ]);
    expect(messages(check({ ...assembly, instances: [] }))).toEqual([
      "An assembly needs a root part",
    ]);
  });

  it("has one root, listed first", () => {
    const assembly = creature();
    const [root, leg, ...rest] = assembly.instances;
    expect(messages(check({ ...assembly, instances: [leg!, root!, ...rest] }))).toContain(
      "The first instance is the root and hangs from no socket",
    );
    const orphan = { id: leg!.id, part: leg!.part };
    expect(messages(check({ ...assembly, instances: [root!, orphan, ...rest] }))).toEqual([
      "Only the root, the first instance, hangs from no socket",
    ]);
  });

  it("hangs every other instance from one listed before it", () => {
    const assembly = creature();
    const [root, leg, ...rest] = assembly.instances;
    const late = { ...leg!, parent: { instance: "head", socket: "neck" } };
    expect(messages(check({ ...assembly, instances: [root!, late, ...rest] }))).toEqual([
      'The parent "head" must be an instance listed before this one',
    ]);
    const self = { ...leg!, parent: { instance: "front-left", socket: "neck" } };
    expect(messages(check({ ...assembly, instances: [root!, self, ...rest] }))).toEqual([
      'The parent "front-left" must be an instance listed before this one',
    ]);
  });

  it("refuses duplicate instance IDs, unknown parts and unused parts", () => {
    const assembly = creature();
    const instances = assembly.instances.map((instance) =>
      instance.id === "head" ? { ...instance, id: "tail" } : instance,
    );
    expect(messages(check({ ...assembly, instances }))).toEqual(['Duplicate instance ID "tail"']);
    const unknown = assembly.instances.map((instance) =>
      instance.id === "head" ? { ...instance, part: "skull" } : instance,
    );
    expect(messages(check({ ...assembly, instances: unknown }))).toEqual([
      'Unknown part "skull"',
      'Part "head" is used by no instance',
    ]);
  });

  it("needs the socket to exist and be free", () => {
    const assembly = creature();
    const instances = assembly.instances.map((instance) =>
      instance.id === "back-left"
        ? { ...instance, parent: { instance: "torso", socket: "front-left" } }
        : instance.id === "head"
          ? { ...instance, parent: { instance: "torso", socket: "chin" } }
          : instance,
    );
    expect(messages(check({ ...assembly, instances }))).toEqual([
      'Socket "torso/front-left" is already taken by "front-left"',
      'Part "torso" has no socket "chin"',
    ]);
  });

  it("mirrors the part on a mirrored socket, and only that one", () => {
    const assembly = creature();
    const instances = assembly.instances.map((instance) =>
      instance.id === "front-right"
        ? { ...instance, mirrored: false }
        : instance.id === "back-left"
          ? { ...instance, mirrored: true }
          : instance,
    );
    expect(paths(check({ ...assembly, instances }))).toEqual([
      "instances.2.mirrored",
      "instances.3.mirrored",
    ]);
    const root = { ...assembly.instances[0]!, mirrored: true };
    expect(
      messages(check({ ...assembly, instances: [root, ...assembly.instances.slice(1)] })),
    ).toEqual(["The root isn't mirrored"]);
  });

  it("allows only a unit quaternion of quarter turns as the rest rotation", () => {
    const assembly = creature();
    const rotate = (rotation: Quaternion) => ({
      ...assembly,
      instances: assembly.instances.map((instance) =>
        instance.id === "tail" ? { ...instance, rotation } : instance,
      ),
    });
    const eighth: Quaternion = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
    for (const rotation of [eighth, [0, 0, 0, 0.5] as Quaternion]) {
      expect(messages(check(rotate(rotation)))).toEqual([
        "The rest rotation must be a unit quaternion of quarter turns",
      ]);
    }
    // Half a turn about Y swings the tail inside the torso, which is allowed.
    expect(messages(check(rotate(HALF_TURN_Y)))).toEqual([]);
  });

  it("puts a socket at least one cube of the finer grid deep inside its parent", () => {
    const assembly = creature();
    const torso = assembly.parts.torso!;
    const at = (position: { x: number; y: number; z: number }, step: 0.0125 | 0.025 | 0.05) => ({
      ...assembly,
      parts: {
        ...assembly.parts,
        torso: {
          ...torso,
          sockets: torso.sockets!.map((s) => (s.id === "tail" ? { ...s, position } : s)),
        },
        tail: { ...assembly.parts.tail!, step },
      },
    });
    // At the torso's back face (x = 0) the tail would show a gap as it swings.
    expect(messages(check(at({ x: 0, y: 2.5, z: 2 }, 0.025)))).toEqual([
      'Socket "tail" must lie at least one cube of the finer grid (2.5 cm) deep inside part "torso"',
    ]);
    // Half a torso cube deep is too shallow for a tail of torso cubes…
    expect(messages(check(at({ x: 0.5, y: 2.5, z: 2 }, 0.025)))[0]).toMatch(/deep inside/);
    // …but is one cube deep for a tail of 1.25 cm cubes, which isn't buried a whole torso cube.
    const fine = at({ x: 0.5, y: 2.5, z: 2 }, 0.0125);
    fine.parts.tail = { ...fine.parts.tail, attach: { x: 2, y: 1, z: 1 } };
    expect(messages(check(fine))).toEqual([]);
    // A coarser child lies one of its parent's cubes deep.
    expect(messages(check(at({ x: 0, y: 2, z: 2 }, 0.05)))).toEqual([
      'Socket "tail" must lie at least one cube of the finer grid (2.5 cm) deep inside part "torso"',
    ]);
    expect(messages(check(at({ x: 1, y: 2, z: 2 }, 0.05)))).toEqual([]);
  });

  it("counts only filled cubes as inside the parent", () => {
    const assembly = creature();
    const torso = assembly.parts.torso!;
    // Hollow out a cube next to the tail's socket.
    const grid = decodeVoxels(torso.voxels, torso.size);
    grid[0 + 8 * (3 + 4 * 2)] = 0;
    const hollow = { ...torso, voxels: encodeVoxels(grid) };
    expect(messages(check({ ...assembly, parts: { ...assembly.parts, torso: hollow } }))).toEqual([
      'Socket "tail" must lie at least one cube of the finer grid (2.5 cm) deep inside part "torso"',
    ]);
  });

  it("snaps a child half a cube off the finer grid onto it, toward its parent's middle", () => {
    // ADR 0022 §13, as amended by ADR 0023 (M21 PR 7): never refused, always moved.
    const assembly = creature();
    const headAt = (input: VoxelAssemblyInput) => placeInstances(parsed(input))[5]!.offset;
    expect(headAt(assembly)).toEqual([12, 0, -4]);
    // An attach point on a half cube puts the head half a cube off the torso's grid along z. The
    // neck is on the torso's middle plane, so the head moves toward +z, half a cube (2 units).
    const offGrid = { ...assembly.parts.head!, attach: { x: 0, y: 1, z: 1.5 } };
    const snapped = { ...assembly, parts: { ...assembly.parts, head: offGrid } };
    expect(messages(check(snapped))).toEqual([]);
    expect(headAt(snapped)).toEqual([12, 0, -4]);
    // A finer head may sit half a torso cube off the torso's grid, on its own: no move.
    const fine = { ...offGrid, step: 0.0125 as const, attach: { x: 0, y: 1, z: 1 } };
    expect(headAt({ ...assembly, parts: { ...assembly.parts, head: fine } })).toEqual([12, 2, -2]);
    // A rotation counts: a quarter turn about Y moves the attach point's half cube from z to x.
    // The neck now lies past the torso's middle along both x and z, so the head moves back along
    // both, toward the middle.
    const torso = assembly.parts.torso!;
    const sockets = torso.sockets!.map((s) =>
      s.id === "neck" ? { ...s, position: { x: 7, y: 3, z: 2.5 } } : s,
    );
    const parts = { ...assembly.parts, head: offGrid, torso: { ...torso, sockets } };
    expect(headAt({ ...assembly, parts })).toEqual([12, 0, -4]);
    const instances = assembly.instances.map((instance) =>
      instance.id === "head" ? { ...instance, rotation: QUARTER_TURN_Y } : instance,
    );
    expect(messages(check({ ...assembly, parts, instances }))).toEqual([]);
    expect(headAt({ ...assembly, parts, instances })).toEqual([4, 0, 0]);
  });

  it("snaps the two parts of a mirror pair to mirror images", () => {
    // A leg two cubes deep on hips at z = 1.5 and 2.5: half a cube off the grid on both sides.
    const assembly = creature();
    const fat = {
      ...assembly.parts.leg!,
      size: { x: 1, y: 3, z: 2 },
      voxels: [6, 1],
      attach: { x: 0.5, y: 3, z: 1 },
    };
    const placed = placeInstances(parsed({ ...assembly, parts: { ...assembly.parts, leg: fat } }));
    // Each moves half a cube toward the torso's middle (z = 0 here), so both span z −4 to 4.
    expect(placed[1]!.offset).toEqual([8, -16, -4]);
    expect(placed[2]!.offset).toEqual([8, -16, 4]);
    expect(placed[2]!.linear).toEqual([1, 0, 0, 0, 1, 0, 0, 0, -1]);
  });
});

describe("the face cap", () => {
  it("caps the faces an assembly shows", () => {
    // A checkerboard 32³ part shows 98,304 faces; two of them are too many.
    const checker = new Uint8Array(32 ** 3).map((_, i) => {
      const x = i % 32;
      const y = Math.floor(i / 32) % 32;
      const z = Math.floor(i / 1024);
      return (x + y + z) % 2;
    });
    const noisy = box(32, 32, 32, {
      voxels: encodeVoxels(checker),
      attach: { x: 16, y: 32, z: 16 },
    });
    const assembly = (children: number) =>
      validate(VoxelAssemblySchema, {
        parts: {
          torso: box(4, 4, 4, {
            sockets: [
              { id: "a", type: "test:hip", position: { x: 2, y: 1, z: 2 } },
              { id: "b", type: "test:hip", position: { x: 2, y: 3, z: 2 } },
            ],
          }),
          noisy,
        },
        instances: [
          { id: "torso", part: "torso" },
          ...["a", "b"].slice(0, children).map((socket) => ({
            id: socket,
            part: "noisy",
            parent: { instance: "torso", socket },
          })),
        ],
      });
    expect(messages(assembly(1))).toEqual([]);
    expect(messages(assembly(2))).toEqual([
      "The parts show 196704 cube faces; an assembly shows at most 131072",
    ]);
  });
});

describe("placeInstances", () => {
  const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const MIRROR = [1, 0, 0, 0, 1, 0, 0, 0, -1];

  it("puts the root's attach point at the origin and each child's at its socket", () => {
    const placed = placeInstances(parsed());
    expect(placed[0]).toEqual({
      linear: IDENTITY,
      offset: [-16, -8, -8],
      mirrored: false,
      depth: 0,
    });
    // The front left hip at torso cube (6.5, 1, 1.5) is 26, 4, 6 units from the torso's corner;
    // the leg's attach point 2, 12, 2 from its own.
    expect(placed[1]).toEqual({
      linear: IDENTITY,
      offset: [8, -16, -4],
      mirrored: false,
      depth: 1,
    });
    // Its mirror image flips z about its attach point.
    expect(placed[2]).toEqual({ linear: MIRROR, offset: [8, -16, 4], mirrored: true, depth: 1 });
  });

  /**
   * A torso with an arm on each side, the right one mirrored, and on each arm a hand of 1.25 cm
   * cubes on socket `a` and one on its mirror `b`. A hand's one cube sits at its left (−z).
   */
  function arms() {
    return parsed({
      parts: {
        torso: box(4, 2, 4, {
          sockets: [
            { id: "left", type: "test:shoulder", position: { x: 2.5, y: 1, z: 1.5 } },
            {
              id: "right",
              type: "test:shoulder",
              position: { x: 2.5, y: 1, z: 2.5 },
              mirrors: "left",
            },
          ],
        }),
        arm: box(1, 2, 2, {
          attach: { x: 0.5, y: 2, z: 1.5 },
          sockets: [
            { id: "a", type: "test:wrist", position: { x: 0.5, y: 1, z: 0.5 } },
            { id: "b", type: "test:wrist", position: { x: 0.5, y: 1, z: 1.5 }, mirrors: "a" },
          ],
        }),
        hand: box(1, 1, 2, { step: 0.0125, voxels: [1, 1, 1, 0], attach: { x: 0, y: 0, z: 0 } }),
      },
      instances: [
        { id: "torso", part: "torso" },
        { id: "left", part: "arm", parent: { instance: "torso", socket: "left" } },
        {
          id: "right",
          part: "arm",
          parent: { instance: "torso", socket: "right" },
          mirrored: true,
        },
        { id: "left-a", part: "hand", parent: { instance: "left", socket: "a" } },
        { id: "left-b", part: "hand", parent: { instance: "left", socket: "b" }, mirrored: true },
        { id: "right-a", part: "hand", parent: { instance: "right", socket: "a" } },
        { id: "right-b", part: "hand", parent: { instance: "right", socket: "b" }, mirrored: true },
      ],
    });
  }

  /** The root-frame box of a hand's one cube, in units, as [min, max]. */
  const handCube = (placement: InstancePlacement) => {
    const a = [0, 1, 2].map((r) => placement.offset[r]!);
    const b = [0, 1, 2].map(
      (r) =>
        2 *
          (placement.linear[r * 3]! + placement.linear[r * 3 + 1]! + placement.linear[r * 3 + 2]!) +
        placement.offset[r]!,
    );
    return [a.map((v, i) => Math.min(v, b[i]!)), a.map((v, i) => Math.max(v, b[i]!))];
  };
  const reflected = ([min, max]: number[][]) => [
    [min![0], min![1], -max![2]!],
    [max![0], max![1], -min![2]!],
  ];

  it("reflects a part hanging from a mirrored part, and a mirror inside a mirror back", () => {
    const placed = placeInstances(arms());
    expect(placed.map((p) => p.mirrored)).toEqual([false, false, true, false, true, true, false]);
    expect(placed.map((p) => p.depth)).toEqual([0, 1, 1, 2, 2, 2, 2]);
    // A hand on the mirrored arm is its pair's mirror image across the creature's XY plane (the
    // torso's middle is at z = 0), whether it hangs from the plain socket or its mirror.
    const [, , , leftA, leftB, rightA, rightB] = placed.map(handCube);
    expect(rightA).toEqual(reflected(leftA!));
    expect(rightB).toEqual(reflected(leftB!));
    expect(measureAssembly(arms()).centerOfGravity.z).toBeCloseTo(0);
  });

  it("gives each part's mesh a bone with a proper rotation", () => {
    const assembly = arms();
    const placed = placeInstances(assembly);
    assembly.instances.forEach((instance, i) => {
      const placement = placed[i]!;
      const part = assembly.parts[instance.part]!;
      const bone = boneTransform(placement, part);
      const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = bone.rotation;
      expect(
        r0! * (r4! * r8! - r5! * r7!) -
          r1! * (r3! * r8! - r5! * r6!) +
          r2! * (r3! * r7! - r4! * r6!),
      ).toBe(1);
      // A corner of the part's last cube along z, where a mesher reflecting it puts it at the
      // first, lands where the placement puts it.
      const step = stepUnits(part.step);
      const corner = [0, 0, part.size.z * step];
      const mesh = placement.mirrored ? [0, 0, 0] : corner;
      const at = (m: readonly number[], p: number[], o: readonly number[]) =>
        [0, 1, 2].map(
          (r) => m[r * 3]! * p[0]! + m[r * 3 + 1]! * p[1]! + m[r * 3 + 2]! * p[2]! + o[r]!,
        );
      expect(at(bone.rotation, mesh, bone.offset)).toEqual(
        at(placement.linear, corner, placement.offset),
      );
    });
  });
});

describe("assemblyWarnings", () => {
  it("has nothing to say about a creature without flush faces", () => {
    expect(assemblyWarnings(parsed())).toEqual([]);
  });

  it("warns of faces of two parts flush in one plane", () => {
    const assembly = creature();
    const torso = assembly.parts.torso!;
    // A leg two cubes wide on a hip one cube in from the torso's corner: its outer faces are
    // flush with the torso's back and left side.
    const sockets = torso.sockets!.map((s) =>
      s.id === "back-left" ? { ...s, position: { x: 1, y: 1, z: 1 } } : s,
    );
    const fat = box(2, 3, 2, { type: "test:leg", attach: { x: 1, y: 3, z: 1 } });
    const instances = assembly.instances.map((instance) =>
      instance.id === "back-left" ? { ...instance, part: "fat" } : instance,
    );
    const warnings = assemblyWarnings(
      parsed({ parts: { ...assembly.parts, fat, torso: { ...torso, sockets } }, instances }),
      "test",
    );
    expect(warnings).toEqual([
      {
        severity: "warning",
        code: "flush_faces",
        message: 'Parts "torso" and "back-left" have faces flush in one plane',
        path: ["instances", 3],
        source: "test",
      },
    ]);
  });
});

describe("checkAssemblyFit", () => {
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
    ["test:tail", partType("test:tail", ["test:tail-root"])],
  ]);
  const SOCKET_TYPES = new Set(["test:hip", "test:neck", "test:tail-root"]);
  const lookup = (parts = PART_TYPES, sockets = SOCKET_TYPES) => ({
    partType: (id: string) => parts.get(id),
    socketType: (id: string) =>
      sockets.has(id) ? { schemaVersion: 1 as const, id, version: "1.0.0", name: id } : undefined,
  });

  it("passes a creature whose parts fit their sockets", () => {
    expect(checkAssemblyFit(parsed(), lookup())).toEqual([]);
  });

  it("needs every part type and socket type registered", () => {
    const parts = new Map(PART_TYPES);
    parts.delete("test:head");
    const sockets = new Set(SOCKET_TYPES);
    sockets.delete("test:neck");
    const found = checkAssemblyFit(parsed(), lookup(parts, sockets), "test");
    expect(found.map((d) => [d.code, d.path.join("."), d.source])).toEqual([
      ["unknown_socket_type", "parts.torso.sockets.4.type", "test"],
      ["unknown_part_type", "parts.head.type", "test"],
    ]);
  });

  it("refuses a part on a socket type its type doesn't fit", () => {
    const parts = new Map(PART_TYPES);
    parts.set("test:tail", partType("test:tail", ["test:hip"]));
    expect(checkAssemblyFit(parsed(), lookup(parts)).map((d) => d.message)).toEqual([
      'Part type "test:tail" doesn\'t fit socket type "test:tail-root"',
    ]);
  });
});

describe("measureAssembly", () => {
  const one = (part: VoxelPartInput): VoxelAssemblyInput => ({
    parts: { body: part },
    instances: [{ id: "body", part: "body" }],
  });

  it("measures a box from its cubes, resting on its lowest one", () => {
    const measure = measureAssembly(parsed(one(box(4, 6, 2, { step: 0.05 }))));
    close(measure.bounds.min, { x: -0.1, y: 0, z: -0.05 });
    close(measure.bounds.max, { x: 0.1, y: 0.3, z: 0.05 });
    expect(measure.height).toBeCloseTo(0.3);
    expect(measure.footprintRadius).toBeCloseTo(Math.hypot(0.1, 0.05));
    expect(measure.sizeClass).toBe("small");
    close(measure.groundContact, { minX: -0.1, maxX: 0.1, minZ: -0.05, maxZ: 0.05 });
    close(measure.centerOfGravity, { x: 0, y: 0.15, z: 0 });
  });

  it("moves a long, low creature up a class for its footprint", () => {
    // 15 cm tall fits a tiny creature's 20 cm, but 30 cm long doesn't fit its 10 cm radius.
    const long = measureAssembly(parsed(one(box(12, 6, 2))));
    expect(long.height).toBeCloseTo(0.15);
    expect(long.sizeClass).toBe("small");
    expect(measureAssembly(parsed(one(box(6, 6, 2)))).sizeClass).toBe("tiny");
  });

  it("finds no class for a body too large for every class", () => {
    expect(measureAssembly(parsed(one(box(4, 17, 4, { step: 0.1 })))).sizeClass).toBeUndefined();
    expect(sizeClassFor(1.6, 0.8)).toBe("large");
    expect(sizeClassFor(1.61, 0.1)).toBeUndefined();
  });

  it("measures a creature's parts where they hang", () => {
    const measure = measureAssembly(parsed());
    // In cubes: legs from y = -2 under the torso (0 to 4), the head up to 5.
    expect(measure.height).toBeCloseTo(7 * 0.025);
    expect(measure.bounds.min.y).toBe(0);
    // The tail from x = -1, the head to 10; the torso 4 wide.
    expect(measure.bounds.max.x - measure.bounds.min.x).toBeCloseTo(11 * 0.025);
    expect(measure.bounds.max.z - measure.bounds.min.z).toBeCloseTo(4 * 0.025);
    // Under 20 cm tall, but 13.75 cm from the middle to the head's tip.
    expect(measure.sizeClass).toBe("small");
    // Only the feet touch the ground: legs from x = 1 to 7 and z = 1 to 3.
    const { groundContact } = measure;
    expect(groundContact.maxX - groundContact.minX).toBeCloseTo(6 * 0.025);
    expect(groundContact.maxZ - groundContact.minZ).toBeCloseTo(2 * 0.025);
  });

  it("puts the centre of gravity at the centroid of the cubes' volume", () => {
    // A 4 × 2 × 2 bar with a 2 × 2 × 2 block overlapping its +x end by a cube.
    const assembly = parsed({
      parts: {
        bar: box(4, 2, 2, {
          attach: { x: 0, y: 0, z: 0 },
          sockets: [{ id: "end", type: "test:end", position: { x: 3, y: 1, z: 1 } }],
        }),
        block: box(2, 2, 2, { attach: { x: 0, y: 1, z: 1 } }),
      },
      instances: [
        { id: "bar", part: "bar" },
        { id: "block", part: "block", parent: { instance: "bar", socket: "end" } },
      ],
    });
    // In cubes from the bar's corner: the bar's centre at x = 2 (16 cubes), the block's at 4
    // (8 cubes, a layer of them inside the bar, counted again); the bounds 0 to 5, middle 2.5.
    close(measureAssembly(assembly).centerOfGravity, {
      x: ((2 * 16 + 4 * 8) / 24 - 2.5) * 0.025,
      y: 0.025,
      z: 0,
    });
  });

  it("takes the tail from a part whose type has the tail role", () => {
    const measure = measureAssembly(parsed(), (type) =>
      type === "test:tail" ? "tail" : undefined,
    );
    // The tail socket at torso cube (1, 2.5, 2): 2 cubes in from the tail's tip and 4.5 cubes
    // above the feet.
    close(measure.tail, { x: measure.bounds.min.x + 2 * 0.025, y: 4.5 * 0.025, z: 0 });
  });

  it("gives the body frame's origin in the root's frame", () => {
    const measure = measureAssembly(parsed());
    // In units: the tail from x = -1 cube, the head to 10, from the torso's attach point (4, 2, 2);
    // the feet 2 cubes below the torso.
    expect(measure.origin).toEqual([(-4 + 40) / 2 - 16, -8 - 8, 0]);
  });

  it("puts the tail at the middle of the rear end without a tail part", () => {
    const measure = measureAssembly(parsed());
    expect(measure.tail).toEqual({ x: measure.bounds.min.x, y: measure.height / 2, z: 0 });
  });

  /**
   * A torso with a leg of 1 × 2 × 2 cubes on each side: the toe on the ground at the leg's left
   * (−z), the rest of it above. Both legs have `rotation`; the right one is mirrored.
   */
  const toes = (rotation: Quaternion = [0, 0, 0, 1]) => {
    const toe = Uint8Array.from([1, 0, 0, 1]); // x fastest, then y: cubes (0, 0, 0) and (0, 1, 1)
    return parsed({
      parts: {
        torso: box(4, 2, 4, {
          sockets: [
            { id: "left", type: "test:hip", position: { x: 2.5, y: 1, z: 1.5 } },
            { id: "right", type: "test:hip", position: { x: 2.5, y: 1, z: 2.5 }, mirrors: "left" },
          ],
        }),
        leg: box(1, 2, 2, { voxels: encodeVoxels(toe), attach: { x: 0.5, y: 2, z: 1.5 } }),
      },
      instances: [
        { id: "torso", part: "torso" },
        { id: "left", part: "leg", parent: { instance: "torso", socket: "left" }, rotation },
        {
          id: "right",
          part: "leg",
          parent: { instance: "torso", socket: "right" },
          rotation,
          mirrored: true,
        },
      ],
    });
  };

  it("mirrors a part on a mirrored socket in the creature's XY plane", () => {
    const measure = measureAssembly(toes());
    // Only the toes touch the ground, both on the outside.
    close(measure.groundContact, { minX: 0, maxX: 0.025, minZ: -0.05, maxZ: 0.05 });
    expect(measure.centerOfGravity.z).toBeCloseTo(0);
  });

  it("mirrors a turned part's rotation too, so the pair stays symmetric", () => {
    // A quarter turn about Y swings the left toe from the leg's left to its back; the right toe
    // swings to its back as well, the mirror image, not to its front.
    const measure = measureAssembly(toes(QUARTER_TURN_Y));
    close(measure.groundContact, { minX: -0.025, maxX: 0, minZ: -0.025, maxZ: 0.025 });
    expect(measure.centerOfGravity.z).toBeCloseTo(0);
  });
});
