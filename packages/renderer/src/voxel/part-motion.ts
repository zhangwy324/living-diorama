import * as THREE from "three";
import { ease, eatingPeck, type CueWeights } from "../cues";
import { FULL_MOTION_SPEED, HOP_GROUND, hopProgress } from "../locomotion";
import { MAX_SWING, type MotionRig, type RigPart } from "./motion-rig";

// Per-part motion (M22): each part type's motion, scaled by the part's size and timed by the
// creature's gait, as a local joint rotation per part (and a squash for a blink). Pure: the pose
// is a function of the input alone, so a paused creature, whose time and distance stand still,
// holds still, and nothing here reads a clock or a random number.
//
// The pipeline is three steps: `writeMotion` fills a `MotionPose`, an optional pass may then
// override or blend the rotations of whole chains (a later IK pass: it may keep state of its own,
// such as foot locks), and `composePose` walks the joint chain into bone matrices.
//
// Rotations are in the body frame's axes, applied after the rest joint and about the attach
// point: about Z swings a part forward (+) or back, about Y turns it to the left (+), about X
// tilts its top towards +Z (+). A mirrored part takes the mirror image, [x, y, z, w] →
// [−x, −y, z, w] (ADR 0022), so a pair moves as mirror images.

/** What the motion of one creature's parts follows this frame. */
export interface MotionInput {
  /** Animation time in seconds; it stops while the simulation is paused. */
  time: number;
  /** Metres moved so far (`Movement.travelled`): the gait follows it, so steps keep pace. */
  travelled: number;
  /** Metres per second (`Movement.speed`): the gait shows in full from `FULL_MOTION_SPEED`. */
  speed: number;
  /** The snapshot's animation profile ("walk", "hop", "swim"); unknown or none: no gait. */
  gait: string | undefined;
  /** How far through a bank jump (0–1) while in the air; it takes the gait's place. */
  leap: number | undefined;
  /** The creature's own 0–1 phase (`cuePhase`), so neighbours blink and twitch apart. */
  phase: number;
  /**
   * The body's height in metres as the whole-body profiles see it (`LocomotionInput.height`), so
   * the legs tuck to the hop the body makes, even when a preview scales the body.
   */
  height: number;
  /** Its cue weights, linear as `stepCueWeights` keeps them; eased here. */
  cues: CueWeights;
}

/**
 * One creature's pose for its parts: per part a local joint rotation and a squash. `writeMotion`
 * writes it; a later pass may change it; `composePose` reads it. Allocated once per creature.
 */
export interface MotionPose {
  /** Per part `i`, its rotation as a unit quaternion [x, y, z, w] at `4i`. */
  readonly rotations: Float64Array;
  /** Per part, how tall it is along the body's vertical, about its middle: 1 for as built. */
  readonly squash: Float64Array;
  /** Per part, scratch for `composePose`: its turn from the rest pose, in the body frame. */
  readonly turns: readonly THREE.Matrix4[];
}

/** A rest pose for `rig`'s creatures, to reuse every frame. */
export function createMotionPose(rig: MotionRig): MotionPose {
  const count = rig.parts.length;
  const pose: MotionPose = {
    rotations: new Float64Array(count * 4),
    squash: new Float64Array(count),
    turns: Array.from({ length: count }, () => new THREE.Matrix4()),
  };
  return resetPose(pose);
}

/** Puts every part of `pose` back at rest. Returns it. */
export function resetPose(pose: MotionPose): MotionPose {
  const { rotations, squash } = pose;
  for (let i = 0; i < squash.length; i++) {
    rotations[4 * i] = 0;
    rotations[4 * i + 1] = 0;
    rotations[4 * i + 2] = 0;
    rotations[4 * i + 3] = 1;
    squash[i] = 1;
  }
  return pose;
}

// Tuned on captures at strip size and close up (M22 PR 5). Angles in radians, times in seconds.

/** The walk: each leg's own amplitude (`RigLeg.amplitude`), the head nodding on each footfall. */
export const WALK = { headNod: 0.06, tailWag: 0.25, earBounce: 0.08 } as const;
/** The hop: legs reach out at take-off and landing and tuck under in the air; ears trail. */
export const HOP = { reach: 0.3, tuck: 0.5, earTrail: 0.3 } as const;
/** The bank leap: the legs tuck under. */
export const LEAP = { tuck: 0.55 } as const;
/** The swim: legs paddle slowly, one stroke per `stroke` strides; fins scull on their own time. */
export const SWIM = { legPaddle: 0.35, stroke: 1, fin: 0.35, finPeriod: 1.6, finAtRest: 0.4 };
/** Blinking: about every `period` seconds, shut for `seconds`, the eye squashed to `closed`. */
export const BLINK = { period: 4, seconds: 0.16, closed: 0.15 } as const;
/** An ear twitches outward about every `period` seconds, for `seconds`. */
export const EAR_TWITCH = { angle: 0.3, period: 5.5, seconds: 0.25 } as const;
/** A tail flicks side to side twice about every `period` seconds, for `seconds`. */
export const TAIL_FLICK = { angle: 0.4, period: 7, seconds: 0.6 } as const;
/** Asleep: the head droops, the ears drop back and out, the tail curls round. */
export const SLEEP = { headDroop: 0.2, earBack: 0.5, earOut: 0.25, tailCurl: 0.45 } as const;
/** Eating: the head dips this far at the bottom of each peck (`eatingPeck`). */
export const EAT = { headDip: 0.25 } as const;
/** An event in a stream comes at a point within the first share of its period, so never in step. */
const EVENT_JITTER = 0.6;

