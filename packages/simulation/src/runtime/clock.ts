export interface ClockOptions {
  tickRateHz: number;
  /**
   * Most ticks one `advance` may release at speed 1; time beyond that is dropped, e.g. after
   * sleep. A faster speed raises the limit in proportion (see `FixedClock.catchUpLimit`).
   */
  maxCatchUpTicks?: number;
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

  /** Scales how much simulation time passes per wall-clock millisecond. */
  setSpeed(multiplier: number): void {
    if (!(Number.isFinite(multiplier) && multiplier > 0)) {
      throw new RangeError(`Speed multiplier must be a positive number, got ${multiplier}`);
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
    return this.#speed > 1 ? Math.ceil(this.maxCatchUpTicks * this.#speed) : this.maxCatchUpTicks;
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
