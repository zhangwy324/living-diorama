import type { SceneData } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { defaultFraming } from "./index";

const scene = {
  bounds: { min: { x: -32, y: -3, z: -20 }, max: { x: 32, y: 10, z: 20 } },
} as SceneData;

describe("defaultFraming", () => {
  it("narrows the vertical field of view for a strip so the full width stays in view", () => {
    const strip = defaultFraming(scene, 1920 / 220);
    const expanded = defaultFraming(scene, 16 / 9);
    expect(strip.fov).toBeLessThan(6);
    expect(expanded.fov).toBeGreaterThan(20);
    // Both look at the same point, from the south (+Z) and above.
    expect(strip.target.equals(expanded.target)).toBe(true);
    expect(strip.position.z).toBeGreaterThan(strip.target.z);
    expect(strip.position.y).toBeGreaterThan(strip.target.y);
  });
});
