import type { CreatureSnapshot, SimulationSnapshot } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import {
  MAX_SIZE_CLASS_RADIUS,
  SIZE_CLASSES,
  WORLD_TOLERANCES,
  jumpClearance,
} from "@living-diorama/content-schema";
import {
  JUMP_MAX_INTERVALS,
  JUMP_MS,
  MAX_BANK_JUMP,
  MIN_BANK_JUMP,
  SNAP_DISTANCE,
  SnapshotInterpolator,
  arcHeight,
  isBankJump,
} from "./interpolation";

const at = (x: number): CreatureSnapshot => ({
  id: "a",
  speciesId: "test:critter",
  position: { regionId: "r", x, z: 0 },
  world: { x, y: 0, z: 0 },
  heading: 0,
  animation: undefined,
  submersion: 0,
  cues: [],
});

const snapshot = (tick: number, x: number): SimulationSnapshot => ({
  tick,
  timeMs: tick * 100,
  paused: false,
  timeOfDay: 720,
  creatures: [at(x)],
});

describe("SnapshotInterpolator.reset", () => {
  it("takes the next snapshot as it is, even of an older tick", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(500, 0), 0);
    interpolator.push(snapshot(501, 1), 100);
    // Without a reset an older tick is ignored.
    interpolator.push(snapshot(40, 2), 200);
    expect(interpolator.sample(300)[0]!.world.x).toBe(1);

    interpolator.reset();
    // Until the next snapshot the newest one is still drawn.
    expect(interpolator.sample(300)[0]!.world.x).toBe(1);
    interpolator.push(snapshot(40, 2), 300);
    // Drawn as it is, not blended from the replaced world.
    expect(interpolator.sample(310)[0]!.world.x).toBe(2);
    interpolator.push(snapshot(41, 3), 400);
    expect(interpolator.sample(450)[0]!.world.x).toBeCloseTo(2.5);
  });

  it("doesn't blend across a tick jump ahead either", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, 0), 0);
    interpolator.reset();
    interpolator.push(snapshot(400_000, 1), 100);
    expect(interpolator.sample(150)[0]!.world.x).toBe(1);
  });
});

// A large creature's bank jump, as navigation has it (ADR 0020 §4): land and water cell centres
// `bankReach` apart, the land `maxBankJumpHeight` above the water.
const LARGE_REACH = 2 * SIZE_CLASSES.large.radius + WORLD_TOLERANCES.maxBankJumpGap;
const BANK_HEIGHT = WORLD_TOLERANCES.maxBankJumpHeight;

const on = (x: number, y: number, medium: "land" | "water"): CreatureSnapshot => ({
  ...at(x),
  world: { x, y, z: 0 },
  animation: medium === "land" ? "walk" : "swim",
  submersion: medium === "land" ? 0 : 0.4,
});

const frame = (tick: number, creature: CreatureSnapshot): SimulationSnapshot => ({
  ...snapshot(tick, 0),
  creatures: [creature],
});

/** The poses every `step` ms from `start` to `end`. */
function track(interpolator: SnapshotInterpolator, start: number, end: number, step = 5) {
  const poses = [];
  for (let now = start; now <= end; now += step) poses.push(interpolator.sample(now)[0]!);
  return poses;
}

describe("SNAP_DISTANCE", () => {
  it("lies above the longest bank jump of the largest creature, so real jumps are drawn", () => {
    expect(LARGE_REACH).toBeCloseTo(3.35);
    expect(MAX_BANK_JUMP).toBeCloseTo(Math.hypot(LARGE_REACH, BANK_HEIGHT));
    expect(SNAP_DISTANCE).toBeGreaterThan(MAX_BANK_JUMP);
    // But not by so much that a teleport of a few metres glides.
    expect(SNAP_DISTANCE).toBeLessThan(MAX_BANK_JUMP + 1);
  });

  it("blends a move up to it and draws a longer one as it is", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, 0), 0);
    interpolator.push(snapshot(2, SNAP_DISTANCE - 0.01), 100);
    expect(interpolator.sample(150)[0]!.world.x).toBeCloseTo((SNAP_DISTANCE - 0.01) / 2);

    interpolator.push(snapshot(3, SNAP_DISTANCE * 2 + 0.1), 200);
    expect(interpolator.sample(250)[0]!.world.x).toBeCloseTo(SNAP_DISTANCE * 2 + 0.1);
  });
});

describe("isBankJump", () => {
  it("is a move between land and water longer than a walk's tick, up to the snap distance", () => {
    const land = on(0, BANK_HEIGHT, "land");
    expect(isBankJump(land, on(LARGE_REACH, 0, "water"))).toBe(true);
    expect(isBankJump(on(LARGE_REACH, 0, "water"), land)).toBe(true);
    expect(isBankJump(on(0, 0, "land"), on(MIN_BANK_JUMP, 0, "water"))).toBe(true);
  });

  it("is not a move within one medium, a walk across a shore exit or a teleport", () => {
    const land = on(0, 0, "land");
    expect(isBankJump(land, on(2, 0, "land"))).toBe(false);
    expect(isBankJump(on(0, 0, "water"), on(2, 0, "water"))).toBe(false);
    expect(isBankJump(land, on(0.06, 0, "water"))).toBe(false);
    expect(isBankJump(land, on(SNAP_DISTANCE + 0.1, 0, "water"))).toBe(false);
  });

  it("sees a change of profile alone, for a swimmer that doesn't sink", () => {
    const floating = { ...on(1, 0, "water"), submersion: 0 };
    expect(isBankJump(on(0, 0, "land"), floating)).toBe(true);
  });
});

