import type { Cue, CreatureSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CreatureBodies } from "./creatures";
import {
  BUBBLE_PX,
  RING_STEPS,
  SNAP_SECONDS,
  ScreenScale,
  Z_COUNT,
  bodyMotion,
  bubbleBob,
  bubblePixels,
  cuePhase,
  cuePixels,
  restingMotion,
  restingZ,
  ringPixels,
  ringStep,
  stepCueWeights,
  zMotion,
  zPixels,
  type CueWeights,
} from "./cues";
import { SceneLayer } from "./layers";

const none = (): CueWeights => ({ eating: 0, sleeping: 0, hungry: 0 });
/** A frame whose animation and real clocks agree. */
const at = (t: number) => ({ time: t, realTime: t });
const times = Array.from({ length: 400 }, (_, k) => k * 0.037);

describe("cue weights", () => {
  it("fade in and out over time instead of popping, within 0–1", () => {
    const weights = none();
    stepCueWeights(weights, ["eating"], 0.1);
    expect(weights.eating).toBeGreaterThan(0);
    expect(weights.eating).toBeLessThan(1);
    stepCueWeights(weights, ["eating"], 10);
    expect(weights.eating).toBe(1);
    stepCueWeights(weights, [], 0.1);
    expect(weights.eating).toBeGreaterThan(0);
    stepCueWeights(weights, [], 10);
    expect(weights).toEqual(none());
  });

  it("snaps to the cues after a long gap, e.g. a hidden page", () => {
    const weights = { eating: 1, sleeping: 0, hungry: 0.3 };
    stepCueWeights(weights, ["sleeping"], SNAP_SECONDS + 0.5);
    expect(weights).toEqual({ eating: 0, sleeping: 1, hungry: 0 });
  });

  it("ignores a negative or non-finite step", () => {
    const weights = { eating: 0.5, sleeping: 0.5, hungry: 0.5 };
    stepCueWeights(weights, [], -1);
    stepCueWeights(weights, [], Number.NaN);
    expect(weights).toEqual({ eating: 0.5, sleeping: 0.5, hungry: 0.5 });
  });
});

describe("body motion", () => {
  it("leaves the body as it is without cues", () => {
    for (const time of times) {
      expect(bodyMotion(none(), time, 0.3, restingMotion())).toEqual(restingMotion());
    }
  });

  it("bobs while eating, never sinking, and stays bounded", () => {
    const eating = { eating: 1, sleeping: 0, hungry: 0 };
    const lifts = times.map((time) => bodyMotion(eating, time, 0.2, restingMotion()));
    for (const { lift, pitch, scaleY } of lifts) {
      expect(lift).toBeGreaterThanOrEqual(0);
      expect(lift).toBeLessThanOrEqual(0.04);
      expect(pitch).toBeGreaterThanOrEqual(0);
      expect(pitch).toBeLessThanOrEqual(0.12);
      expect(scaleY).toBe(1);
    }
    expect(Math.max(...lifts.map((m) => m.lift))).toBeGreaterThan(0.035);
  });

  it("lowers a sleeping body by about 10% and breathes slowly", () => {
    const sleeping = { eating: 0, sleeping: 1, hungry: 0 };
    const heights = times.map((time) => bodyMotion(sleeping, time, 0, restingMotion()).scaleY);
    expect(Math.max(...heights)).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0.875 - 1e-9);
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.02);
    expect(bodyMotion(sleeping, 1, 0, restingMotion()).lift).toBe(0);
  });

  it("is a pure function of its inputs", () => {
    const weights = { eating: 0.4, sleeping: 0.7, hungry: 1 };
    expect(bodyMotion(weights, 2.5, 0.1, restingMotion())).toEqual(
      bodyMotion({ ...weights }, 2.5, 0.1, restingMotion()),
    );
    expect(weights).toEqual({ eating: 0.4, sleeping: 0.7, hungry: 1 });
  });
});

