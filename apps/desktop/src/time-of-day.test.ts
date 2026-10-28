import { describe, expect, it, vi } from "vitest";
import { timeDevHook } from "./dev-time";
import { CHECK_MS, timeOfDayFeed, type WallClock } from "./time-of-day";

/** A wall clock whose minutes are its milliseconds / 60 000 and whose timers fire in `pass`. */
function fakeClock(startMinutes: number) {
  let ms = startMinutes * 60_000;
  let checks: (() => void)[] = [];
  let visible: (() => void)[] = [];
  const clock: WallClock = {
    now: () => ms,
    minutesAt: (at) => Math.floor(at / 60_000) % (24 * 60),
    every: (_, callback) => {
      checks.push(callback);
      return () => (checks = checks.filter((c) => c !== callback));
    },
    onVisible: (callback) => {
      visible.push(callback);
      return () => (visible = visible.filter((c) => c !== callback));
    },
  };
  return {
    clock,
    /** Moves the clock on by `ms`, firing each check due on the way. */
    pass(by: number) {
      for (let left = by; left > 0; left -= CHECK_MS) {
        ms += Math.min(CHECK_MS, left);
        for (const check of checks) check();
      }
    },
    /** Moves the clock on without firing checks, as while the OS sleeps. */
    sleep: (by: number) => (ms += by),
    becomeVisible: () => visible.forEach((c) => c()),
    get listeners() {
      return checks.length + visible.length;
    },
  };
}

describe("time of day feed", () => {
  it("starts at the current time and sends nothing until started", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    const feed = timeOfDayFeed(send, fake.clock);
    expect(feed.minutes).toBe(12 * 60);
    fake.pass(120_000);
    feed.resync();
    expect(send).not.toHaveBeenCalled();
  });

  it("sends once each time the minute changes", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    timeOfDayFeed(send, fake.clock).start();
    fake.pass(55_000);
    expect(send).not.toHaveBeenCalled();
    fake.pass(3 * 60_000);
    expect(send.mock.calls).toEqual([[12 * 60 + 1], [12 * 60 + 2], [12 * 60 + 3]]);
  });

  it("sends on becoming visible, on resync and after a wall-clock jump", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    const feed = timeOfDayFeed(send, fake.clock);
    feed.start();
    fake.becomeVisible();
    feed.resync();
    expect(send.mock.calls).toEqual([[12 * 60], [12 * 60]]);
    send.mockClear();
    // The OS slept for eight hours; the first check after waking sends the new time.
    fake.sleep(8 * 3_600_000);
    fake.pass(CHECK_MS);
    expect(send.mock.calls).toEqual([[20 * 60]]);
  });

  it("holds a fixed time until it follows the clock again, then stops cleanly", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    const feed = timeOfDayFeed(send, fake.clock);
    feed.start();
    feed.fix(21 * 60 + 30);
    fake.pass(5 * 60_000);
    expect(feed.minutes).toBe(21 * 60 + 30);
    expect(send.mock.calls).toEqual([[21 * 60 + 30]]);
    feed.fix(undefined);
    expect(send.mock.calls.at(-1)).toEqual([12 * 60 + 5]);
    feed.stop();
    expect(fake.listeners).toBe(0);
    fake.pass(5 * 60_000);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("time dev hook", () => {
  it("fixes the time, follows the clock and sets the speed", () => {
    const client = { fixTimeOfDay: vi.fn(), setSpeed: vi.fn() };
    const hook = timeDevHook(client);
    hook.set("21:30");
    hook.follow();
    hook.speed(20);
    expect(client.fixTimeOfDay.mock.calls).toEqual([[21 * 60 + 30], [undefined]]);
    expect(client.setSpeed.mock.calls).toEqual([[20]]);
  });

  it("refuses values the worker would reject", () => {
    const client = { fixTimeOfDay: vi.fn(), setSpeed: vi.fn() };
    const hook = timeDevHook(client);
    expect(() => hook.set("25:00")).toThrow(/21:30/);
    expect(() => hook.speed(0)).toThrow(/positive/);
    expect(() => hook.speed(Number.NaN)).toThrow(/positive/);
    expect(client.fixTimeOfDay).not.toHaveBeenCalled();
    expect(client.setSpeed).not.toHaveBeenCalled();
  });
});