const TAU = 2 * Math.PI;
const clampSwing = (a: number) => Math.min(MAX_SWING, Math.max(-MAX_SWING, a));

/** A deterministic 0–1 hash of a whole number `n` in a stream `seed` (0–1). */
function hash01(n: number, seed: number): number {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ Math.floor(seed * 0x100000000);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/**
 * Seconds since the latest event in a stream of about one every `period` seconds: one per period,
 * each at a point within the first `EVENT_JITTER` of it that the stream `seed` gives.
 */
function sinceEvent(time: number, period: number, seed: number): number {
  const t = time + seed * period;
  const k = Math.floor(t / period);
  let start = (k + EVENT_JITTER * hash01(k, seed)) * period;
  if (t < start) start = (k - 1 + EVENT_JITTER * hash01(k - 1, seed)) * period;
  return t - start;
}

/** A pulse 0 → 1 → 0 over `seconds` after an event, 0 before and after. */
const pulse = (since: number, seconds: number) =>
  since >= 0 && since < seconds ? Math.sin((Math.PI * since) / seconds) : 0;

// Streams, so a creature's blinks, twitches and flicks don't come together.
const BLINK_STREAM = 0.137;
const EAR_STREAM = 0.511;
const TAIL_STREAM = 0.829;

/** The frame's shared values: weights and the gait's timing. Reused, never allocated per frame. */
interface Frame {
  input: MotionInput;
  gait: number;
  sleeping: number;
  eating: number;
  /** Gait cycles so far: travelled over the stride. */
  cycles: number;
  walk: boolean;
  swim: boolean;
  /** The hop's progress (0–1) while hopping, else undefined. */
  hop: number | undefined;
}

const frame: Frame = {
  input: undefined as unknown as MotionInput,
  gait: 0,
  sleeping: 0,
  eating: 0,
  cycles: 0,
  walk: false,
  swim: false,
  hop: undefined,
};

/** A part's turn this frame as body-frame angles, before mirroring. */
interface Turn {
  x: number;
  y: number;
  z: number;
  squash: number;
}

type Motion = (part: RigPart, f: Frame, out: Turn) => void;

/** `swing`: legs and arms, per gait. Still at rest. */
const swing: Motion = (part, f, out) => {
  const leg = part.leg;
  if (!leg) return;
  const dir = leg.front ? 1 : -1;
  if (f.input.leap !== undefined) {
    out.z = -dir * LEAP.tuck * Math.sin(Math.PI * Math.min(1, Math.max(0, f.input.leap)));
    return;
  }
  const w = f.gait;
  if (f.walk) out.z = w * leg.amplitude * Math.sin(TAU * (f.cycles + leg.offset));
  else if (f.swim)
    out.z = w * SWIM.legPaddle * Math.sin(TAU * (f.cycles / SWIM.stroke + leg.offset));
  else if (f.hop !== undefined) {
    // All legs together: reaching out (+1) at landing and take-off, tucked under (−1) mid-air.
    const u = f.hop;
    const shape =
      u < HOP_GROUND
        ? 1 - Math.sin((Math.PI * u) / HOP_GROUND)
        : Math.cos((TAU * (u - HOP_GROUND)) / (1 - HOP_GROUND));
    out.z = w * dir * (shape >= 0 ? HOP.reach : HOP.tuck) * shape;
  }
};

/** `wag`: tails. An occasional flick, a wag with the walk, curled round asleep. */
const wag: Motion = (_part, f, out) => {
  const { time, phase } = f.input;
  const since = sinceEvent(time, TAIL_FLICK.period, (phase + TAIL_STREAM) % 1);
  const flick = pulse(since, TAIL_FLICK.seconds) * Math.sin((2 * TAU * since) / TAIL_FLICK.seconds);
  const awake = 1 - f.sleeping;
  const walking = f.walk || f.swim ? f.gait * WALK.tailWag * Math.sin(TAU * f.cycles) : 0;
  out.y = awake * (TAIL_FLICK.angle * flick + walking) + f.sleeping * SLEEP.tailCurl;
};

/** `bob`: heads. A nod on each footfall, a dip with each peck, a droop asleep. */
const bob: Motion = (_part, f, out) => {
  const { time, phase } = f.input;
  const nod = f.walk ? f.gait * WALK.headNod * (0.5 - 0.5 * Math.cos(2 * TAU * f.cycles)) : 0;
  out.z = -(nod + f.eating * EAT.headDip * eatingPeck(time, phase) + f.sleeping * SLEEP.headDroop);
};

/** `paddle`: fins. They scull in water, a little even at rest, and hold still on land. */
const paddle: Motion = (_part, f, out) => {
  if (!f.swim) return;
  const { time, phase } = f.input;
  const strength = SWIM.finAtRest + (1 - SWIM.finAtRest) * f.gait;
  out.x = -strength * SWIM.fin * Math.sin(TAU * (time / SWIM.finPeriod + phase));
};

/** `flop`: ears. An occasional twitch outward, a bounce with the gait, dropped asleep. */
const flop: Motion = (part, f, out) => {
  const { time, phase } = f.input;
  const awake = 1 - f.sleeping;
  const twitch = pulse(sinceTwitch(time, phase), EAR_TWITCH.seconds);
  let back = 0;
  if (f.walk) back = f.gait * WALK.earBounce * Math.sin(2 * TAU * f.cycles);
  else if (f.hop !== undefined && f.hop >= HOP_GROUND)
    back = f.gait * HOP.earTrail * Math.sin((Math.PI * (f.hop - HOP_GROUND)) / (1 - HOP_GROUND));
  // A turn about +Z tips an ear's top towards −X, back. Outward is a turn about +X for an ear on
  // the right (+Z), about −X on the left. `writeMotion` mirrors a reflected part's turn after
  // this, so a reflected ear's turn is given unmirrored: the mirror then turns it outward.
  out.z = awake * back + f.sleeping * SLEEP.earBack;
  const outward = part.mirrored ? -part.side : part.side;
  out.x = outward * (awake * EAR_TWITCH.angle * twitch + f.sleeping * SLEEP.earOut);
};

/**
 * Seconds since the latest ear twitch, or a negative number before it starts. A twitch that would
 * overlap a blink waits until the blink is over, so the two never come together: blinks are at
 * least 40% of `BLINK.period` apart, far more than a twitch and a blink take.
 */
function sinceTwitch(time: number, phase: number): number {
  const since = sinceEvent(time, EAR_TWITCH.period, (phase + EAR_STREAM) % 1);
  const start = time - since;
  // The latest blink to start before the twitch ends: overlapping if it ends after it starts.
  const end = start + EAR_TWITCH.seconds;
  const blink = end - sinceEvent(end, BLINK.period, (phase + BLINK_STREAM) % 1);
  return blink + BLINK.seconds > start ? time - (blink + BLINK.seconds) : since;
}

/** `blink`: eyes. A blink every few seconds, shut asleep. */
const blink: Motion = (_part, f, out) => {
  const { time, phase } = f.input;
  const shut = pulse(sinceEvent(time, BLINK.period, (phase + BLINK_STREAM) % 1), BLINK.seconds);
  out.squash = 1 - (1 - BLINK.closed) * Math.max(shut, f.sleeping);
};

const MOTIONS: Readonly<Record<string, Motion>> = { swing, wag, bob, paddle, flop, blink };

const turn: Turn = { x: 0, y: 0, z: 0, squash: 1 };
const euler = new THREE.Euler(0, 0, 0, "XYZ");
const quaternion = new THREE.Quaternion();

/**
 * Writes the motion of every part of `rig` for `input` into `pose` and returns it. Parts with no
 * motion, an unknown one, and the root stay at rest. Each turn is capped at `MAX_SWING` about each
 * axis. Allocates nothing.
 */
export function writeMotion(rig: MotionRig, input: MotionInput, pose: MotionPose): MotionPose {
  const gait = input.leap === undefined ? input.gait : undefined;
  frame.input = input;
  frame.gait = ease(input.speed / FULL_MOTION_SPEED);
  frame.sleeping = ease(input.cues.sleeping);
  frame.eating = ease(input.cues.eating);
  frame.cycles = input.travelled / rig.stride;
  frame.walk = gait === "walk";
  frame.swim = gait === "swim";
  frame.hop = gait === "hop" ? hopProgress(input.travelled, input.height) : undefined;
  const { rotations, squash } = pose;
  const parts = rig.parts;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    turn.x = 0;
    turn.y = 0;
    turn.z = 0;
    turn.squash = 1;
    const motion = part.motion === undefined ? undefined : MOTIONS[part.motion];
    motion?.(part, frame, turn);
    quaternion.setFromEuler(euler.set(clampSwing(turn.x), clampSwing(turn.y), clampSwing(turn.z)));
    const mirror = part.mirrored ? -1 : 1;
    rotations[4 * i] = mirror * quaternion.x;
    rotations[4 * i + 1] = mirror * quaternion.y;
    rotations[4 * i + 2] = quaternion.z;
    rotations[4 * i + 3] = quaternion.w;
    squash[i] = turn.squash;
  }
  return pose;
}
