import { describe, expect, it } from "vitest";
import {
  FULL_MOTION_SPEED,
  locomotionMotion,
  restingLocomotion,
  restingMovement,
  trackMovement,
  type LocomotionInput,
  type LocomotionMotion,
} from "./locomotion";

const input = (overrides: Partial<LocomotionInput> = {}): LocomotionInput => ({
  profile: "walk",
  speed: 0.6,
  travelled: 0,
  time: 0,
  phase: 0,
  height: 0.4,
  ...overrides,
});

const motion = (overrides: Partial<LocomotionInput> = {}) =>
  locomotionMotion(input(overrides), restingLocomotion());

/** The motion every `step` metres over `metres` travelled. */
function sweep(overrides: Partial<LocomotionInput>, metres = 4, step = 0.002): LocomotionMotion[] {
  const out: LocomotionMotion[] = [];
  for (let travelled = 0; travelled <= metres; travelled += step) {
    out.push({ ...motion({ ...overrides, travelled, time: travelled / 0.6 }) });
  }
  return out;
}

const NUMBERS = ["lift", "pitch", "roll", "yaw", "scaleY", "scaleXZ"] as const;
const range = (motions: LocomotionMotion[], key: (typeof NUMBERS)[number]) => {
  const values = motions.map((m) => m[key]);
  return { min: Math.min(...values), max: Math.max(...values) };
};

describe("locomotionMotion", () => {
  it("draws no motion for an unknown profile, no profile, or a creature at rest", () => {
    const rest = restingLocomotion();
    for (const profile of [undefined, "fly", "toString", "__proto__"]) {
      expect(motion({ profile, travelled: 1.234 })).toEqual(rest);
    }
    for (const profile of ["walk", "hop", "swim"]) {
      expect(motion({ profile, speed: 0, travelled: 1.234, time: 3.3 })).toEqual(rest);
    }
  });

  it("moves more as the creature moves faster, in full from FULL_MOTION_SPEED", () => {
    const at = (speed: number) => motion({ profile: "walk", speed, travelled: 0.13 }).roll;
    expect(Math.abs(at(0.05))).toBeLessThan(Math.abs(at(0.15)));
    expect(Math.abs(at(0.15))).toBeLessThan(Math.abs(at(FULL_MOTION_SPEED)));
    expect(at(FULL_MOTION_SPEED)).toBeCloseTo(at(1.5));
  });

  it("changes smoothly as the creature moves, in every profile", () => {
    for (const profile of ["walk", "hop", "swim"]) {
      const motions = sweep({ profile });
      for (let i = 1; i < motions.length; i++) {
        for (const key of NUMBERS) {
          expect(Math.abs(motions[i]![key] - motions[i - 1]![key])).toBeLessThan(0.02);
        }
      }
    }
  });

  it("walks with a small bob, a waddle from side to side and a slight lean, about the feet", () => {
    const motions = sweep({ profile: "walk" });
    expect(motions.every((m) => m.pivot === "feet" && m.yaw === 0)).toBe(true);
    const lift = range(motions, "lift");
    expect(lift.min).toBeGreaterThanOrEqual(0); // the feet never sink
    expect(lift.max).toBeGreaterThan(0.03);
    expect(lift.max).toBeLessThanOrEqual(0.05 + 1e-9);
    const roll = range(motions, "roll");
    expect(roll.min).toBeLessThan(-0.05);
    expect(roll.max).toBeGreaterThan(0.05);
    expect(range(motions, "pitch").min).toBeGreaterThan(0); // leaning into the walk
    expect(range(motions, "scaleY").min).toBeGreaterThan(0.95);
  });

  it("takes longer steps with a bigger body", () => {
    // The first step lands (lift back to 0) further along for a taller body.
    const firstLanding = (height: number) =>
      sweep({ profile: "walk", height }, 2).findIndex((m, i) => i > 10 && m.lift < 1e-4);
    expect(firstLanding(1.6)).toBeGreaterThan(firstLanding(0.4));
    expect(firstLanding(0.4)).toBeGreaterThan(firstLanding(0.2));
  });

  it("hops: squashes on the ground before take-off and after landing, and arcs through the air", () => {
    const motions = sweep({ profile: "hop" });
    expect(motions.every((m) => m.pivot === "feet")).toBe(true);
    const grounded = motions.filter((m) => m.lift === 0);
    const airborne = motions.filter((m) => m.lift > 0);
    expect(grounded.length).toBeGreaterThan(0);
    expect(airborne.length).toBeGreaterThan(grounded.length);
    // Squashed only on the ground, stretched only in the air.
    expect(Math.min(...grounded.map((m) => m.scaleY))).toBeLessThan(0.9);
    expect(grounded.every((m) => m.scaleY <= 1 && m.scaleXZ >= 1)).toBe(true);
    expect(airborne.every((m) => m.scaleY >= 1 && m.scaleXZ <= 1)).toBe(true);
    expect(range(motions, "lift").max).toBeCloseTo(0.35, 2);
    // Nose up as it leaves, nose down as it comes down.
    const pitch = range(airborne, "pitch");
    expect(pitch.min).toBeLessThan(-0.1);
    expect(pitch.max).toBeGreaterThan(0.1);
    // One take-off: lift 0, then up, peaking, back down, then 0.
    const firstAir = motions.findIndex((m) => m.lift > 0);
    const landed = motions.findIndex((m, i) => i > firstAir && m.lift === 0);
    const arc = motions.slice(firstAir, landed).map((m) => m.lift);
    const peak = arc.indexOf(Math.max(...arc));
    expect(peak / arc.length).toBeCloseTo(0.5, 1);
  });

  it("swims with a sway about the tail and a gentle bob, without squashing", () => {
    const motions = sweep({ profile: "swim" });
    expect(motions.every((m) => m.pivot === "tail")).toBe(true);
    const yaw = range(motions, "yaw");
    expect(yaw.min).toBeLessThan(-0.15);
    expect(yaw.max).toBeGreaterThan(0.15);
    const lift = range(motions, "lift");
    expect(lift.min).toBeLessThan(0); // in water the body may dip
    expect(Math.max(-lift.min, lift.max)).toBeLessThanOrEqual(0.03 + 1e-9);
    expect(motions.every((m) => m.scaleY === 1 && m.scaleXZ === 1 && m.pitch === 0)).toBe(true);
  });

  it("keeps neighbours out of step through their own phase", () => {
    const a = motion({ profile: "swim", time: 1, phase: 0 }).lift;
    const b = motion({ profile: "swim", time: 1, phase: 0.4 }).lift;
    expect(a).not.toBeCloseTo(b);
  });
});

