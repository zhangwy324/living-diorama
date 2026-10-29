import { defaultBody } from "@living-diorama/content-schema";
import type { Cue, CreatureSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CreatureBodies } from "./creatures";
import {
  BUBBLE_PX,
  CueSprites,
  FOOD_ICON,
  MAP_SAMPLE,
  MIP_BIAS,
  RING_STEPS,
  SNAP_SECONDS,
  ScreenScale,
  Z_COUNT,
  Z_COUNT_SMALL,
  Z_PERIOD,
  Z_PX,
  Z_TILT,
  bodyMotion,
  bubbleBob,
  bubblePixels,
  cuePhase,
  cuePixels,
  restingMotion,
  restingZ,
  ringPixels,
  ringStep,
  sharpen,
  stepCueWeights,
  zAt,
  zTarget,
  noCueSprites,
  zPixels,
  type CueAnchor,
  type CueWeights,
} from "./cues";
import { SceneLayer } from "./layers";

/** A creature body's placement, read from its matrix (it composes more than position, rotation, scale). */
const placed = (mesh: THREE.Object3D) => {
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  mesh.matrix.decompose(position, new THREE.Quaternion(), scale);
  return { position, scale };
};

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
      for (let serial = 0; serial < Z_COUNT; serial++) {
        const z = zAt(((time / Z_PERIOD) % 1.2) - 0.1, serial, restingZ());
        expect(z.rise).toBeGreaterThanOrEqual(0);
        expect(z.rise).toBeLessThanOrEqual(1.8);
        expect(z.opacity).toBeGreaterThanOrEqual(0);
        expect(z.opacity).toBeLessThanOrEqual(1);
        expect(z.scale).toBeGreaterThanOrEqual(0.45);
        expect(z.scale).toBeLessThanOrEqual(1);
        expect(Math.abs(z.tilt)).toBe(Z_TILT);
      }
      expect(Math.abs(bubbleBob(time, 0.5))).toBeLessThanOrEqual(0.06);
    }
  });

  it("eases each z out: small and quick at first, slowing as it grows", () => {
    const at = (p: number) => zAt(p, 0, restingZ());
    expect(at(0).scale).toBeLessThanOrEqual(0.5);
    expect(at(1).scale).toBeCloseTo(1);
    // More than half the rise in the first third of the time.
    expect(at(1 / 3).rise).toBeGreaterThan(0.5 * at(1).rise);
    const steps = [0, 0.25, 0.5, 0.75, 1].map((p) => at(p).rise);
    for (let k = 1; k < steps.length - 1; k++) {
      expect(steps[k + 1]! - steps[k]!).toBeLessThan(steps[k]! - steps[k - 1]!);
    }
  });

  it("leans neighbouring z's opposite ways by about 9°", () => {
    expect(THREE.MathUtils.radToDeg(Z_TILT)).toBeGreaterThanOrEqual(8);
    expect(THREE.MathUtils.radToDeg(Z_TILT)).toBeLessThanOrEqual(10);
    expect(zAt(0.5, 0, restingZ()).tilt).toBe(Z_TILT);
    expect(zAt(0.5, 1, restingZ()).tilt).toBe(-Z_TILT);
  });

  it("aims for two z's when they are small on screen, three otherwise, with hysteresis", () => {
    expect(zTarget(Z_PX.min)).toBe(Z_COUNT_SMALL);
    expect(Z_COUNT_SMALL).toBe(2);
    expect(zTarget(Z_PX.max)).toBe(Z_COUNT);
    expect(Z_PX.min).toBeGreaterThanOrEqual(15);
    // Near the line at 18 px the previous target holds, so a size wavering there doesn't flip it.
    for (const px of [17.2, 18, 18.8]) {
      expect(zTarget(px, Z_COUNT_SMALL)).toBe(Z_COUNT_SMALL);
      expect(zTarget(px, Z_COUNT)).toBe(Z_COUNT);
    }
    expect(zTarget(16.9, Z_COUNT)).toBe(Z_COUNT_SMALL);
    expect(zTarget(19.1, Z_COUNT_SMALL)).toBe(Z_COUNT);
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

  const pixel = (data: Uint8Array, size: number, x: number, y: number) => {
    const k = (Math.floor(y * size) * size + Math.floor(x * size)) * 4;
    return [data[k]!, data[k + 1]!, data[k + 2]!, data[k + 3]!];
  };
  const brightness = (data: Uint8Array, size: number, x: number, y: number) => {
    const [r, g, b] = pixel(data, size, x, y);
    return (r! + g! + b!) / 3;
  };

  it("draws a round bubble with a short tail at the bottom centre, clear around it", () => {
    const bubble = bubblePixels(128);
    expect(bubble).toHaveLength(128 * 128 * 4);
    for (const [x, y] of [
      [0.02, 0.98],
      [0.02, 0.02],
      [0.98, 0.02],
      [0.3, 0.12], // beside the tail
      [0.5, 0.01], // below its tip
    ] as const) {
      expect(alpha(bubble, 128, x, y)).toBe(0);
    }
    expect(alpha(bubble, 128, 0.5, 0.6)).toBe(255);
    expect(alpha(bubble, 128, 0.5, 0.2)).toBe(255); // the tail, centred
    // As wide as it is tall: the body reaches as far left and right as up from its centre.
    const reach = (dx: number, dy: number) => {
      let r = 0;
      while (alpha(bubble, 128, 0.5 + dx * r, 0.6 + dy * r)! > 127) r += 1 / 256;
      return r;
    };
    expect(reach(1, 0)).toBeCloseTo(reach(-1, 0), 1);
    expect(reach(1, 0)).toBeCloseTo(reach(0, 1), 1);
  });

  it("keeps every texture's outline inside it, clear at the edges", () => {
    // The margins are tight: an outline that reached the edge would be cut off flat.
    const edgesClear = (data: Uint8Array, size: number) => {
      for (let k = 0; k < size; k++) {
        for (const [column, row] of [
          [k, 0],
          [k, size - 1],
          [0, k],
          [size - 1, k],
        ] as const) {
          expect(data[(row * size + column) * 4 + 3]).toBe(0);
        }
      }
    };
    edgesClear(bubblePixels(128), 128);
    edgesClear(zPixels(64), 64);
    edgesClear(zPixels(64, true), 64);
    for (const progress of [0, 0.5, 1]) edgesClear(ringPixels(64, progress), 64);
  });

  it("outlines the bubble about 2 CSS px thick at its smallest", () => {
    const size = 128;
    const bubble = bubblePixels(size);
    // Walk in from the top edge along the centre, above the icon: count the outline's texels.
    let dark = 0;
    for (let row = size - 1; row > size * 0.86; row--) {
      const y = (row + 0.5) / size;
      if (alpha(bubble, size, 0.5, y)! > 200 && brightness(bubble, size, 0.5, y) < 100) dark++;
    }
    const px = (dark / size) * BUBBLE_PX.min;
    expect(px).toBeGreaterThanOrEqual(1.5);
    expect(px).toBeLessThanOrEqual(2.5);
  });

  it("draws the icon it is given, the food icon by default", () => {
    const red = (data: Uint8Array) => pixel(data, 128, 0.5, 0.57);
    expect(bubblePixels(128)).toEqual(bubblePixels(128, FOOD_ICON));
    const [r, g, b] = red(bubblePixels(128));
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(100);
    expect(b).toBeLessThan(100);
    const blue = [
      { distance: (x: number, y: number) => Math.hypot(x, y) - 0.8, color: [0, 0, 1] as const },
    ];
    const [r2, , b2] = red(bubblePixels(128, blue));
    expect(r2).toBe(0);
    expect(b2).toBe(255);
    // An empty icon leaves the bubble plain cream.
    expect(brightness(bubblePixels(128, []), 128, 0.5, 0.57)).toBeGreaterThan(230);
  });

  it("draws a z dark on light by day and light on dark at night, clear around it", () => {
    const day = zPixels(64);
    const night = zPixels(64, true);
    for (const z of [day, night]) {
      expect(alpha(z, 64, 0.02, 0.5)).toBe(0);
      expect(alpha(z, 64, 0.5, 0.5)).toBe(255);
    }
    // The stroke's middle, and just outside it: the outline.
    const stroke = [0.5, 0.76] as const;
    const edge = [0.5, 0.76 + 0.075 + 0.05] as const;
    expect(brightness(day, 64, ...stroke)).toBeLessThan(80);
    expect(brightness(day, 64, ...edge)).toBeGreaterThan(200);
    expect(brightness(night, 64, ...stroke)).toBeGreaterThan(200);
    expect(brightness(night, 64, ...edge)).toBeLessThan(80);
  });

  it("samples cue textures sharper, through the sprite shader's own map lookup", () => {
    // A three.js upgrade that renames the lookup fails here instead of silently blurring.
    expect(THREE.ShaderChunk.map_fragment).toContain(MAP_SAMPLE);
    expect(THREE.ShaderLib.sprite.fragmentShader).toContain("#include <map_fragment>");
    const material = sharpen(new THREE.SpriteMaterial());
    const shader = {
      fragmentShader: "void main() {\n#include <map_fragment>\n}",
    } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    expect(shader.fragmentShader).toContain(`texture2D( map, vMapUv, ${MIP_BIAS.toFixed(2)} )`);
    expect(shader.fragmentShader).not.toContain(MAP_SAMPLE);
    expect(material.customProgramCacheKey()).toBe(
      sharpen(new THREE.SpriteMaterial()).customProgramCacheKey(),
    );
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

  it("steps progress down to a ring texture, within its range, full only at 1", () => {
    expect(ringStep(0)).toBe(0);
    expect(ringStep(0.5)).toBe(RING_STEPS / 2);
    expect(ringStep(1)).toBe(RING_STEPS);
    // The last tick of a 100-tick meal still shows a gap.
    expect(ringStep(0.99)).toBe(RING_STEPS - 1);
    expect(ringStep(0.5 / RING_STEPS)).toBe(0);
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
    animation: undefined,
    submersion: 0,
    cues,
    ...(cueProgress === undefined ? {} : { cueProgress }),
  });
  const make = () => {
    const layer = new SceneLayer("creatures");
    const bodies = new CreatureBodies(layer, {
      resolveSpecies: () => ({
        appearance: "x",
        sizeClass: "medium",
        body: { ...defaultBody(), thickness: 0.25 },
      }),
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
    expect(bodies.cueSprites).toBe(Z_COUNT_SMALL + 1);
    const shown = sprites();
    expect(shown.filter((s) => s.name === "cue:z")).toHaveLength(Z_COUNT_SMALL);
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
    expect(all()).toBe(Z_COUNT_SMALL);
    bodies.update([creature("a", [])], at(2.1));
    expect(bodies.cueSprites).toBe(Z_COUNT_SMALL); // still fading out
    for (let t = 2.2; t < 4; t += 0.1) bodies.update([creature("a", [])], at(t));
    expect(bodies.cueSprites).toBe(0);
    bodies.update([creature("a", []), creature("b", ["sleeping"])], at(4.1));
    expect(bodies.cueSprites).toBe(Z_COUNT_SMALL);
    expect(all()).toBe(Z_COUNT_SMALL); // reused, not made anew
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
    expect(placed(body()).scale.y).toBeLessThanOrEqual(0.9 + 1e-9);
    expect(sprites()).toHaveLength(Z_COUNT_SMALL);
    const held = sprites().map((s) => s.position.y);
    bodies.update([creature("a", ["sleeping"])], { time: 5, realTime: 1.6 });
    expect(sprites().map((s) => s.position.y)).toEqual(held);
  });

  it("keeps a long body's front above the ground while it pecks", async () => {
    // A 2:1 body: 40 × 20 px, so its front reaches as far ahead of its feet as it is tall.
    const long = { width: 40, height: 20, data: new Uint8Array(40 * 20 * 4).fill(255) };
    const layer = new SceneLayer("creatures");
    const bodies = new CreatureBodies(layer, {
      resolveSpecies: () => ({
        appearance: "x",
        sizeClass: "medium",
        body: { ...defaultBody(), thickness: 0.25 },
      }),
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
    const fading = placed(body()).scale.y;
    expect(fading).toBeLessThan(1);
    expect(fading).toBeGreaterThan(0.9); // still easing in
    for (let t = 0.4; t < 3; t += 0.2) bodies.update([creature("a", ["sleeping"])], at(t));
    expect(placed(body()).scale.y).toBeLessThanOrEqual(0.9 + 1e-9);
    for (let t = 3; t < 6; t += 0.2) bodies.update([creature("a", ["eating"])], at(t));
    expect(placed(body()).scale.y).toBeCloseTo(1, 9);
    const heights = [6, 6.2, 6.4, 6.6, 6.8].map((t) => {
      bodies.update([creature("a", ["eating"])], at(t));
      return placed(body()).position.y;
    });
    expect(Math.max(...heights)).toBeGreaterThan(0);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(0);
  });

  it("follows a new z count smoothly: no z vanishes mid-rise or jumps", () => {
    const cues = new CueSprites();
    const sprites = noCueSprites();
    const anchor = (creaturePx: number): CueAnchor => ({
      top: new THREE.Vector3(0, 1, 0),
      creaturePx,
      unitsPerPixel: 0.01,
      right: new THREE.Vector3(1, 0, 0),
      visible: 1,
      shift: new THREE.Vector3(),
      zThin: false,
    });
    const sleeping = { eating: 0, sleeping: 1, hungry: 0 };
    const step = 1 / 30;
    // Each z's height and opacity on the previous frame, by its serial number (sprites are reused).
    const snapshot = () =>
      new Map(
        sprites.zs.map((z, k) => [
          sprites.zSerials[k]!,
          { y: z.position.y, opacity: z.material.opacity },
        ]),
      );
    let last = new Map<number, { y: number; opacity: number }>();
    const run = (creaturePx: number, from: number, to: number) => {
      let most = 0;
      for (let t = from; t < to; t += step) {
        cues.place(sprites, sleeping, anchor(creaturePx), t, 0.3);
        const now = snapshot();
        for (const [serial, before] of last) {
          const after = now.get(serial);
          // A z that goes was faint, at the end of its rise...
          if (!after) expect(before.opacity).toBeLessThan(0.05);
          // ...and one that stays keeps rising, by less than a few pixels a frame.
          else {
            expect(after.y).toBeGreaterThanOrEqual(before.y);
            expect(after.y - before.y).toBeLessThan(0.03);
          }
        }
        // A z that comes starts faint.
        for (const [serial, z] of now) if (!last.has(serial)) expect(z.opacity).toBeLessThan(0.2);
        last = now;
        most = Math.max(most, sprites.zs.length);
      }
      return most;
    };
    cues.place(sprites, sleeping, anchor(20), 0, 0.3); // 8 px z's: two
    last = snapshot();
    expect(sprites.zs).toHaveLength(Z_COUNT_SMALL);
    expect(run(20, step, 8)).toBe(Z_COUNT_SMALL);
    // Bigger on screen (40 px z's): a third z joins as the next ones start, no sooner.
    cues.place(sprites, sleeping, anchor(100), 8, 0.3);
    expect(sprites.zs.length).toBeLessThanOrEqual(Z_COUNT_SMALL + 1);
    last = snapshot();
    run(100, 8 + step, 16);
    expect(sprites.zs).toHaveLength(Z_COUNT);
    // Neighbours lean opposite ways.
    const [first, second] = sprites.zs;
    expect(first!.material.rotation).toBe(-second!.material.rotation);
    // And back to two, the third left to finish its rise. (Smaller, so every z steps down once.)
    cues.place(sprites, sleeping, anchor(20), 16, 0.3);
    expect(sprites.zs).toHaveLength(Z_COUNT);
    last = snapshot();
    run(20, 16 + step, 24);
    expect(sprites.zs).toHaveLength(Z_COUNT_SMALL);
    expect(cues.active).toBe(Z_COUNT_SMALL);
    cues.dispose();
  });

  it("starts z's afresh after a gap or if time goes back", () => {
    const cues = new CueSprites();
    const sprites = noCueSprites();
    const anchor: CueAnchor = {
      top: new THREE.Vector3(0, 1, 0),
      creaturePx: 20,
      unitsPerPixel: 0.01,
      right: new THREE.Vector3(1, 0, 0),
      visible: 1,
      shift: new THREE.Vector3(),
      zThin: false,
    };
    const sleeping = { eating: 0, sleeping: 1, hungry: 0 };
    for (const time of [0, 0.5, 100, 40, 40.1]) {
      cues.place(sprites, sleeping, anchor, time, 0.6);
      expect(sprites.zs).toHaveLength(Z_COUNT_SMALL);
      for (const z of sprites.zs) expect(z.material.opacity).toBeGreaterThanOrEqual(0);
      for (const start of sprites.zStarts) {
        expect(start).toBeLessThanOrEqual(time);
        expect(time - start).toBeLessThan(Z_PERIOD);
      }
    }
    expect(cues.active).toBe(Z_COUNT_SMALL);
    cues.dispose();
  });

  it("switches the z's to their night look as each starts its next rise", () => {
    const { bodies, sprites } = make();
    const zs = () => sprites().filter((s) => s.name === "cue:z");
    bodies.update([creature("a", ["sleeping"])], at(0));
    bodies.update([creature("a", ["sleeping"])], at(2));
    const day = zs()[0]!.material.map;
    expect(zs().every((z) => z.material.map === day)).toBe(true);
    bodies.setNight(true);
    bodies.update([creature("a", ["sleeping"])], at(2.05));
    // Mid-rise, each z keeps its look...
    expect(zs().every((z) => z.material.map === day)).toBe(true);
    // ...and takes the night look once it starts again, within one rise.
    for (let t = 2.1; t < 6; t += 0.05) bodies.update([creature("a", ["sleeping"])], at(t));
    const night = zs()[0]!.material.map;
    expect(night).not.toBe(day);
    expect(zs().every((z) => z.material.map === night)).toBe(true);
    // A z that appears later takes the current look at once.
    bodies.update([creature("a", ["sleeping"]), creature("b", ["sleeping"])], at(6.05));
    bodies.update([creature("a", ["sleeping"]), creature("b", ["sleeping"])], at(7));
    expect(zs().every((z) => z.material.map === night)).toBe(true);
  });

  it("holds z's and the bubble still with reduced motion", () => {
    const cues = new CueSprites();
    cues.reducedMotion = true;
    const sprites = noCueSprites();
    const anchor: CueAnchor = {
      top: new THREE.Vector3(0, 1, 0),
      creaturePx: 20,
      unitsPerPixel: 0.01,
      right: new THREE.Vector3(1, 0, 0),
      visible: 1,
      shift: new THREE.Vector3(),
      zThin: false,
    };
    const weights = { eating: 0, sleeping: 1, hungry: 1 };
    const positions = () =>
      [...sprites.zs, sprites.bubble!].map((s) => s.position.toArray().concat(s.material.opacity));
    cues.place(sprites, weights, anchor, 1, 0.3);
    const held = positions();
    for (const time of [1.7, 2.9, 4.4]) {
      cues.place(sprites, weights, anchor, time, 0.3);
      expect(positions()).toEqual(held);
    }
    for (const z of sprites.zs) expect(z.material.opacity).toBeGreaterThan(0.5);
    cues.dispose();
  });
});
