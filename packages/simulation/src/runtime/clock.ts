export interface ClockOptions {
  tickRateHz: number;
  /**
   * Most ticks one `advance` may release at speed 1; time beyond that is dropped, e.g. after
   * sleep. A faster speed raises the limit in proportion (see `FixedClock.catchUpLimit`).
   */
  maxCatchUpTicks?: number;
}

/**
 * The fastest speed multiplier. Speeds above 1 are a development aid (the dev console's time
 * hook), and the catch-up limit grows with the speed, so this bounds a tick burst after a sleep.
 */
export const MAX_SPEED = 100;

/** Whether `multiplier` is a speed the clock accepts: above 0 and at most `MAX_SPEED`. */
export function isValidSpeed(multiplier: number): boolean {
  return Number.isFinite(multiplier) && multiplier > 0 && multiplier <= MAX_SPEED;
}

/**
 * Turns wall-clock time into fixed simulation ticks (roadmap M3 task 1). The host feeds the time
 * in; the simulation never reads a clock itself. The clock only says how many ticks are due: the
 * tick counter belongs to the simulation state, so it is saved and replayed with it.
 */
export class FixedClock {
  readonly tickMs: number;
  readonly maxCatchUpTicks: number;
  #accumulatorMs = 0;
  #lastWallMs: number | undefined;
  #paused = false;
  #speed = 1;

  constructor({ tickRateHz, maxCatchUpTicks = 10 }: ClockOptions) {
    if (!(Number.isFinite(tickRateHz) && tickRateHz > 0)) {
      throw new RangeError(`Tick rate must be a positive number, got ${tickRateHz}`);
    }
    if (!(Number.isInteger(maxCatchUpTicks) && maxCatchUpTicks >= 1)) {
      throw new RangeError(`maxCatchUpTicks must be a positive integer, got ${maxCatchUpTicks}`);
    }
    this.tickMs = 1000 / tickRateHz;
    this.maxCatchUpTicks = maxCatchUpTicks;
  }

  get paused(): boolean {
    return this.#paused;
  }

  get speed(): number {
    return this.#speed;
  }

  pause(): void {
    this.#paused = true;
    this.#accumulatorMs = 0;
  }

  /** The first `advance` after resuming only sets the baseline, so paused time never ticks. */
  resume(): void {
    this.#paused = false;
    this.#lastWallMs = undefined;
  }

  /** Scales how much simulation time passes per wall-clock millisecond, up to `MAX_SPEED`. */
  setSpeed(multiplier: number): void {
    if (!isValidSpeed(multiplier)) {
      throw new RangeError(
        `Speed multiplier must be above 0 and at most ${MAX_SPEED}, got ${multiplier}`,
      );
    }
    this.#speed = multiplier;
  }

  /**
   * Most ticks the next `advance` may release: `maxCatchUpTicks` at speed 1 or slower, raised in
   * proportion to a faster speed. The limit so covers the same span of wall-clock time at any
   * speed above 1 (one second at the defaults), so a dev speed of 60 isn't held to about 10×
   * (issue #100), while speed 1 still drops a long sleep as before.
   */
  get catchUpLimit(): number {
    if (this.#speed <= 1) return this.maxCatchUpTicks;
    // Rounded first, so float error doesn't push e.g. 10 × 1.1 (11.000000000000002) up to 12.
    return Math.ceil(Number((this.maxCatchUpTicks * this.#speed).toPrecision(12)));
  }

  /** Feeds the current monotonic wall-clock time in milliseconds; returns the ticks now due. */
  advance(wallMs: number): number {
    const last = this.#lastWallMs;
    this.#lastWallMs = wallMs;
    if (last === undefined || this.#paused) return 0;
    this.#accumulatorMs += Math.max(0, wallMs - last) * this.#speed;
    const due = Math.floor(this.#accumulatorMs / this.tickMs);
    const limit = this.catchUpLimit;
    if (due > limit) {
      this.#accumulatorMs = 0;
      return limit;
    }
    this.#accumulatorMs -= due * this.tickMs;
    return due;
  }
}