describe("sprite motion", () => {
  it("rises each z and fades it in and out, bounded", () => {
    for (const time of times) {
      for (let index = 0; index < Z_COUNT; index++) {
        const z = zMotion(time, index, 0.9, restingZ());
        expect(z.rise).toBeGreaterThanOrEqual(0);
        expect(z.rise).toBeLessThanOrEqual(1.8);
        expect(z.opacity).toBeGreaterThanOrEqual(0);
        expect(z.opacity).toBeLessThanOrEqual(1);
        expect(z.scale).toBeGreaterThan(0.5);
        expect(z.scale).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(bubbleBob(time, 0.5))).toBeLessThanOrEqual(0.06);
    }
  });

  it("gives each creature a stable phase in 0–1", () => {
    for (const id of ["a", "b", "creature-17", ""]) {
      expect(cuePhase(id)).toBe(cuePhase(id));
      expect(cuePhase(id)).toBeGreaterThanOrEqual(0);
      expect(cuePhase(id)).toBeLessThan(1);
    }
    expect(cuePhase("a")).not.toBe(cuePhase("b"));
  });

  it("sizes in screen pixels within limits", () => {
    expect(cuePixels(BUBBLE_PX, 2)).toBe(BUBBLE_PX.min);
    expect(cuePixels(BUBBLE_PX, 1000)).toBe(BUBBLE_PX.max);
    expect(cuePixels(BUBBLE_PX, 40)).toBeCloseTo(BUBBLE_PX.share * 40);
  });

  it("measures world units per pixel at a depth", () => {
    const camera = new THREE.PerspectiveCamera(30, 2, 0.1, 100);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const screen = new ScreenScale();
    screen.set({ camera, heightPx: 300 });
    const expected = (10 * 2 * Math.tan(THREE.MathUtils.degToRad(15))) / 300;
    expect(screen.unitsPerPixel(0, 0, 0)).toBeCloseTo(expected);
    expect(screen.unitsPerPixel(3, 0, -10)).toBeCloseTo(2 * expected);
    expect(screen.right.x).toBeCloseTo(1);
  });
});

describe("cue textures", () => {
  const alpha = (data: Uint8Array, size: number, x: number, y: number) =>
    data[(Math.floor(y * size) * size + Math.floor(x * size)) * 4 + 3];

  it("draws a bubble with an icon and a z, transparent around them", () => {
    const bubble = bubblePixels(64);
    expect(bubble).toHaveLength(64 * 64 * 4);
    expect(alpha(bubble, 64, 0.02, 0.98)).toBe(0);
    expect(alpha(bubble, 64, 0.5, 0.58)).toBe(255);
    const z = zPixels(32);
    expect(alpha(z, 32, 0.02, 0.5)).toBe(0);
    expect(alpha(z, 32, 0.5, 0.5)).toBe(255);
  });

  it("draws a ring clear inside and around, filled clockwise from the top", () => {
    const red = (data: Uint8Array, x: number, y: number) =>
      data[(Math.floor(y * 64) * 64 + Math.floor(x * 64)) * 4];
    const quarter = ringPixels(64, 0.25);
    expect(alpha(quarter, 64, 0.5, 0.5)).toBe(0);
    expect(alpha(quarter, 64, 0.02, 0.02)).toBe(0);
    // On the band: top-right (filled), bottom and left (cream track). Amber has less blue than cream.
    const blue = (data: Uint8Array, x: number, y: number) =>
      data[(Math.floor(y * 64) * 64 + Math.floor(x * 64)) * 4 + 2]!;
    const filled = [0.5 + 0.3 * Math.SQRT1_2, 0.5 + 0.3 * Math.SQRT1_2] as const; // y up
    const track = [0.5, 0.2] as const;
    expect(alpha(quarter, 64, ...filled)).toBe(255);
    expect(alpha(quarter, 64, ...track)).toBe(255);
    expect(blue(quarter, ...filled)).toBeLessThan(120);
    expect(blue(quarter, ...track)).toBeGreaterThan(200);
    expect(red(quarter, ...track)).toBeGreaterThan(200);
    expect(blue(ringPixels(64, 0), ...filled)).toBeGreaterThan(200);
    expect(blue(ringPixels(64, 1), ...track)).toBeLessThan(120);
  });

  it("steps progress to the nearest ring texture, within its range", () => {
    expect(ringStep(0)).toBe(0);
    expect(ringStep(0.5)).toBe(RING_STEPS / 2);
    expect(ringStep(1)).toBe(RING_STEPS);
    expect(ringStep(-1)).toBe(0);
    expect(ringStep(2)).toBe(RING_STEPS);
    expect(ringStep(Number.NaN)).toBe(0);
  });
});

