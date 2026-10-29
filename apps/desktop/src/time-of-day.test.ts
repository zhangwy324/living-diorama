import { describe, expect, it, vi } from "vitest";
import { timeDevHook } from "./dev-time";
import {
  CHECK_MS,
  JUMP_MS,
  timeOfDayFeed,
  type TimeOfDayFeed,
  type WallClock,
} from "./time-of-day";

/**
 * A wall clock whose minutes are its milliseconds / 60 000, whose timers fire in `pass` and which
 * passes snapshots to a feed in `snapshots`.
 */
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
    /** Moves the clock on by `by` with a snapshot every `every` ms and no timer firing. */
    snapshots(feed: TimeOfDayFeed, by: number, every: number) {
      for (let left = by; left > 0; left -= every) {
        ms += Math.min(every, left);
        feed.snapshot(false);
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

  it("sends once each time the minute changes, on the timer while no snapshots come", () => {
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

describe("time of day feed on snapshots", () => {
  /** The worker's 10 Hz snapshots. */
  const TICK_MS = 100;

  it("follows the clock on snapshots alone, within one check of each minute", () => {
    const fake = fakeClock(12 * 60);
    const sentAt: number[] = [];
    const feed = timeOfDayFeed(() => sentAt.push(fake.clock.now()), fake.clock);
    fake.sleep(2_345);
    feed.start();
    // The strip is hidden: the throttled timer never fires, but snapshots keep coming.
    fake.snapshots(feed, 10 * 60_000, TICK_MS);
    expect(sentAt).toHaveLength(10);
    sentAt.forEach((at, i) => {
      const minute = (12 * 60 + i + 1) * 60_000;
      expect(at).toBeGreaterThanOrEqual(minute);
      expect(at - minute).toBeLessThanOrEqual(CHECK_MS);
    });
  });

  it("reads the clock at most once per check interval", () => {
    const fake = fakeClock(12 * 60);
    let reads = 0;
    const minutesAt = fake.clock.minutesAt;
    const feed = timeOfDayFeed(vi.fn(), {
      ...fake.clock,
      minutesAt: (ms) => (reads++, minutesAt(ms)),
    });
    feed.start();
    reads = 0;
    fake.snapshots(feed, 60_000, TICK_MS);
    // 600 snapshots, one check every 5 s, and one more read for each of the minute's sends.
    expect(reads).toBe(60_000 / CHECK_MS + 1);
  });

  it("counts no late timer or snapshot as a jump", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    const feed = timeOfDayFeed(send, fake.clock);
    feed.start();
    // Snapshots come 10 s apart, then a throttled timer fires 40 s late: still 12:00.
    fake.snapshots(feed, 40_000, 10_000);
    fake.pass(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends at once when snapshots are far apart or the clock went back", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    const feed = timeOfDayFeed(send, fake.clock);
    feed.start();
    feed.snapshot(false);
    // A stall of over JUMP_MS resends even within the same minute and the same check interval.
    fake.sleep(JUMP_MS + 1);
    feed.snapshot(false);
    expect(send.mock.calls).toEqual([[12 * 60]]);
    // The OS slept for eight hours.
    fake.sleep(8 * 3_600_000);
    feed.snapshot(false);
    expect(send.mock.calls.at(-1)).toEqual([20 * 60]);
    // The clock was set back an hour: sent at once, and checks carry on from there.
    fake.sleep(-3_600_000);
    feed.snapshot(false);
    expect(send.mock.calls.at(-1)).toEqual([19 * 60]);
    fake.snapshots(feed, 60_000, TICK_MS);
    expect(send.mock.calls.at(-1)).toEqual([19 * 60 + 1]);
  });

  it("does nothing on snapshots before start or after stop", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    const feed = timeOfDayFeed(send, fake.clock);
    fake.sleep(3_600_000);
    feed.snapshot(false);
    feed.start();
    feed.stop();
    fake.sleep(3_600_000);
    feed.snapshot(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends each minute once while paused, the paused snapshot it brings counting as no jump", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    // The paused worker answers each new time with a snapshot.
    const feed = timeOfDayFeed(() => (send(), feed.snapshot(true)), fake.clock);
    feed.start();
    feed.snapshot(true);
    fake.pass(10 * 60_000);
    expect(send).toHaveBeenCalledTimes(10);
  });

  it("counts no jump across the snapshot that resumes, then counts the next one again", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    const feed = timeOfDayFeed(send, fake.clock);
    feed.start();
    feed.snapshot(true);
    // Paused for an hour with no timer firing (hidden), then resumed: the resync sends the time.
    fake.sleep(3_600_000);
    feed.resync();
    feed.snapshot(true);
    feed.snapshot(false);
    expect(send.mock.calls).toEqual([[13 * 60]]);
    // Running again: the OS slept for an hour.
    fake.snapshots(feed, 1000, TICK_MS);
    fake.sleep(3_600_000);
    feed.snapshot(false);
    expect(send.mock.calls).toEqual([[13 * 60], [14 * 60]]);
  });
});

describe("time dev hook", () => {
  it("fixes the time, follows the clock and sets the speed", () => {
    const client = { fixTimeOfDay: vi.fn(), setSpeed: vi.fn() };
    const hook = timeDevHook(client);
    hook.set("21:30");
    hook.follow();
    hook.speed(20);
    hook.speed(100);
    expect(client.fixTimeOfDay.mock.calls).toEqual([[21 * 60 + 30], [undefined]]);
    expect(client.setSpeed.mock.calls).toEqual([[20], [100]]);
  });

  it("refuses values the worker would reject", () => {
    const client = { fixTimeOfDay: vi.fn(), setSpeed: vi.fn() };
    const hook = timeDevHook(client);
    expect(() => hook.set("25:00")).toThrow(/21:30/);
    expect(() => hook.speed(0)).toThrow(/above 0/);
    expect(() => hook.speed(Number.NaN)).toThrow(/above 0/);
    expect(() => hook.speed(101)).toThrow(/at most 100/);
    expect(() => hook.speed(Number.POSITIVE_INFINITY)).toThrow(/at most 100/);
    expect(client.fixTimeOfDay).not.toHaveBeenCalled();
    expect(client.setSpeed).not.toHaveBeenCalled();
  });
});

describe("time of day feed after stop", () => {
  it("stays stopped: a late start adds no timer or listener", () => {
    const fake = fakeClock(12 * 60);
    const send = vi.fn();
    const feed = timeOfDayFeed(send, fake.clock);
    feed.stop();
    feed.start();
    expect(fake.listeners).toBe(0);
    feed.resync();
    feed.fix(6 * 60);
    expect(send).not.toHaveBeenCalled();
  });
});