describe("arcHeight", () => {
  const top = (y0: number, y1: number, h: number) => {
    let best = -Infinity;
    for (let s = 0; s <= 1; s += 0.0005) {
      best = Math.max(best, y0 + (y1 - y0) * s + 4 * h * s * (1 - s));
    }
    return best;
  };

  it("puts the apex the clearance above the higher end, going up, down or level", () => {
    for (const [y0, y1] of [
      [0, 0],
      [0, 0.75],
      [0.75, 0],
      [1.2, 1.1],
    ] as const) {
      const h = arcHeight(y0, y1, 0.4);
      expect(top(y0, y1, h)).toBeCloseTo(Math.max(y0, y1) + 0.4, 3);
    }
    expect(arcHeight(0, 0, 0.4)).toBeCloseTo(0.4);
  });

  it("rises higher the longer the jump, up to the creature's radius", () => {
    expect(jumpClearance(0.3)).toBeCloseTo(0.16);
    expect(jumpClearance(MAX_BANK_JUMP)).toBeGreaterThan(jumpClearance(1));
    const reach = (size: keyof typeof SIZE_CLASSES) =>
      2 * SIZE_CLASSES[size].radius + WORLD_TOLERANCES.maxBankJumpGap;
    expect(jumpClearance(reach("tiny"), SIZE_CLASSES.tiny.radius)).toBeCloseTo(0.1);
    expect(jumpClearance(reach("small"), SIZE_CLASSES.small.radius)).toBeCloseTo(0.2);
    expect(jumpClearance(reach("medium"), SIZE_CLASSES.medium.radius)).toBeCloseTo(0.4);
    expect(jumpClearance(reach("large"), SIZE_CLASSES.large.radius)).toBeCloseTo(0.77);
  });
});