describe("cue sprites", () => {
  const creature = (id: string, cues: Cue[], cueProgress?: number): CreatureSnapshot => ({
    id,
    speciesId: "test:critter",
    position: { regionId: "r", x: 0, z: 0 },
    world: { x: 0, y: 0, z: 0 },
    heading: 0,
    cues,
    ...(cueProgress === undefined ? {} : { cueProgress }),
  });
  const make = () => {
    const layer = new SceneLayer("creatures");
    const bodies = new CreatureBodies(layer, {
      resolveSpecies: () => ({ appearance: "x", sizeClass: "medium", body: { thickness: 0.25 } }),
      resolveAsset: () => undefined,
    });
    const sprites = () => {
      const found: THREE.Sprite[] = [];
      layer.group.traverse((o) => {
        if (o instanceof THREE.Sprite && o.visible) found.push(o);
      });
      return found;
    };
    return { layer, bodies, sprites };
  };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("shows z's while sleeping and a bubble while hungry, over the creature's head", () => {
    const { bodies, sprites } = make();
    bodies.update([creature("a", ["sleeping", "hungry"])], at(0));
    bodies.update([creature("a", ["sleeping", "hungry"])], at(2));
    expect(bodies.cueSprites).toBe(Z_COUNT + 1);
    const shown = sprites();
    expect(shown.filter((s) => s.name === "cue:z")).toHaveLength(Z_COUNT);
    expect(shown.filter((s) => s.name === "cue:bubble")).toHaveLength(1);
    // Above the lowered head of a 0.8 m creature, drawn over the scene and unlit.
    for (const sprite of shown) {
      expect(sprite.position.y).toBeGreaterThan(0.7);
      expect(sprite.material.depthTest).toBe(false);
      expect(sprite.material).toBeInstanceOf(THREE.SpriteMaterial);
    }
  });

  it("hides the food bubble while eating, and shows it again after the meal", () => {
    const { bodies, sprites } = make();
    const bubbles = () => sprites().filter((s) => s.name === "cue:bubble");
    bodies.update([creature("a", ["hungry"])], at(0));
    bodies.update([creature("a", ["hungry"])], at(1));
    expect(bubbles()).toHaveLength(1);
    bodies.update([creature("a", ["eating", "hungry"])], at(1.2));
    const fading = bubbles()[0]!.material.opacity;
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(1);
    for (let t = 1.4; t < 2.5; t += 0.2)
      bodies.update([creature("a", ["eating", "hungry"])], at(t));
    expect(bubbles()).toHaveLength(0);
    for (let t = 2.6; t < 4; t += 0.2) bodies.update([creature("a", ["hungry"])], at(t));
    expect(bubbles()).toHaveLength(1);
    expect(bubbles()[0]!.material.opacity).toBe(1);
  });

  it("fills a ring over the meal where the bubble was, keeping it as it fades out", () => {
    const { bodies, sprites } = make();
    const rings = () => sprites().filter((s) => s.name === "cue:ring");
    bodies.update([creature("a", ["eating"], 0.1)], at(0));
    bodies.update([creature("a", ["eating"], 0.25)], at(1));
    expect(rings()).toHaveLength(1);
    const ring = rings()[0]!;
    expect(ring.material.opacity).toBe(1);
    expect(ring.material.depthTest).toBe(false);
    expect(ring.position.y).toBeGreaterThan(0.7);
    const quarter = ring.material.map;
    bodies.update([creature("a", ["eating"], 0.75)], at(1.1));
    const threeQuarters = ring.material.map;
    expect(threeQuarters).not.toBe(quarter);
    // The meal ends: the ring fades out at the last progress, then goes back to the pool.
    bodies.update([creature("a", [])], at(1.2));
    expect(rings()).toHaveLength(1);
    expect(ring.material.map).toBe(threeQuarters);
    expect(ring.material.opacity).toBeLessThan(1);
    for (let t = 1.3; t < 2; t += 0.1) bodies.update([creature("a", [])], at(t));
    expect(rings()).toHaveLength(0);
    expect(bodies.cueSprites).toBe(0);
    // The same step draws the same texture, made once.
    bodies.update([creature("a", ["eating"], 0.25)], at(2.1));
    expect(rings()[0]!.material.map).toBe(quarter);
  });

  it("shows no ring while eating without progress", () => {
    const { bodies, sprites } = make();
    bodies.update([creature("a", ["eating"])], at(0));
    bodies.update([creature("a", ["eating"])], at(1));
    expect(sprites().filter((s) => s.name === "cue:ring")).toHaveLength(0);
  });

  it("fades sprites out, then pools them for the next creature", () => {
    const { layer, bodies } = make();
    bodies.update([creature("a", ["sleeping"])], at(0));
    bodies.update([creature("a", ["sleeping"])], at(2));
    const all = () => {
      let count = 0;
      layer.group.traverse((o) => (count += o instanceof THREE.Sprite ? 1 : 0));
      return count;
    };
    expect(all()).toBe(Z_COUNT);
    bodies.update([creature("a", [])], at(2.1));
    expect(bodies.cueSprites).toBe(Z_COUNT); // still fading out
    for (let t = 2.2; t < 4; t += 0.1) bodies.update([creature("a", [])], at(t));
    expect(bodies.cueSprites).toBe(0);
    bodies.update([creature("a", []), creature("b", ["sleeping"])], at(4.1));
    expect(bodies.cueSprites).toBe(Z_COUNT);
    expect(all()).toBe(Z_COUNT); // reused, not made anew
  });

  it("hands back a departed creature's sprites and disposes everything", () => {
    const { layer, bodies } = make();
    bodies.update([creature("a", ["hungry"])], at(0));
    bodies.update([creature("a", ["hungry"])], at(1));
    expect(bodies.cueSprites).toBe(1);
    bodies.update([], at(1.1));
    expect(bodies.cueSprites).toBe(0);
    const bubble = layer.group.getObjectByName("cue:bubble") as THREE.Sprite;
    const disposed = vi.fn();
    bubble.material.addEventListener("dispose", disposed);
    bubble.material.map!.addEventListener("dispose", disposed);
    bodies.dispose();
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(layer.group.getObjectByName("cues")).toBeUndefined();
  });

  it("fades cues on real time while paused, holding the motion still", () => {
    const { layer, bodies, sprites } = make();
    const body = () => layer.group.getObjectByName("a") as THREE.Mesh;
    // Paused: animation time stands at 5 while real time runs on.
    bodies.update([creature("a", ["sleeping"])], { time: 5, realTime: 0 });
    for (let t = 0.1; t < 1.5; t += 0.1) {
      bodies.update([creature("a", ["sleeping"])], { time: 5, realTime: t });
    }
    expect(body().scale.y).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(sprites()).toHaveLength(Z_COUNT);
    const held = sprites().map((s) => s.position.y);
    bodies.update([creature("a", ["sleeping"])], { time: 5, realTime: 1.6 });
    expect(sprites().map((s) => s.position.y)).toEqual(held);
  });

  it("keeps a long body's front above the ground while it pecks", async () => {
    // A 2:1 body: 40 × 20 px, so its front reaches as far ahead of its feet as it is tall.
    const long = { width: 40, height: 20, data: new Uint8Array(40 * 20 * 4).fill(255) };
    const layer = new SceneLayer("creatures");
    const bodies = new CreatureBodies(layer, {
      resolveSpecies: () => ({ appearance: "x", sizeClass: "medium", body: { thickness: 0.25 } }),
      resolveAsset: () => ({ kind: "image", url: "long.png" }),
      readImage: async () => long,
    });
    bodies.update([creature("a", ["eating"])], at(0));
    await bodies.ready;
    const mesh = () => layer.group.getObjectByName("a") as THREE.Mesh;
    let deepest = Infinity;
    for (let t = 1; t < 4; t += 0.05) {
      bodies.update([creature("a", ["eating"])], at(t));
      deepest = Math.min(deepest, new THREE.Box3().setFromObject(mesh()).min.y);
    }
    expect(mesh().geometry.type).toBe("ExtrudeGeometry");
    expect(deepest).toBeGreaterThanOrEqual(-1e-6);
  });

  it("poses the body: a bob while eating, lowered while sleeping", () => {
    const { layer, bodies } = make();
    const body = () => layer.group.getObjectByName("a") as THREE.Mesh;
    bodies.update([creature("a", ["sleeping"])], at(0));
    bodies.update([creature("a", ["sleeping"])], at(0.2));
    const fading = body().scale.y;
    expect(fading).toBeLessThan(1);
    expect(fading).toBeGreaterThan(0.9); // still easing in
    for (let t = 0.4; t < 3; t += 0.2) bodies.update([creature("a", ["sleeping"])], at(t));
    expect(body().scale.y).toBeLessThanOrEqual(0.9 + 1e-9);
    for (let t = 3; t < 6; t += 0.2) bodies.update([creature("a", ["eating"])], at(t));
    expect(body().scale.y).toBe(1);
    const heights = [6, 6.2, 6.4, 6.6, 6.8].map((t) => {
      bodies.update([creature("a", ["eating"])], at(t));
      return body().position.y;
    });
    expect(Math.max(...heights)).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0);
  });
});
