// Feeds the local time of day to the simulation (ADR 0018 §5): the worker never reads a clock,
// so the main thread sends it at init, whenever the minute changes, and on resume.

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

/** How often the clock is checked for a new minute or a jump. */
export const CHECK_MS = 5_000;
/** A check this much later than due means the clock jumped, e.g. the OS slept. */
const JUMP_MS = 3 * CHECK_MS;

export interface TimeOfDayFeed {
  /** The time of day to start the world at. */
  readonly minutes: number;
  /** Starts sending: whenever the minute changes, on a wall-clock jump and when visible again. */
  start(): void;
  /** Sends the time of day now, e.g. on unpausing. */
  resync(): void;
  /**
   * Fixes the time of day at `minutes`, or follows the real clock again when undefined. Sends
   * the new time at once.
   */
  fix(minutes: number | undefined): void;
  stop(): void;
}

/** A feed of the local time of day into `send`. Sends nothing until `start`. */
export function timeOfDayFeed(
  send: (minutes: number) => void,
  clock: WallClock = systemWallClock,
): TimeOfDayFeed {
  let fixed: number | undefined;
  let started = false;
  let stops: (() => void)[] = [];
  let lastCheck = clock.now();
  let sent: number | undefined;
  const current = () => fixed ?? clock.minutesAt(clock.now());
  const resync = () => {
    if (!started) return;
    sent = current();
    send(sent);
  };
  const check = () => {
    const now = clock.now();
    const jumped = now - lastCheck > JUMP_MS || now < lastCheck;
    lastCheck = now;
    if (jumped || current() !== sent) resync();
  };
  return {
    get minutes() {
      return current();
    },
    start() {
      if (started) return;
      started = true;
      sent = current();
      lastCheck = clock.now();
      stops = [clock.every(CHECK_MS, check), clock.onVisible(resync)];
    },
    resync,
    fix(minutes) {
      fixed = minutes;
      resync();
    },
    stop() {
      started = false;
      for (const stop of stops) stop();
      stops = [];
    },
  };
}
