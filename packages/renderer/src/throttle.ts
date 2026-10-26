// Render throttling (ADR 0007 §11): the display rate while someone is looking or the camera
// moves, about 30 fps otherwise. Hidden pages are not rendered at all; the view stops its loop.

export const IDLE_FPS = 30;
/** Frame timestamps jitter (some browsers round them to 10 ms), so frames this early still count. */
const SLACK_MS = 1;

export class FrameThrottle {
  #next = -Infinity;

  constructor(readonly idleIntervalMs = 1000 / IDLE_FPS) {}

  /** Whether to render the frame at `now`. At full rate every frame is rendered. */
  due(now: number, fullRate: boolean): boolean {
    if (!fullRate && now < this.#next - SLACK_MS) return false;
    // Step the schedule rather than restarting it at `now`, so rounding does not lower the
    // average rate; after a long gap it restarts instead of rendering a burst. Full-rate frames
    // come faster than the idle interval, so stepping on them would push the schedule ahead of
    // `now` and stall idle frames after the pointer leaves; they restart it instead.
    const behind = now - this.#next >= this.idleIntervalMs;
    this.#next = (fullRate || behind ? now : this.#next) + this.idleIntervalMs;
    return true;
  }
}
