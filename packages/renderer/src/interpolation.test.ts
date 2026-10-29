import type { CreatureSnapshot, SimulationSnapshot } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { SnapshotInterpolator } from "./interpolation";

const at = (x: number): CreatureSnapshot => ({
  id: "a",
  speciesId: "test:critter",
  position: { regionId: "r", x, z: 0 },
  world: { x, y: 0, z: 0 },
  heading: 0,
  animation: undefined,
  submersion: 0,
  cues: [],
});

const snapshot = (tick: number, x: number): SimulationSnapshot => ({
  tick,
  timeMs: tick * 100,
  paused: false,
  timeOfDay: 720,
  creatures: [at(x)],
});

describe("SnapshotInterpolator.reset", () => {
  it("takes the next snapshot as it is, even of an older tick", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(500, 0), 0);
    interpolator.push(snapshot(501, 1), 100);
    // Without a reset an older tick is ignored.
    interpolator.push(snapshot(40, 2), 200);
    expect(interpolator.sample(300)[0]!.world.x).toBe(1);

    interpolator.reset();
    // Until the next snapshot the newest one is still drawn.
    expect(interpolator.sample(300)[0]!.world.x).toBe(1);
    interpolator.push(snapshot(40, 2), 300);
    // Drawn as it is, not blended from the replaced world.
    expect(interpolator.sample(310)[0]!.world.x).toBe(2);
    interpolator.push(snapshot(41, 3), 400);
    expect(interpolator.sample(450)[0]!.world.x).toBeCloseTo(2.5);
  });

  it("doesn't blend across a tick jump ahead either", () => {
    const interpolator = new SnapshotInterpolator(100);
    interpolator.push(snapshot(1, 0), 0);
    interpolator.reset();
    interpolator.push(snapshot(400_000, 1), 100);
    expect(interpolator.sample(150)[0]!.world.x).toBe(1);
  });
});
