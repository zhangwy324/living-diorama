/**
 * Per-part motion timings, kept out of `pnpm check`: run
 * `pnpm tsx packages/renderer/src/voxel/part-motion.timing.ts`. Times one frame of motion and
 * composing for 20 creatures of 15 bones each, the M22 budget case, over a few thousand frames
 * after a warm-up, and prints the median and worst.
 */
import { VoxelAssemblySchema, validate } from "@living-diorama/content-schema";
import * as THREE from "three";
import { box } from "../body/fixtures/voxel-creature";
import { buildVoxelBody } from "./body";
import { composePose } from "./compose-pose";
import { buildMotionRig, type MotionName } from "./motion-rig";
import { createMotionPose, writeMotion, type MotionInput } from "./part-motion";

const CREATURES = 20;
const FRAMES = 5000;

// Torso, four legs with a paw each, a head with two ears and two eyes, a tail: 15 parts.
const hips = [
  ["fl", 6, 1.5],
  ["fr", 6, 4.5],
  ["bl", 2, 1.5],
  ["br", 2, 4.5],
] as const;
const result = validate(VoxelAssemblySchema, {
  parts: {
    torso: box(8, 4, 6, {
      attach: { x: 4, y: 0, z: 3 },
      sockets: [
        ...hips.map(([id, x, z]) => ({
          id,
          type: "t:hip",
          position: { x, y: 1, z },
          ...(z > 3 ? { mirrors: id.replace("r", "l") } : {}),
        })),
        { id: "neck", type: "t:neck", position: { x: 7, y: 3, z: 3 } },
        { id: "tail", type: "t:tail", position: { x: 1, y: 3, z: 3 } },
      ],
    }),
    leg: box(2, 4, 2, {
      type: "t:leg",
      attach: { x: 1, y: 4, z: 1 },
      sockets: [{ id: "paw", type: "t:paw", position: { x: 1, y: 1, z: 1 } }],
    }),
    paw: box(2, 1, 2, { type: "t:paw", attach: { x: 1, y: 1, z: 1 } }),
    head: box(4, 4, 4, {
      type: "t:head",
      attach: { x: 0, y: 1, z: 2 },
      sockets: [
        { id: "ear-l", type: "t:ear", position: { x: 1, y: 3, z: 1 } },
        { id: "ear-r", type: "t:ear", position: { x: 1, y: 3, z: 3 }, mirrors: "ear-l" },
        { id: "eye-l", type: "t:eye", position: { x: 3, y: 2, z: 1 } },
        { id: "eye-r", type: "t:eye", position: { x: 3, y: 2, z: 3 }, mirrors: "eye-l" },
      ],
    }),
    ear: box(1, 3, 1, { type: "t:ear", attach: { x: 0.5, y: 0, z: 0.5 } }),
    eye: box(1, 1, 1, { type: "t:eye", attach: { x: 0, y: 0.5, z: 0.5 } }),
    tail: box(4, 1, 1, { type: "t:tail", attach: { x: 3.5, y: 0.5, z: 0.5 } }),
  },
  instances: [
    { id: "torso", part: "torso" },
    ...hips.flatMap(([id, , z]) => [
      { id, part: "leg", parent: { instance: "torso", socket: id }, mirrored: z > 3 },
      { id: `${id}-paw`, part: "paw", parent: { instance: id, socket: "paw" } },
    ]),
    { id: "head", part: "head", parent: { instance: "torso", socket: "neck" } },
    { id: "ear-l", part: "ear", parent: { instance: "head", socket: "ear-l" } },
    { id: "ear-r", part: "ear", parent: { instance: "head", socket: "ear-r" }, mirrored: true },
    { id: "eye-l", part: "eye", parent: { instance: "head", socket: "eye-l" } },
    { id: "eye-r", part: "eye", parent: { instance: "head", socket: "eye-r" }, mirrored: true },
    { id: "tail", part: "tail", parent: { instance: "torso", socket: "tail" } },
  ],
});
if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("\n"));
const assembly = result.value;
const motions: Record<string, MotionName> = {
  "t:leg": "swing",
  "t:head": "bob",
  "t:ear": "flop",
  "t:eye": "blink",
  "t:tail": "wag",
};
const body = buildVoxelBody(assembly);
const rig = buildMotionRig(
  body,
  (i) => motions[assembly.parts[assembly.instances[i]?.part ?? ""]?.type ?? ""],
);
const creatures = Array.from({ length: CREATURES }, (_, n) => ({
  pose: createMotionPose(rig),
  bones: rig.parts.map(() => new THREE.Matrix4()),
  input: {
    time: 0,
    travelled: 0,
    speed: 0.3,
    gait: n % 3 === 0 ? "hop" : "walk",
    leap: undefined,
    phase: n / CREATURES,
    cues: { eating: n % 5 === 0 ? 1 : 0, sleeping: n % 7 === 0 ? 1 : 0, hungry: 0 },
  } satisfies MotionInput,
}));

const frame = (f: number) => {
  for (const c of creatures) {
    c.input.time = f / 30;
    c.input.travelled = f * 0.01;
    writeMotion(rig, c.input, c.pose);
    composePose(rig, c.pose, c.bones);
  }
};
for (let f = 0; f < 500; f++) frame(f);
const times: number[] = [];
for (let f = 0; f < FRAMES; f++) {
  const start = performance.now();
  frame(f);
  times.push(performance.now() - start);
}
times.sort((a, b) => a - b);
const us = (ms: number | undefined) => ((ms ?? 0) * 1000).toFixed(1);
console.log(
  `${CREATURES} creatures × ${rig.parts.length} bones: median ${us(times[FRAMES >> 1])} µs, ` +
    `99th ${us(times[Math.floor(FRAMES * 0.99)])} µs, worst ${us(times[FRAMES - 1])} µs per frame`,
);
