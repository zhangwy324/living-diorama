import { SHORT_GAP_MS } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { lostTimeWatch, type LostTimeWatch } from "./lost-time";

const TICK_MS = 100;
const HOUR = 3_600_000;

/** A worker as the watch sees it: its simulation time and wall clock, and the watch's answers. */
function worker(watch: LostTimeWatch = lostTimeWatch()) {
  let timeMs = 0;
  let wallMs = Date.UTC(2026, 9, 29, 21);
  let paused = false;
  const lost: number[] = [];
  const send = () => lost.push(watch.snapshot({ timeMs, paused }, wallMs));
  return {
    watch,
    lost,
    /** Runs `ticks` ticks at `speed`, one snapshot each, as the worker sends them. */
    run(ticks: number, speed = 1) {
      for (let k = 0; k < ticks; k++) {
        timeMs += TICK_MS;
        wallMs += TICK_MS / speed;
        send();
      }
    },
    /** Wall-clock time passes and no tick runs, as while the OS sleeps or the worker stalls. */
    sleep: (ms: number) => (wallMs += ms),
    /** The worker sends a snapshot without a tick, as on applying a command. */
    send,
    pause(value: boolean) {
      paused = value;
      send();
    },
    /** The world's time jumps without the wall clock moving, as on a restore or catch-up. */
    jump: (ms: number) => (timeMs += ms),
  };
}

const gaps = (lost: number[]) => lost.filter((ms) => ms > 0);

describe("lost time watch", () => {
  it("finds no lost time while the worker ticks on time, at any speed", () => {
    const w = worker();
    w.run(600);
    w.watch.setSpeed(100);
    w.run(600, 100);
    expect(gaps(w.lost)).toEqual([]);
  });

  it("tells the wall-clock time an OS sleep took from the world, less the ticks run", () => {
    const w = worker();
    w.run(10);
    w.sleep(8 * HOUR);
    // The clock's limit releases ten ticks at once on waking.
    w.run(10, Number.POSITIVE_INFINITY);
    w.run(10);
    expect(gaps(w.lost)).toEqual([8 * HOUR - TICK_MS]);
  });

  it("ignores a gap under 2 minutes, and a clock set back", () => {
    const w = worker();
    w.run(1);
    w.sleep(SHORT_GAP_MS - TICK_MS - 1);
    w.run(1);
    w.sleep(-HOUR);
    w.run(1);
    expect(gaps(w.lost)).toEqual([]);
    w.sleep(SHORT_GAP_MS);
    w.run(1);
    expect(gaps(w.lost)).toEqual([SHORT_GAP_MS]);
  });

  it("finds nothing lost when the main thread stalls, however late snapshots arrive", () => {
    // The worker kept ticking for five minutes while the main thread read nothing; the snapshots
    // then arrive all at once, each stamped when it was sent.
    const watch = lostTimeWatch();
    const queued: Parameters<LostTimeWatch["snapshot"]>[] = [];
    worker({ ...watch, snapshot: (...sent) => (queued.push(sent), 0) }).run(5 * 60 * 10);
    expect(gaps(queued.map((sent) => watch.snapshot(...sent)))).toEqual([]);
  });

  it("finds nothing lost while paused, nor across the snapshot that resumes", () => {
    const w = worker();
    w.run(10);
    w.pause(true);
    w.sleep(8 * HOUR);
    // A new time of day applied while paused sends a snapshot, as does resuming.
    w.send();
    w.sleep(HOUR);
    w.pause(false);
    w.run(10);
    expect(gaps(w.lost)).toEqual([]);
  });

  it("counts time at the speed the world runs at", () => {
    const w = worker();
    w.watch.setSpeed(0.001);
    // At a thousandth of real time, a tick takes 100 s of wall-clock time.
    w.run(5, 0.001);
    expect(gaps(w.lost)).toEqual([]);
    w.sleep(HOUR);
    w.run(1, 0.001);
    expect(gaps(w.lost)).toEqual([HOUR]);
  });

  it("starts afresh when reset, as after a restore took the world back in time", () => {
    const w = worker();
    w.run(10);
    w.jump(-8 * HOUR);
    w.run(1);
    // Without a reset, the older world looks as if it lost the time it went back.
    expect(gaps(w.lost)).toEqual([8 * HOUR]);
    w.jump(-8 * HOUR);
    w.watch.reset();
    w.run(10);
    expect(gaps(w.lost)).toEqual([8 * HOUR]);
  });
});
