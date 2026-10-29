// Feeds the local time of day to the simulation (ADR 0018 §5): the worker never reads a clock,
// so the main thread sends it at init, whenever the minute changes, and on resume.
//
// The clock is checked on the worker's snapshots (issue #127). WebView2 throttles timers on a
// hidden page, so a timer alone let the time of day lag by a minute or more while the strip was
// hidden; snapshot messages are not throttled (ADR 0019 §4, issue #117). A slow timer remains as a
// backstop for when no snapshots come, i.e. while paused, so the paused world's light still follows
// the clock. A wall-clock jump, such as an OS sleep, is told from consecutive snapshots far apart
// in wall time only, never from a check that ran late. Paused snapshots, which come only when a
// command is applied, and the first one after them, are never counted as a jump: the timer and
// the resync on resume cover the paused world. Time the world lost is told apart in `lost-time`.

/** The wall clock and page the feed watches; injectable for tests. */
export interface WallClock {
  /** Wall-clock time in milliseconds, e.g. `Date.now`; jumps when the OS wakes from sleep. */
  now(): number;
  /** Local minutes since midnight at `now`. */
  minutesAt(ms: number): number;
  /** Calls `callback` every `ms` until the returned function is called. */
  every(ms: number, callback: () => void): () => void;
  /** Calls `callback` whenever the page becomes visible, until the returned function is called. */
  onVisible(callback: () => void): () => void;
}

export const systemWallClock: WallClock = {
  now: () => Date.now(),
  minutesAt: (ms) => {
    const date = new Date(ms);
    return date.getHours() * 60 + date.getMinutes();
  },
  every: (ms, callback) => {
    const id = setInterval(callback, ms);
    return () => clearInterval(id);
  },
  onVisible: (callback) => {
    const onChange = () => {
      if (document.visibilityState === "visible") callback();
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  },
};

/** The clock is checked for a new minute at most this often, in wall-clock time. */
export const CHECK_MS = 5_000;
/**
 * Consecutive snapshots this far apart in wall time mean the clock jumped, e.g. the OS slept. The
 * worker sends them at the tick rate (10 Hz), also while the strip is hidden.
 */
export const JUMP_MS = 3 * CHECK_MS;

export interface TimeOfDayFeed {
  /** The time of day to start the world at. */
  readonly minutes: number;
  /**
   * Starts sending: whenever the minute changes, on a wall-clock jump and when visible again.
   * Does nothing once stopped.
   */
  start(): void;
  /**
   * A snapshot arrived, of a paused world if `paused`: checks the clock, at most every
   * `CHECK_MS`, or at once after a jump, a wall-clock gap since the previous snapshot of over
   * `JUMP_MS` or below 0. A paused snapshot, or the first after one, checks only as the timer does.
   */
  snapshot(paused: boolean): void;
  /** Sends the time of day now, e.g. on unpausing. */
  resync(): void;
  /**
   * Fixes the time of day at `minutes`, or follows the real clock again when undefined. Sends
   * the new time at once.
   */
  fix(minutes: number | undefined): void;
  /** Stops sending for good. */
  stop(): void;
}

/** A feed of the local time of day into `send`. Sends nothing until `start`. */
export function timeOfDayFeed(
  send: (minutes: number) => void,
  clock: WallClock = systemWallClock,
): TimeOfDayFeed {
  let fixed: number | undefined;
  let started = false;
  let stopped = false;
  let stops: (() => void)[] = [];
  let lastCheck = 0;
  let lastSnapshot = 0;
  let afterPause = false;
  let sent: number | undefined;
  const current = () => fixed ?? clock.minutesAt(clock.now());
  const resync = () => {
    if (!started) return;
    sent = current();
    send(sent);
  };
  /** Sends the time if the minute changed; throttled unless `jumped`. */
  const check = (now: number, jumped: boolean) => {
    // A clock set back is never throttled, or no check would run until it caught up again.
    if (!jumped && now >= lastCheck && now - lastCheck < CHECK_MS) return;
    lastCheck = now;
    if (jumped || current() !== sent) resync();
  };
  return {
    get minutes() {
      return current();
    },
    start() {
      if (started || stopped) return;
      started = true;
      sent = current();
      lastCheck = lastSnapshot = clock.now();
      stops = [clock.every(CHECK_MS, () => check(clock.now(), false)), clock.onVisible(resync)];
    },
    snapshot(paused) {
      if (!started) return;
      const now = clock.now();
      const gap = now - lastSnapshot;
      lastSnapshot = now;
      const baseline = paused || afterPause;
      afterPause = paused;
      check(now, !baseline && (gap > JUMP_MS || gap < 0));
    },
    resync,
    fix(minutes) {
      fixed = minutes;
      resync();
    },
    stop() {
      started = false;
      stopped = true;
      for (const stop of stops) stop();
      stops = [];
    },
  };
}
