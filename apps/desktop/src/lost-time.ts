import { SHORT_GAP_MS, type SimulationSnapshot } from "@living-diorama/simulation";

// Tells when the running world lost wall-clock time, e.g. while the OS slept with the app open,
// so it can be caught up as after a relaunch (issue #113, ADR 0019).
//
// Lost time is the wall-clock time between two consecutive snapshots that the worker did not
// simulate: their wall-clock gap less the simulation time between them, at the speed. Both come
// from the worker, which stamps each snapshot with `Date.now()` as it sends it, so a main thread
// that stalls and reads the snapshots late loses nothing. `Date.now()` moves on while the OS
// sleeps; whether the worker's `performance.now()` does is not relied on. A paused world loses no
// time: paused snapshots, and the first one after them, only set the baseline.

export interface LostTimeWatch {
  /**
   * A snapshot arrived, sent at `wallMs`. Returns the wall-clock time the world lost since the
   * previous snapshot, in milliseconds, when it is a gap to catch up (`SHORT_GAP_MS` or more);
   * otherwise 0, also when the clock went backwards.
   */
  snapshot(snapshot: Pick<SimulationSnapshot, "timeMs" | "paused">, wallMs: number): number;
  /** The speed multiplier the worker now runs at. */
  setSpeed(multiplier: number): void;
  /** The world's time jumped (a restore or catch-up): the next snapshot only sets the baseline. */
  reset(): void;
}

export function lostTimeWatch(): LostTimeWatch {
  let speed = 1;
  let last: { timeMs: number; wallMs: number } | undefined;
  return {
    snapshot({ timeMs, paused }, wallMs) {
      const previous = last;
      last = paused ? undefined : { timeMs, wallMs };
      if (!previous || !last) return 0;
      const lost = wallMs - previous.wallMs - (timeMs - previous.timeMs) / speed;
      return lost >= SHORT_GAP_MS ? lost : 0;
    },
    setSpeed(multiplier) {
      speed = multiplier;
    },
    reset() {
      last = undefined;
    },
  };
}
