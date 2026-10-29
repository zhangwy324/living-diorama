import type { SimulationSnapshot } from "@living-diorama/simulation";

// The FPS and tick stats overlay (roadmap M4 task 10): a small text panel in the view's corner.

const WINDOW_MS = 1000;

export interface StatsSample {
  fps: number;
  fullRate: boolean;
  tick: number;
  ticksPerSecond: number;
  creatures: number;
  walking: number;
}

export function formatStats(s: StatsSample): string {
  return [
    `${Math.round(s.fps)} fps${s.fullRate ? "" : " (idle)"}`,
    `tick ${s.tick} · ${s.ticksPerSecond.toFixed(1)}/s`,
    `${s.creatures} creatures · ${s.walking} walking`,
  ].join("\n");
}

/** Counts rendered frames and received ticks over one-second windows. */
export class DebugStats {
  readonly element: HTMLDivElement;
  #windowStart = -Infinity;
  #frames = 0;
  #tickAtStart = 0;
  #snapshot: SimulationSnapshot | undefined;
  #restarting = false;

  constructor(document: Document) {
    this.element = document.createElement("div");
    Object.assign(this.element.style, {
      position: "absolute",
      top: "6px",
      left: "6px",
      padding: "3px 6px",
      font: "11px/1.35 ui-monospace, monospace",
      whiteSpace: "pre",
      color: "#f4f7ee",
      background: "rgb(0 0 0 / 55%)",
      borderRadius: "4px",
      pointerEvents: "none",
    });
    this.element.hidden = true;
  }

  /** The newest snapshot; after `reset`, the first one starts a new window. */
  snapshot(snapshot: SimulationSnapshot): void {
    this.#snapshot = snapshot;
    if (!this.#restarting) return;
    this.#restarting = false;
    this.#windowStart = -Infinity;
    this.#frames = 0;
  }

  /**
   * Starts a new window at the next frame, so a jump in ticks (a restored save, a catch-up) never
   * reads as a rate.
   */
  reset(): void {
    this.#restarting = true;
  }

  /** Call once per rendered frame. Refreshes the text once per window. */
  frame(now: number, fullRate: boolean): void {
    this.#frames++;
    const tick = this.#snapshot?.tick ?? 0;
    const elapsed = now - this.#windowStart;
    if (elapsed < WINDOW_MS) return;
    if (Number.isFinite(elapsed)) {
      const creatures = this.#snapshot?.creatures ?? [];
      this.element.textContent = formatStats({
        fps: (this.#frames * 1000) / elapsed,
        fullRate,
        tick,
        ticksPerSecond: ((tick - this.#tickAtStart) * 1000) / elapsed,
        creatures: creatures.length,
        walking: creatures.filter((c) => c.route).length,
      });
    }
    this.#windowStart = now;
    this.#frames = 0;
    this.#tickAtStart = tick;
  }
}
