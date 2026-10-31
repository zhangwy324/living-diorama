import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  FULL_MOTION_SPEED,
  VOXEL_WALK,
  leapMotion,
  locomotionMotion,
  locomotionTransform,
  placePivots,
  restingLocomotion,
  restingMovement,
  trackMovement,
  type LocomotionBody,
  type LocomotionInput,
  type LocomotionMotion,
} from "./locomotion";
import { MAX_BANK_JUMP } from "./interpolation";

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
  it("draws no motion for an unknown profile, no profile, or a walker or hopper at rest", () => {
    // -0 and 0 are the same pose.
    const plain = (m: LocomotionMotion) => ({
      ...m,
      ...Object.fromEntries(NUMBERS.map((k) => [k, m[k] + 0])),
    });
    const rest = restingLocomotion();
    for (const profile of [undefined, "fly", "toString", "__proto__"]) {
      expect(plain(motion({ profile, travelled: 1.234 }))).toEqual(rest);
    }
    for (const profile of ["walk", "hop"]) {
      expect(plain(motion({ profile, speed: 0, travelled: 1.234, time: 3.3 }))).toEqual(rest);
    }
  });

  it("keeps a resting swimmer bobbing gently, floating, but without the sway", () => {
    const lifts: number[] = [];
    for (let time = 0; time < 3; time += 0.05) {
      const m = motion({ profile: "swim", speed: 0, travelled: 1.234, time });
      expect(m).toMatchObject({ pitch: 0, scaleY: 1, scaleXZ: 1 });
      expect(Math.abs(m.yaw)).toBe(0);
      expect(Math.abs(m.roll)).toBe(0);
      lifts.push(m.lift);
    }
    expect(Math.min(...lifts)).toBeLessThan(-0.025);
    expect(Math.max(...lifts)).toBeGreaterThan(0.025);
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

  it("walks with a small bob, a waddle from side to side and a slight lean, about the center of gravity", () => {
    const motions = sweep({ profile: "walk" });
    expect(motions.every((m) => m.pivot === "centerOfGravity" && m.yaw === 0)).toBe(true);
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

  describe("on a body whose legs swing (ADR 0024 §5)", () => {
    const legs = { step: 0.1, dip: 0.004 };

    it("damps the roll and squash, and dips as the legs swing out, once per step", () => {
      const drawn = sweep({ profile: "walk" });
      const voxel = sweep({ profile: "walk", legs });
      const reach = (motions: LocomotionMotion[], key: "roll" | "scaleY") =>
        Math.max(...motions.map((m) => Math.abs(m[key] - (key === "scaleY" ? 1 : 0))));
      expect(reach(voxel, "roll")).toBeCloseTo(VOXEL_WALK.roll * reach(drawn, "roll"), 3);
      expect(reach(voxel, "scaleY")).toBeCloseTo(VOXEL_WALK.squash * reach(drawn, "scaleY"), 3);
      expect(voxel.every((m) => m.pitch === drawn[0]!.pitch && m.yaw === 0)).toBe(true);
      // Back up as the legs pass under it, down by the dip at each half step, where they splay.
      // In metres: at full speed (0.6 m/s), for the default 0.4 m body.
      const at = (travelled: number) => motion({ profile: "walk", legs, travelled }).lift * 0.4;
      expect(at(legs.step * 3)).toBeCloseTo(0, 9);
      expect(at(legs.step * 3.5)).toBeCloseTo(-legs.dip, 9);
      expect(range(voxel, "lift").max).toBeLessThanOrEqual(1e-12);
    });

    it("leaves the swim and the hop as they are", () => {
      for (const profile of ["swim", "hop"]) {
        expect(sweep({ profile, legs })).toEqual(sweep({ profile }));
      }
    });
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
    expect(motions.every((m) => m.pivot === "centerOfGravity")).toBe(true);
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

  it("swims with a sway about its front and a gentle bob, without squashing", () => {
    const motions = sweep({ profile: "swim" });
    expect(motions.every((m) => m.pivot === "front")).toBe(true);
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

describe("trackMovement on a bank jump", () => {
  const at = (x: number) => ({ x, y: 0, z: 0 });
  it("holds the speed and distance in the air, so the gait goes on where it left off", () => {
    const movement = restingMovement();
    trackMovement(movement, at(0), 0);
    for (let frame = 1; frame <= 60; frame++) trackMovement(movement, at(frame * 0.01), 1 / 60);
    const { speed, travelled } = movement;
    // A large creature's 3.4 m jump in a few frames: neither a dash nor a teleport.
    for (let frame = 1; frame <= 20; frame++) {
      trackMovement(movement, at(0.6 + frame * 0.17), 1 / 60, true);
    }
    expect(movement).toMatchObject({ speed, travelled });
    trackMovement(movement, at(4.01), 1 / 60);
    expect(movement.speed).toBeCloseTo(speed, 2);
  });

  it("is not a teleport even when a frame spans the whole of the longest jump", () => {
    const movement = restingMovement();
    trackMovement(movement, at(0), 0);
    for (let frame = 1; frame <= 60; frame++) trackMovement(movement, at(frame * 0.01), 1 / 60);
    trackMovement(movement, at(0.6 + MAX_BANK_JUMP), 1 / 60, true);
    expect(movement.speed).toBeGreaterThan(0);
  });
});

describe("leapMotion", () => {
  it("stretches and tips nose up as it leaves, nose down as it comes down, and lands plain", () => {
    const leap = (progress: number) => ({ ...leapMotion(progress, restingLocomotion()) });
    expect(leap(0)).toMatchObject({ lift: 0, scaleY: 1, scaleXZ: 1 });
    expect(leap(0).pitch).toBeCloseTo(0);
    expect(leap(1).pitch).toBeCloseTo(0);
    expect(leap(1).scaleY).toBeCloseTo(1);
    expect(leap(0.25).pitch).toBeLessThan(0);
    expect(leap(0.75).pitch).toBeGreaterThan(0);
    expect(leap(0.25).scaleY).toBeGreaterThan(1);
    expect(leap(0.5).pivot).toBe("centerOfGravity");
    // The arc is in the drawn position, so the leap itself never lifts.
    expect(leap(0.5).lift).toBe(0);
  });
});

describe("trackMovement while paused", () => {
  it("takes the last of the blend as it is, so resuming doesn't start with a dash", () => {
    const movement = restingMovement();
    trackMovement(movement, { x: 0, y: 0, z: 0 }, 0);
    for (let frame = 1; frame <= 60; frame++) {
      trackMovement(movement, { x: frame * 0.01, y: 0, z: 0 }, 1 / 60);
    }
    const { speed, travelled } = movement;
    // Paused: animation time stops while the pose finishes blending 6 cm further.
    trackMovement(movement, { x: 0.66, y: 0, z: 0 }, 0);
    expect(movement).toMatchObject({ speed, travelled });
    // Resumed: the next frame moves on at the same pace.
    trackMovement(movement, { x: 0.67, y: 0, z: 0 }, 1 / 60);
    expect(movement.speed).toBeCloseTo(speed, 3);
  });
});

describe("locomotionTransform", () => {
  const body = (pivotX: number): LocomotionBody => ({
    height: 0.8,
    minX: -0.3,
    maxX: 0.5,
    halfDepth: 0.1,
    pivots: {
      centerOfGravity: new THREE.Vector3(pivotX, 0, 0),
      front: new THREE.Vector3(0.3, 0.4, 0),
    },
  });
  const at = (motion: Partial<LocomotionMotion>) => ({ ...restingLocomotion(), ...motion });
  const matrix = new THREE.Matrix4();

  it("turns and scales the body about its pivot", () => {
    for (const motion of [
      at({ pitch: 0.2, roll: -0.1, scaleY: 0.8, scaleXZ: 1.1 }),
      at({ pivot: "front", yaw: 0.3, roll: 0.05 }),
    ]) {
      const b = body(0.2);
      locomotionTransform(motion, b, matrix);
      const pivot = b.pivots[motion.pivot];
      expect(pivot.clone().applyMatrix4(matrix).distanceTo(pivot)).toBeLessThan(1e-12);
    }
  });

  it("lifts a tilt about the center of gravity by the reach from it, and lifts nothing else", () => {
    // Pitching forward dips the front, 0.5 - 0.2 m ahead of the pivot; back, the rear, 0.5 m behind.
    expect(locomotionTransform(at({ pitch: 0.1 }), body(0.2), matrix)).toBeCloseTo(
      0.3 * Math.sin(0.1),
    );
    expect(locomotionTransform(at({ pitch: -0.1 }), body(0.2), matrix)).toBeCloseTo(
      0.5 * Math.sin(0.1),
    );
    expect(locomotionTransform(at({ roll: 0.1, lift: 0.5 }), body(0), matrix)).toBeCloseTo(
      0.1 * Math.sin(0.1) + 0.4,
    );
    expect(locomotionTransform(at({ pivot: "front", pitch: 0.1 }), body(0), matrix)).toBe(0);
    // The lowest corner ends up on the ground, not below it or above it.
    const b = body(0.2);
    const motion = at({ pitch: 0.15, scaleXZ: 1.05 });
    const lift = locomotionTransform(motion, b, matrix);
    const lowest = Math.min(
      ...[b.minX, b.maxX].map((x) => new THREE.Vector3(x, 0, 0).applyMatrix4(matrix).y + lift),
    );
    expect(lowest).toBeCloseTo(0, 9);
  });
});

describe("placePivots", () => {
  it("puts the center of gravity on the ground and the swim's pivot near the front, in line with the tail", () => {
    const body: LocomotionBody = {
      height: 0.8,
      minX: -0.4,
      maxX: 0.4,
      halfDepth: 0.1,
      pivots: { centerOfGravity: new THREE.Vector3(), front: new THREE.Vector3() },
    };
    placePivots(body, new THREE.Vector3(-0.1, 0.3, 0), new THREE.Vector3(-0.4, 0.5, 0));
    expect(body.pivots.centerOfGravity.toArray()).toEqual([-0.1, 0, 0]);
    // The tail mirrored onto the front (0.4), a quarter of the way back towards the tail.
    expect(body.pivots.front.x).toBeCloseTo(0.2);
    expect(body.pivots.front.y).toBe(0.5);
  });
});
