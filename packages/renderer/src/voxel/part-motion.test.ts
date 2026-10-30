import {
  VoxelAssemblySchema,
  validate,
  type VoxelAssembly,
  type VoxelAssemblyInput,
  type VoxelPartInput,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { box, creature } from "../body/fixtures/voxel-creature";
import { eatingPeck, type CueWeights } from "../cues";
import { buildVoxelBody, type VoxelBody } from "./body";
import { composePose } from "./compose-pose";
import { MAX_SWING, buildMotionRig, type MotionName, type MotionRig } from "./motion-rig";
import {
  BLINK,
  createMotionPose,
  writeMotion,
  type MotionInput,
  type MotionPose,
} from "./part-motion";

function parsed(input: VoxelAssemblyInput): VoxelAssembly {
  const result = validate(VoxelAssemblySchema, input);
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
  return result.value;
}

const MOTION_BY_TYPE: Record<string, MotionName> = {
  "test:leg": "swing",
  "test:head": "bob",
  "test:ear": "flop",
  "test:eye": "blink",
  "test:tail": "wag",
  "test:arm": "flop",
  "test:hand": "flop",
  "test:limb": "swing",
};

interface Built {
  assembly: VoxelAssembly;
  body: VoxelBody;
  rig: MotionRig;
  index: (id: string) => number;
}

function build(input: VoxelAssemblyInput, motions = MOTION_BY_TYPE): Built {
  const assembly = parsed(input);
  const body = buildVoxelBody(assembly);
  const typeOf = (i: number) => assembly.parts[assembly.instances[i]!.part]!.type;
  const rig = buildMotionRig(body, (i) => motions[typeOf(i)]);
  const index = (id: string) => {
    const i = assembly.instances.findIndex((instance) => instance.id === id);
    if (i < 0) throw new Error(`No instance ${id}`);
    return i;
  };
  return { assembly, body, rig, index };
}

const leg = (height: number): VoxelPartInput =>
  box(2, height, 2, { type: "test:leg", attach: { x: 1, y: height, z: 1 } });

/**
 * A torso `length` cubes long with a pair of legs at each of `legsAt` (x, front first), a head
 * with a pair of ears and eyes at the front, and a tail at the back. Legs are `legHeight` cubes,
 * or `frontLegHeight` for the first pair.
 */
function animal({
  legsAt = [6, 2],
  length = 8,
  legHeight = 4,
  frontLegHeight = legHeight,
  arms = false,
}: {
  legsAt?: number[];
  length?: number;
  legHeight?: number;
  frontLegHeight?: number;
  arms?: boolean;
} = {}): VoxelAssemblyInput {
  const sockets = legsAt.flatMap((x, n) => [
    { id: `leg-${n}-l`, type: "test:hip", position: { x, y: 1, z: 1.5 } },
    { id: `leg-${n}-r`, type: "test:hip", position: { x, y: 1, z: 4.5 }, mirrors: `leg-${n}-l` },
  ]);
  return {
    parts: {
      torso: box(length, 4, 6, {
        attach: { x: length / 2, y: 0, z: 3 },
        sockets: [
          ...sockets,
          ...(arms
            ? [
                { id: "arm-l", type: "test:shoulder", position: { x: length - 2, y: 3, z: 1 } },
                {
                  id: "arm-r",
                  type: "test:shoulder",
                  position: { x: length - 2, y: 3, z: 5 },
                  mirrors: "arm-l",
                },
              ]
            : []),
          { id: "neck", type: "test:neck", position: { x: length - 1, y: 3, z: 3 } },
          { id: "tail", type: "test:tail-base", position: { x: 1, y: 3, z: 3 } },
        ],
      }),
      ...(legsAt.length > 1 ? { leg: leg(legHeight) } : {}),
      "front-leg": leg(frontLegHeight),
      head: box(4, 4, 4, {
        type: "test:head",
        attach: { x: 0, y: 1, z: 2 },
        sockets: [
          { id: "ear-l", type: "test:ear-mount", position: { x: 1, y: 3, z: 1 } },
          { id: "ear-r", type: "test:ear-mount", position: { x: 1, y: 3, z: 3 }, mirrors: "ear-l" },
          { id: "eye-l", type: "test:eye-mount", position: { x: 3, y: 2, z: 1 } },
          { id: "eye-r", type: "test:eye-mount", position: { x: 3, y: 2, z: 3 }, mirrors: "eye-l" },
        ],
      }),
      // Leaning out to the left (−z), so a twitch about X is visible and mirrors.
      ear: box(1, 3, 2, { type: "test:ear", attach: { x: 0.5, y: 0, z: 1.5 } }),
      eye: box(1, 1, 1, { type: "test:eye", attach: { x: 0, y: 0.5, z: 0.5 } }),
      ...(arms
        ? { arm: box(1, 2, 1, { type: "test:limb", attach: { x: 0.5, y: 2, z: 0.5 } }) }
        : {}),
      tail: box(4, 1, 1, { type: "test:tail", attach: { x: 3.5, y: 0.5, z: 0.5 } }),
    },
    instances: [
      { id: "torso", part: "torso" },
      ...legsAt.flatMap((_, n) => [
        {
          id: `leg-${n}-l`,
          part: n === 0 ? "front-leg" : "leg",
          parent: { instance: "torso", socket: `leg-${n}-l` },
        },
        {
          id: `leg-${n}-r`,
          part: n === 0 ? "front-leg" : "leg",
          parent: { instance: "torso", socket: `leg-${n}-r` },
          mirrored: true,
        },
      ]),
      { id: "head", part: "head", parent: { instance: "torso", socket: "neck" } },
      { id: "ear-l", part: "ear", parent: { instance: "head", socket: "ear-l" } },
      { id: "ear-r", part: "ear", parent: { instance: "head", socket: "ear-r" }, mirrored: true },
      { id: "eye-l", part: "eye", parent: { instance: "head", socket: "eye-l" } },
      { id: "eye-r", part: "eye", parent: { instance: "head", socket: "eye-r" }, mirrored: true },
      { id: "tail", part: "tail", parent: { instance: "torso", socket: "tail" } },
      ...(arms
        ? [
            { id: "arm-l", part: "arm", parent: { instance: "torso", socket: "arm-l" } },
            {
              id: "arm-r",
              part: "arm",
              parent: { instance: "torso", socket: "arm-r" },
              mirrored: true,
            },
          ]
        : []),
    ],
  };
}

const awake = (): CueWeights => ({ eating: 0, sleeping: 0, hungry: 0 });

function input(overrides: Partial<MotionInput> = {}): MotionInput {
  return {
    time: 0,
    travelled: 0,
    speed: 0,
    gait: undefined,
    leap: undefined,
    phase: 0.3,
    cues: awake(),
    ...overrides,
  };
}

const walking = (travelled: number, gait = "walk") => input({ travelled, speed: 1, gait });

/** A part's turn as an angle about Z, for parts that turn about Z alone. */
function swingOf(pose: MotionPose, i: number): number {
  const z = pose.rotations[4 * i + 2]!;
  const w = pose.rotations[4 * i + 3]!;
  return 2 * Math.atan2(z, w);
}

function motion(rig: MotionRig, at: MotionInput): MotionPose {
  return writeMotion(rig, at, createMotionPose(rig));
}

function compose(rig: MotionRig, pose: MotionPose): THREE.Matrix4[] {
  const bones = rig.parts.map(() => new THREE.Matrix4());
  composePose(rig, pose, bones);
  return bones;
}

/** A part's mesh vertices through `bone`, in the body frame. */
function vertices(body: VoxelBody, part: number, bone: THREE.Matrix4): THREE.Vector3[] {
  const positions = body.geometry.getAttribute("position");
  const skin = body.geometry.getAttribute("skinIndex");
  const out: THREE.Vector3[] = [];
  for (let v = 0; v < positions.count; v++) {
    if (skin.getX(v) === part)
      out.push(new THREE.Vector3().fromBufferAttribute(positions, v).applyMatrix4(bone));
  }
  return out;
}

/** Every vertex of `a`, reflected z → −z, is a vertex of `b`, and they have as many. */
function expectMirrorImages(a: THREE.Vector3[], b: THREE.Vector3[]) {
  expect(a.length).toBe(b.length);
  for (const p of a) {
    const image = new THREE.Vector3(p.x, p.y, -p.z);
    const nearest = Math.min(...b.map((q) => q.distanceTo(image)));
    expect(nearest).toBeLessThan(1e-9);
  }
}

describe("motion rig", () => {
  it("classifies legs by socket position: side, front or back, and diagonal pairs that trot", () => {
    const { rig, index } = build(animal());
    const legOf = (id: string) => rig.parts[index(id)]!.leg!;
    expect(legOf("leg-0-l")).toMatchObject({ side: -1, front: true, grounded: true });
    expect(legOf("leg-0-r")).toMatchObject({ side: 1, front: true });
    expect(legOf("leg-1-l")).toMatchObject({ side: -1, front: false });
    expect(legOf("leg-1-r")).toMatchObject({ side: 1, front: false });
    // Diagonal pairs together, the pairs half a cycle apart.
    expect(legOf("leg-0-l").offset).toBe(legOf("leg-1-r").offset);
    expect(legOf("leg-0-r").offset).toBe(legOf("leg-1-l").offset);
    expect(Math.abs(legOf("leg-0-l").offset - legOf("leg-0-r").offset)).toBe(0.5);
    expect(rig.legs.map((i) => rig.parts[i]!.origin.x)).toEqual(
      [...rig.legs.map((i) => rig.parts[i]!.origin.x)].sort((a, b) => b - a),
    );
    expect(rig.parts[index("head")]!.leg).toBeUndefined();
  });

  it("alternates two legs", () => {
    const { rig, index } = build(animal({ legsAt: [4] }));
    const left = rig.parts[index("leg-0-l")]!.leg!;
    const right = rig.parts[index("leg-0-r")]!.leg!;
    expect(Math.abs(left.offset - right.offset)).toBe(0.5);
  });

  it("swings arms with the opposite leg, and takes the stride from the legs alone", () => {
    const { rig, index } = build(animal({ legsAt: [4], arms: true }));
    const limb = (id: string) => rig.parts[index(id)]!.leg!;
    expect(limb("arm-l").grounded).toBe(false);
    expect(limb("leg-0-l").grounded).toBe(true);
    expect(limb("arm-l").offset).toBe(limb("leg-0-r").offset);
    expect(limb("arm-r").offset).toBe(limb("leg-0-l").offset);
    expect(rig.stride).toBeCloseTo(1.5 * rig.parts[index("leg-0-l")]!.length, 9);
    // Arms join the gait: they swing as it walks.
    const pose = motion(rig, walking(rig.stride * 0.2));
    expect(Math.abs(swingOf(pose, index("arm-l")))).toBeGreaterThan(0.1);
  });

  it("puts a leg on the middle plane on a side by its parity, and alternates odd counts in X order", () => {
    // Three legs: a front pair and one unpaired leg at the back, on the middle plane.
    const input = animal({ legsAt: [6] });
    const torso = input.parts["torso"]!;
    torso.sockets = [
      ...(torso.sockets ?? []),
      { id: "leg-back", type: "test:hip", position: { x: 2, y: 1, z: 3 } },
    ];
    input.instances.push({
      id: "leg-back",
      part: "front-leg",
      parent: { instance: "torso", socket: "leg-back" },
    });
    const { rig, index } = build(input);
    const back = rig.parts[index("leg-back")]!.leg!;
    expect(rig.parts[index("leg-back")]!.origin.z).toBeCloseTo(0, 9);
    expect(back.side).toBe(-1);
    expect(back.grounded).toBe(true);
    expect(back.offset).toBe(rig.parts[index("leg-0-r")]!.leg!.offset);
    expect(back.offset).not.toBe(rig.parts[index("leg-0-l")]!.leg!.offset);
  });

  it("alternates six legs in X order, the sides opposite: two tripods", () => {
    const { rig, index } = build(animal({ legsAt: [10, 6, 2], length: 12 }));
    const offset = (id: string) => rig.parts[index(id)]!.leg!.offset;
    const a = ["leg-0-l", "leg-1-r", "leg-2-l"].map(offset);
    const b = ["leg-0-r", "leg-1-l", "leg-2-r"].map(offset);
    expect(new Set(a).size).toBe(1);
    expect(new Set(b).size).toBe(1);
    expect(Math.abs(a[0]! - b[0]!)).toBe(0.5);
  });

  it("measures a part's length to its farthest cube corner from its attach point", () => {
    const { rig, index } = build(animal({ legHeight: 4 }));
    // 2 × 4 × 2 cubes of 2.5 cm hanging from the middle of its top: to a bottom corner.
    expect(rig.parts[index("leg-1-l")]!.length).toBeCloseTo(Math.hypot(1, 4, 1) * 0.025, 3);
  });

  it("gives longer legs a longer stride: a wider foot sweep at a slower cadence", () => {
    const short = build(animal({ legHeight: 3 })).rig;
    const long = build(animal({ legHeight: 6 })).rig;
    expect(long.stride).toBeGreaterThan(short.stride);
    // Cycles per metre, so per second at the same speed.
    expect(1 / long.stride).toBeLessThan(1 / short.stride);
    const sweep = (rig: MotionRig) => {
      const i = rig.legs[0]!;
      return rig.parts[i]!.length * Math.sin(rig.parts[i]!.leg!.amplitude);
    };
    expect(sweep(long)).toBeGreaterThan(sweep(short));
  });

  it("swings a shorter leg further than a longer one in the same gait, capped", () => {
    const { rig, index } = build(animal({ legHeight: 6, frontLegHeight: 2 }));
    const front = rig.parts[index("leg-0-l")]!.leg!;
    const back = rig.parts[index("leg-1-l")]!.leg!;
    // The front legs don't reach the ground, so the back ones set the stride.
    expect(front.grounded).toBe(false);
    expect(rig.stride).toBeCloseTo(1.5 * rig.parts[index("leg-1-l")]!.length, 9);
    expect(front.amplitude).toBeGreaterThan(back.amplitude);
    expect(front.amplitude).toBeLessThanOrEqual(MAX_SWING);
  });

  it("drops unknown motions and the root's", () => {
    const { rig } = build(animal(), { "test:torso": "swing", "test:leg": "sway" as MotionName });
    expect(rig.parts.every((part) => part.motion === undefined)).toBe(true);
    expect(rig.legs).toEqual([]);
  });
});

describe("part motion", () => {
  const quadruped = build(animal());

  it("is identity for parts without a motion or with an unknown one", () => {
    const { rig } = build(animal(), { "test:leg": "sway" as MotionName });
    const pose = motion(rig, walking(0.37));
    for (let i = 0; i < rig.parts.length; i++) {
      if (rig.parts[i]!.motion !== undefined) continue;
      expect([...pose.rotations.subarray(4 * i, 4 * i + 4)].map((v) => v + 0)).toEqual([
        0, 0, 0, 1,
      ]);
      expect(pose.squash[i]).toBe(1);
    }
  });

  it("is deterministic, and the same inputs give the same pose whatever came before (paused)", () => {
    const { rig } = quadruped;
    const at = input({ time: 12.34, travelled: 0.81, speed: 0.2, gait: "walk" });
    const a = motion(rig, at);
    const b = writeMotion(
      rig,
      input({ time: 3, travelled: 9, speed: 1, gait: "hop" }),
      createMotionPose(rig),
    );
    writeMotion(rig, at, b);
    expect([...b.rotations]).toEqual([...a.rotations]);
    expect([...b.squash]).toEqual([...a.squash]);
  });

  it("trots: diagonal legs together, the other pair opposite", () => {
    const { rig, index } = quadruped;
    const pose = motion(rig, walking(rig.stride * 0.2));
    const swing = (id: string) => swingOf(pose, index(id));
    expect(Math.abs(swing("leg-0-l"))).toBeGreaterThan(0.1);
    expect(swing("leg-0-l")).toBeCloseTo(swing("leg-1-r"), 9);
    expect(swing("leg-0-r")).toBeCloseTo(swing("leg-1-l"), 9);
    expect(swing("leg-0-r")).toBeCloseTo(-swing("leg-0-l"), 9);
  });

  it("alternates two legs as it walks", () => {
    const { rig, index } = build(animal({ legsAt: [4] }));
    const pose = motion(rig, walking(rig.stride * 0.3));
    expect(swingOf(pose, index("leg-0-l"))).toBeCloseTo(-swingOf(pose, index("leg-0-r")), 9);
    expect(Math.abs(swingOf(pose, index("leg-0-l")))).toBeGreaterThan(0.1);
  });

  it("keeps the legs still at rest and every swing within the cap", () => {
    const { rig } = quadruped;
    const still = motion(rig, input({ travelled: 0.3, gait: "walk", time: 50 }));
    for (const i of rig.legs) expect(swingOf(still, i)).toBe(0);
    for (let k = 0; k < 50; k++) {
      const pose = motion(rig, walking(k * 0.037));
      for (const i of rig.legs)
        expect(Math.abs(swingOf(pose, i))).toBeLessThanOrEqual(MAX_SWING + 1e-12);
    }
  });

  it("hops with all legs together, tucked under mid-air", () => {
    const { rig, index } = quadruped;
    // Mid-air the front legs swing furthest back; find it by scanning a few hops.
    let best = motion(rig, input({ speed: 1, gait: "hop" }));
    for (let t = 0; t < 2; t += 0.001) {
      const p = motion(rig, input({ speed: 1, gait: "hop", travelled: t }));
      if (swingOf(p, index("leg-0-l")) < swingOf(best, index("leg-0-l"))) best = p;
    }
    const front = swingOf(best, index("leg-0-l"));
    expect(front).toBeLessThan(-0.4); // front feet tucked back
    expect(swingOf(best, index("leg-0-r"))).toBeCloseTo(front, 9);
    expect(swingOf(best, index("leg-1-l"))).toBeCloseTo(-front, 9); // back feet tucked forward
  });

  it("tucks the legs on a bank leap, whatever the gait", () => {
    const { rig, index } = quadruped;
    const pose = motion(rig, input({ gait: "walk", speed: 1, leap: 0.5 }));
    expect(swingOf(pose, index("leg-0-l"))).toBeLessThan(-0.5);
    expect(swingOf(pose, index("leg-1-l"))).toBeGreaterThan(0.5);
  });

  it("dips the head with the eating peck", () => {
    const { rig, index } = quadruped;
    const eating = { eating: 1, sleeping: 0, hungry: 0 };
    const phase = 0.3;
    // eatingPeck is 0 at time −phase · period and 1 half a period later; find both by scanning.
    let deepest = 0;
    let deepestAt = 0;
    for (let t = 0; t < 1; t += 0.01) {
      const dip = -swingOf(motion(rig, input({ time: t, phase, cues: eating })), index("head"));
      if (dip > deepest) [deepest, deepestAt] = [dip, t];
    }
    expect(deepest).toBeGreaterThan(0.3);
    expect(eatingPeck(deepestAt, phase)).toBeGreaterThan(0.99);
    expect(swingOf(motion(rig, input({ time: deepestAt, phase })), index("head"))).toBe(0);
  });

  it("blinks now and then, and keeps the eyes shut asleep", () => {
    const { rig, index } = quadruped;
    const eye = index("eye-l");
    let blinks = 0;
    let open = 0;
    for (let t = 0; t < 40; t += 0.02) {
      const s = motion(rig, input({ time: t })).squash[eye]!;
      if (s < 0.5) blinks++;
      if (s === 1) open++;
    }
    expect(blinks).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(0.9 * (40 / 0.02));
    const asleep = { eating: 0, sleeping: 1, hungry: 0 };
    expect(motion(rig, input({ time: 1, cues: asleep })).squash[eye]).toBeCloseTo(BLINK.closed, 9);
    // Both eyes together.
    const pose = motion(rig, input({ time: 7.77 }));
    expect(pose.squash[index("eye-r")]).toBe(pose.squash[eye]);
  });

  it("droops the head, drops the ears and curls the tail asleep", () => {
    const { rig, index } = quadruped;
    const pose = motion(rig, input({ time: 0, cues: { eating: 0, sleeping: 1, hungry: 0 } }));
    expect(swingOf(pose, index("head"))).toBeLessThan(-0.2);
    const tail = index("tail");
    expect(Math.abs(pose.rotations[4 * tail + 1]!)).toBeGreaterThan(0.2);
    const ear = index("ear-l");
    expect(pose.rotations[4 * ear + 2]!).toBeGreaterThan(0.2); // back
  });
});

describe("pose composer", () => {
  it("gives the rest bones at rest", () => {
    for (const { rig, body } of [build(animal()), build(creature())]) {
      const bones = compose(rig, createMotionPose(rig));
      bones.forEach((bone, i) => {
        bone.elements.forEach((v, k) => expect(v).toBeCloseTo(body.bones[i]!.elements[k]!, 12));
      });
    }
  });

  it("poses a mirror pair as mirror images, down the tree", () => {
    // Arms turned about X with hands on them: the right hand is reflected through its arm.
    const built = build(creature());
    const { rig, body, index } = built;
    const asleep = { eating: 0, sleeping: 0.6, hungry: 0 };
    for (const time of [0.1, 2.3, 5.9, 13.7]) {
      const bones = compose(rig, motion(rig, input({ time, cues: asleep })));
      for (const [left, right] of [
        ["left-arm", "right-arm"],
        ["left-hand", "right-hand"],
      ] as const) {
        expectMirrorImages(
          vertices(body, index(left), bones[index(left)]!),
          vertices(body, index(right), bones[index(right)]!),
        );
      }
    }
    // And the turn was not trivial.
    const pose = motion(rig, input({ cues: asleep }));
    expect(Math.abs(pose.rotations[4 * index("left-arm")]!)).toBeGreaterThan(0.05);
  });

  it("mirrors an animal's ears and eyes, and its legs half a cycle apart", () => {
    const { rig, body, index } = build(animal());
    const at = { time: 3.21, cues: { eating: 0, sleeping: 0.4, hungry: 0 } };
    const bones = compose(rig, motion(rig, input(at)));
    for (const [left, right] of [
      ["ear-l", "ear-r"],
      ["eye-l", "eye-r"],
    ] as const) {
      expectMirrorImages(
        vertices(body, index(left), bones[index(left)]!),
        vertices(body, index(right), bones[index(right)]!),
      );
    }
    const now = compose(rig, motion(rig, walking(0.1)));
    const later = compose(rig, motion(rig, walking(0.1 + rig.stride / 2)));
    expectMirrorImages(
      vertices(body, index("leg-0-l"), now[index("leg-0-l")]!),
      vertices(body, index("leg-0-r"), later[index("leg-0-r")]!),
    );
  });

  it("carries a parent's turn to its children through the joints alone", () => {
    const { rig, body, index } = build(animal());
    const pose = motion(rig, input({ cues: { eating: 0, sleeping: 1, hungry: 0 }, time: 1 }));
    const bones = compose(rig, pose);
    const head = index("head");
    const eye = index("eye-l");
    // The eye is shut (squashed) and turned with the head; the head's own bone isn't squashed.
    expect(pose.squash[eye]).toBeLessThan(1);
    expect(pose.squash[head]).toBe(1);
    const turn = pose.turns[head]!;
    const expected = turn.clone().multiply(body.bones[head]!);
    bones[head]!.elements.forEach((v, k) => expect(v).toBeCloseTo(expected.elements[k]!, 12));
    expect(pose.turns[eye]!.elements).toEqual(turn.elements);
    // The squash shortens the eye along the body's vertical about its attach point, and the
    // head's turn then carries it.
    const s = pose.squash[eye]!;
    const o = rig.parts[eye]!.origin;
    const posed = vertices(body, eye, bones[eye]!);
    const squashed = vertices(body, eye, body.bones[eye]!).map((p) =>
      p.setY(o.y + s * (p.y - o.y)).applyMatrix4(turn),
    );
    expect(posed.length).toBe(squashed.length);
    posed.forEach((p, k) => expect(p.distanceTo(squashed[k]!)).toBeLessThan(1e-9));
  });
});