describe("trackMovement", () => {
  const at = (x: number) => ({ x, y: 0, z: 0 });

  it("learns the speed from how far the creature moves, smoothing it, and adds up the distance", () => {
    const movement = restingMovement();
    trackMovement(movement, at(0), 0);
    expect(movement.speed).toBe(0);
    for (let frame = 1; frame <= 120; frame++) trackMovement(movement, at(frame * 0.01), 1 / 60);
    expect(movement.speed).toBeCloseTo(0.6, 3);
    expect(movement.travelled).toBeGreaterThan(0.9);
    expect(movement.travelled).toBeLessThanOrEqual(1.2);
    // It comes to rest smoothly once the creature stops.
    trackMovement(movement, at(1.2), 1 / 60);
    expect(movement.speed).toBeGreaterThan(0.3);
    for (let frame = 0; frame < 120; frame++) trackMovement(movement, at(1.2), 1 / 60);
    expect(movement.speed).toBeLessThan(1e-3);
  });

  it("holds still while paused, and starts afresh after a teleport or a break", () => {
    const movement = restingMovement();
    trackMovement(movement, at(0), 0);
    for (let frame = 1; frame <= 60; frame++) trackMovement(movement, at(frame * 0.01), 1 / 60);
    const { speed, travelled } = movement;
    trackMovement(movement, at(0.6), 0); // paused: no animation time passes
    expect(movement).toMatchObject({ speed, travelled });
    trackMovement(movement, at(10), 1 / 60); // a teleport
    expect(movement.speed).toBe(0);
    trackMovement(movement, at(10.01), 1 / 60);
    expect(movement.speed).toBeGreaterThan(0);
    trackMovement(movement, at(10.5), 5); // a break, e.g. the window was hidden
    expect(movement.speed).toBe(0);
    expect(movement.last).toEqual(at(10.5));
  });
});
