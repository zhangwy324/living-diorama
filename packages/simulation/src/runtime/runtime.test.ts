import { describe, expect, it } from "vitest";
import { FixedClock, isValidSpeed, MAX_SPEED, normalizeHeading, Rng } from "../index";

describe("FixedClock", () => {
  it("releases whole ticks and carries the remainder", () => {
    const clock = new FixedClock({ tickRateHz: 10 });
    expect(clock.advance(1000)).toBe(0); // sets the baseline
    expect(clock.advance(1150)).toBe(1);
    expect(clock.advance(1300)).toBe(2); // 50 ms carried + 150 ms
    expect(clock.advance(1300)).toBe(0);
    expect(clock.advance(1290)).toBe(0); // time going backwards never ticks
  });

  it("drops time beyond the catch-up limit, e.g. after sleep", () => {
    const clock = new FixedClock({ tickRateHz: 10, maxCatchUpTicks: 5 });
    clock.advance(0);
    expect(clock.advance(3_600_000)).toBe(5);
    expect(clock.advance(3_600_050)).toBe(0);
    expect(clock.advance(3_600_100)).toBe(1);
  });

  it("does not tick while paused or count paused time after resuming", () => {
    const clock = new FixedClock({ tickRateHz: 10 });
    clock.advance(0);
    clock.pause();
    expect(clock.advance(500)).toBe(0);
    clock.resume();
    expect(clock.advance(5000)).toBe(0);
    expect(clock.advance(5100)).toBe(1);
  });

  it("scales elapsed time by the speed multiplier", () => {
    const clock = new FixedClock({ tickRateHz: 10 });
    clock.setSpeed(4);
    clock.advance(0);
    expect(clock.advance(100)).toBe(4);
    expect(() => clock.setSpeed(0)).toThrow(RangeError);
    expect(() => new FixedClock({ tickRateHz: 0 })).toThrow(RangeError);
  });

  it("raises the catch-up limit in proportion to a faster speed (issue #100)", () => {
    const clock = new FixedClock({ tickRateHz: 10 });
    clock.advance(0);
    clock.setSpeed(60);
    expect(clock.catchUpLimit).toBe(600);
    // A host advancing every 100 ms now gets 60 ticks each time, not 10.
    expect(clock.advance(100)).toBe(60);
    expect(clock.advance(200)).toBe(60);
    // Still at most one second of wall-clock time, e.g. after sleep at speed 60.
    expect(clock.advance(3_600_200)).toBe(600);
    expect(clock.advance(3_600_250)).toBe(30);
    clock.setSpeed(2.5);
    expect(clock.catchUpLimit).toBe(25);
    clock.setSpeed(1.1); // 10 × 1.1 is 11.000000000000002 in floating point
    expect(clock.catchUpLimit).toBe(11);
    clock.setSpeed(1.05);
    expect(clock.catchUpLimit).toBe(11);
  });

  it("accepts speeds up to MAX_SPEED and rejects faster ones", () => {
    const clock = new FixedClock({ tickRateHz: 10 });
    clock.setSpeed(MAX_SPEED);
    expect(clock.catchUpLimit).toBe(1000);
    expect(() => clock.setSpeed(MAX_SPEED + 0.5)).toThrow(RangeError);
    expect(clock.speed).toBe(MAX_SPEED);
    expect(isValidSpeed(100)).toBe(true);
    expect(isValidSpeed(101)).toBe(false);
    expect(isValidSpeed(0)).toBe(false);
  });

  it("keeps the catch-up limit at speed 1 or slower", () => {
    const clock = new FixedClock({ tickRateHz: 10 });
    clock.advance(0);
    expect(clock.catchUpLimit).toBe(10);
    expect(clock.advance(3_600_000)).toBe(10);
    clock.setSpeed(0.5);
    expect(clock.catchUpLimit).toBe(10);
    expect(clock.advance(7_200_000)).toBe(10);
    clock.setSpeed(60);
    clock.setSpeed(1);
    expect(clock.advance(10_800_000)).toBe(10);
  });
});

describe("Rng", () => {
  const take = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.nextUint32());

  it("is reproducible from a seed and differs between seeds", () => {
    expect(take(Rng.fromSeed(42), 8)).toEqual(take(Rng.fromSeed(42), 8));
    expect(take(Rng.fromSeed(42), 8)).not.toEqual(take(Rng.fromSeed(43), 8));
  });

  it("resumes from a JSON round-trip of its state", () => {
    const rng = Rng.fromSeed(7);
    take(rng, 100);
    const copy = new Rng(JSON.parse(JSON.stringify(rng.state)));
    expect(take(copy, 8)).toEqual(take(rng, 8));
  });

  it("forks by name, independent of how far the parent has advanced", () => {
    const parent = Rng.fromSeed(1);
    const early = take(parent.fork("creature-1"), 8);
    take(parent, 1000);
    expect(take(parent.fork("creature-1"), 8)).toEqual(early);
    expect(take(parent.fork("creature-2"), 8)).not.toEqual(early);
    // Forks of forks are distinct from same-named forks of the root.
    expect(take(parent.fork("a").fork("b"), 8)).not.toEqual(take(parent.fork("b"), 8));
  });

  it("produces roughly uniform floats and in-range integers", () => {
    const rng = Rng.fromSeed(3);
    const buckets = new Array<number>(10).fill(0);
    for (let k = 0; k < 100_000; k++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      buckets[Math.floor(v * 10)]!++;
    }
    for (const count of buckets) expect(Math.abs(count - 10_000)).toBeLessThan(500);
    for (let k = 0; k < 1000; k++) {
      const n = rng.int(-2, 3);
      expect(Number.isInteger(n) && n >= -2 && n < 3).toBe(true);
    }
    expect(rng.pick([])).toBeUndefined();
  });
});

it("normalizes headings into [-π, π)", () => {
  expect(normalizeHeading(Math.PI)).toBeCloseTo(-Math.PI);
  expect(normalizeHeading(3 * Math.PI + 0.5)).toBeCloseTo(-Math.PI + 0.5);
  expect(normalizeHeading(-0.25)).toBeCloseTo(-0.25);
});
