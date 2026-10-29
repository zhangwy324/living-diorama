import type { SimulationSnapshot } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { DebugStats } from "./debug-stats";

const fakeDocument = {
  createElement: () => ({ style: {}, hidden: false, textContent: "" }),
} as unknown as Document;

const snapshot = (tick: number): SimulationSnapshot => ({
  tick,
  timeMs: tick * 100,
  paused: false,
  timeOfDay: 720,
  creatures: [],
});

const rate = (stats: DebugStats) => /tick \d+ · ([\d.]+)\/s/.exec(stats.element.textContent)?.[1];

describe("DebugStats.reset", () => {
  it("never reads a tick jump after a restore as a rate", () => {
    const stats = new DebugStats(fakeDocument);
    stats.snapshot(snapshot(0));
    stats.frame(0, true);
    stats.snapshot(snapshot(10));
    stats.frame(1000, true);
    expect(rate(stats)).toBe("10.0");

    // A frame between the reset and the restored world's first snapshot changes nothing.
    stats.reset();
    stats.frame(1500, true);
    stats.snapshot(snapshot(432_000));
    stats.frame(2000, true); // starts a new window at the restored tick
    stats.snapshot(snapshot(432_010));
    stats.frame(3000, true);
    expect(rate(stats)).toBe("10.0");
  });
});