describe("SnapshotInterpolator bank jumps", () => {
  /** A large creature on the bank, then in the water one tick later. */
  function jumpIn(intervalMs = 100) {
    const interpolator = new SnapshotInterpolator(intervalMs);
    interpolator.push(frame(1, on(0, BANK_HEIGHT, "land")), 0);
    interpolator.push(frame(2, on(LARGE_REACH, 0, "water")), intervalMs);
    return interpolator;
  }

  it("draws the jump as an arc from take-off to landing over JUMP_MS", () => {
    const interpolator = jumpIn();
    const start = interpolator.sample(100)[0]!;
    expect(start.world).toEqual({ x: 0, y: BANK_HEIGHT, z: 0 });
    expect(start.jump).toBe(0);
    expect(start.submersion).toBe(0);

    const flight = track(interpolator, 100, 100 + JUMP_MS - 1);
    expect(flight.every((pose) => pose.jump !== undefined)).toBe(true);
    const apex = Math.max(...flight.map((pose) => pose.world.y));
    expect(apex).toBeCloseTo(BANK_HEIGHT + jumpClearance(LARGE_REACH), 2);
    // Forward all the way, never back.
    for (let k = 1; k < flight.length; k++) {
      expect(flight[k]!.world.x).toBeGreaterThanOrEqual(flight[k - 1]!.world.x);
    }

    const landed = interpolator.sample(100 + JUMP_MS)[0]!;
    expect(landed.jump).toBeUndefined();
    expect(landed.world).toEqual({ x: LARGE_REACH, y: 0, z: 0 });
    expect(landed.submersion).toBe(0.4);
    expect(landed.animation).toBe("swim");
  });

  it("is clear of the water at the apex and sinks on landing; rises out jumping out", () => {
    const interpolator = jumpIn();
    expect(interpolator.sample(100 + JUMP_MS / 2)[0]!.submersion).toBe(0);
    expect(interpolator.sample(100 + JUMP_MS * 0.9)[0]!.submersion).toBeGreaterThan(0.3);

    const out = new SnapshotInterpolator(100);
    out.push(frame(1, on(LARGE_REACH, 0, "water")), 0);
    out.push(frame(2, on(0, BANK_HEIGHT, "land")), 100);
    expect(out.sample(100)[0]!.submersion).toBe(0.4);
    expect(out.sample(100 + JUMP_MS * 0.4)[0]!.submersion).toBeLessThan(0.05);
    const flight = track(out, 100, 100 + JUMP_MS - 1);
    // Comes down onto the bank from above it, never through its face.
    const descent = flight.slice(flight.length / 2);
    expect(descent.every((pose) => pose.world.y >= BANK_HEIGHT - 1e-9)).toBe(true);
  });

  it("follows the creature as it moves off after landing, ending on its blended pose", () => {
    const interpolator = jumpIn();
    interpolator.push(frame(3, on(LARGE_REACH + 0.05, 0, "water")), 200);
    interpolator.push(frame(4, on(LARGE_REACH + 0.1, 0, "water")), 300);
    interpolator.push(frame(5, on(LARGE_REACH + 0.15, 0, "water")), 400);
    const end = interpolator.sample(100 + JUMP_MS)[0]!;
    expect(end.jump).toBeUndefined();
    expect(end.world.x).toBeCloseTo(LARGE_REACH + 0.125);
    const before = interpolator.sample(100 + JUMP_MS - 1)[0]!;
    expect(before.world.x).toBeCloseTo(end.world.x, 1);
    expect(before.world.y).toBeCloseTo(end.world.y, 1);
  });

  it("shortens the arc in a world sped up, to JUMP_MAX_INTERVALS snapshots", () => {
    const interpolator = jumpIn(10);
    const end = 10 + 10 * JUMP_MAX_INTERVALS;
    expect(interpolator.sample(end - 1)[0]!.jump).toBeDefined();
    expect(interpolator.sample(end)[0]!.jump).toBeUndefined();
  });

  it("keeps a tiny creature's arc low, under the Hollow deck's headroom of about 0.37 m", () => {
    const tiny = new SnapshotInterpolator(100, () => ({ sizeClass: "tiny" }));
    const reach = 2 * SIZE_CLASSES.tiny.radius + WORLD_TOLERANCES.maxBankJumpGap;
    tiny.push(frame(1, on(0, 0, "land")), 0);
    tiny.push(frame(2, on(reach, 0, "water")), 100);
    const apex = Math.max(...track(tiny, 100, 100 + JUMP_MS - 1).map((pose) => pose.world.y));
    expect(apex).toBeCloseTo(SIZE_CLASSES.tiny.radius, 2);
    expect(apex + SIZE_CLASSES.tiny.height).toBeLessThan(0.37);
  });

  it("caps the arc at the largest size class's radius when the size is unknown", () => {
    expect(jumpClearance(10)).toBeCloseTo(MAX_SIZE_CLASS_RADIUS);
    // Longer than any bank but still drawn as a jump: uncapped, it would rise about 0.86 m.
    const horizontal = 3.8;
    expect(horizontal).toBeLessThan(SNAP_DISTANCE);
    for (const sizeOf of [undefined, () => undefined]) {
      const interpolator = new SnapshotInterpolator(100, sizeOf);
      interpolator.push(frame(1, on(0, 0, "land")), 0);
      interpolator.push(frame(2, on(horizontal, 0, "water")), 100);
      const flight = track(interpolator, 100, 100 + JUMP_MS - 1);
      const apex = Math.max(...flight.map((pose) => pose.world.y));
      expect(apex).toBeCloseTo(MAX_SIZE_CLASS_RADIUS, 2);
    }
  });

  it("takes a second jump in the next tick off from where the first is drawn, without a pop", () => {
    // A water leg of no length between two banks: in, then straight out on the far side.
    const interpolator = new SnapshotInterpolator(100);
    const pushes = new Map([
      [0, frame(1, on(0, BANK_HEIGHT, "land"))],
      [100, frame(2, on(LARGE_REACH, 0, "water"))],
      [200, frame(3, on(2 * LARGE_REACH, BANK_HEIGHT, "land"))],
    ]);
    const poses = [];
    for (let now = 0; now <= 700; now += 5) {
      const snapshot = pushes.get(now);
      if (snapshot) interpolator.push(snapshot, now);
      poses.push(interpolator.sample(now)[0]!);
    }
    for (let k = 1; k < poses.length; k++) {
      const [a, b] = [poses[k - 1]!, poses[k]!];
      expect(Math.hypot(b.world.x - a.world.x, b.world.y - a.world.y)).toBeLessThan(0.15);
      expect(Math.abs(b.submersion - a.submersion)).toBeLessThan(0.1);
    }
    expect(poses.at(-1)!.world).toEqual({ x: 2 * LARGE_REACH, y: BANK_HEIGHT, z: 0 });
    expect(poses.at(-1)!.jump).toBeUndefined();
  });

  it("draws ordinary walking without an arc", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(frame(1, on(0, 0, "land")), 0);
    interpolator.push(frame(2, on(0.06, 0, "land")), 100);
    const pose = interpolator.sample(150)[0]!;
    expect(pose.world.x).toBeCloseTo(0.03);
    expect(pose.jump).toBeUndefined();
  });

  it("starts no arc across a break, and drops one in the air on a reset", () => {
    const interpolator = jumpIn();
    interpolator.reset();
    interpolator.push(frame(3, on(LARGE_REACH, 0, "water")), 150);
    expect(interpolator.sample(160)[0]!.jump).toBeUndefined();

    const broken = new SnapshotInterpolator(100);
    broken.push(frame(1, on(0, BANK_HEIGHT, "land")), 0);
    broken.push(frame(2, on(LARGE_REACH, 0, "water")), 5000);
    expect(broken.sample(5100)[0]!.jump).toBeUndefined();
  });
});
