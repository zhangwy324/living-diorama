import type { Cue, CreatureSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  CUE_MARGIN_PX,
  SHIFT_SECONDS,
  describeCues,
  emptyCueBox,
  layoutCues,
  type CueBox,
} from "./cue-layout";
import { CreatureBodies } from "./creatures";
import { BUBBLE_PX, SNAP_SECONDS, ScreenScale, Z_COUNT_SMALL, Z_COUNT_THIN } from "./cues";
import { SceneLayer } from "./layers";

const HUNGRY = { eating: 0, sleeping: 0, hungry: 1 };
const SLEEPING = { eating: 0, sleeping: 1, hungry: 0 };

/** A creature 40 px tall on screen with its head's top at (x, y), showing `weights`. */
const box = (x: number, y = 0, weights = HUNGRY, visible = 1): CueBox =>
  describeCues(emptyCueBox(), weights, 40, visible, false, x, y);

const centre = (b: CueBox) => ({ x: b.x + b.shiftX, y: b.y + b.shiftY });
const apart = (a: CueBox, b: CueBox) =>
  Math.hypot(centre(a).x - centre(b).x, centre(a).y - centre(b).y);
const shift = (b: CueBox) => Math.hypot(b.shiftX, b.shiftY);

describe("layoutCues", () => {
  it("pushes overlapping bubbles apart, each half way", () => {
    const boxes = [box(0), box(10)];
    layoutCues(boxes, 1 / 30);
    const [a, b] = boxes as [CueBox, CueBox];
    expect(apart(a, b)).toBeGreaterThanOrEqual(a.radius + b.radius + CUE_MARGIN_PX - 1e-6);
    expect(a.shiftX).toBeLessThan(0);
    expect(b.shiftX).toBeCloseTo(-a.shiftX);
    // Bubbles clear of each other stay put.
    const clear = [box(0), box(200)];
    layoutCues(clear, 1 / 30);
    expect(clear.map(shift)).toEqual([0, 0]);
  });

  it("sends the earlier of two bubbles on the same spot left, and never down into a head", () => {
    const boxes = [box(0, 0), box(0, 0), box(0, -5)];
    layoutCues(boxes, 1 / 30);
    expect(boxes[0]!.shiftX).toBeLessThan(0);
    expect(boxes[1]!.shiftX).toBeGreaterThan(0);
    for (const b of boxes) expect(b.shiftY).toBeGreaterThanOrEqual(0);
  });

  it("shifts no bubble further than its own size, however many bunch up", () => {
    const boxes = Array.from({ length: 20 }, (_, k) => box((k % 5) * 2, Math.floor(k / 5) * 2));
    layoutCues(boxes, 1 / 30);
    for (const b of boxes) expect(shift(b)).toBeLessThanOrEqual(b.size + 1e-9);
    expect(boxes.some((b) => shift(b) > 0.9 * b.size)).toBe(true);
  });

  it("ignores hidden cues and lets a faint one give way to a clear one", () => {
    const hidden = [box(0), box(10, 0, HUNGRY, 0)];
    layoutCues(hidden, 1 / 30);
    expect(hidden.map(shift)).toEqual([0, 0]);

    const faint = [box(0), box(10, 0, HUNGRY, 0.25)];
    layoutCues(faint, 1 / 30);
    expect(shift(faint[1]!)).toBeGreaterThan(3 * shift(faint[0]!));
  });

  it("eases a bubble to its new place at the same pace whatever the frame rate", () => {
    const settle = (dt: number) => {
      const boxes = [box(0), box(100)];
      layoutCues(boxes, dt); // apart: no shift
      boxes[1]!.x = 10; // the second creature walks up close
      for (let t = 0; t < SHIFT_SECONDS - 1e-9; t += dt) layoutCues(boxes, dt);
      return boxes[0]!.shiftX;
    };
    const target = (() => {
      const boxes = [box(0), box(10)];
      layoutCues(boxes, 1 / 30);
      return boxes[0]!.shiftX;
    })();
    const at60 = settle(1 / 60);
    const at20 = settle(1 / 20);
    // After one time constant about 63% of the way, at 60 or 20 fps alike.
    expect(at60 / target).toBeCloseTo(1 - Math.exp(-1), 1);
    expect(at20).toBeCloseTo(at60, 6);
  });

  it("puts a cue that appears straight where it belongs, and snaps after a long gap", () => {
    const boxes = [box(0), box(10, 0, HUNGRY, 0)];
    layoutCues(boxes, 1 / 30);
    expect(boxes[0]!.shiftX).toBe(0);
    describeCues(boxes[1]!, HUNGRY, 40, 1, false, 10, 0); // its cue fades in
    layoutCues(boxes, 1 / 30);
    const settled = boxes[1]!.shiftX;
    expect(settled).toBeGreaterThan(0); // the newcomer is in place at once...
    expect(boxes[0]!.shiftX).toBeGreaterThan(-settled); // ...the one shown eases aside
    layoutCues(boxes, SNAP_SECONDS + 1);
    expect(boxes[0]!.shiftX).toBeCloseTo(-settled);
  });

  it("thins the later of two sleepers whose z's overlap, steadily", () => {
    const boxes = [box(0, 0, SLEEPING), box(8, 2, SLEEPING), box(300, 0, SLEEPING)];
    for (let k = 0; k < 10; k++) {
      layoutCues(boxes, 1 / 30);
      expect(boxes.map((b) => b.thin)).toEqual([false, true, false]);
    }
    // A little further apart it stays thin (hysteresis)...
    // About a fifth of its z column overlapping: between THIN_EXIT and THIN_ENTER.
    boxes[1]!.zLeft = boxes[0]!.zLeft + 0.78 * boxes[0]!.zWidth;
    layoutCues(boxes, 1 / 30);
    expect(boxes[1]!.thin).toBe(true);
    // ...and only well apart rises in full again.
    describeCues(boxes[1]!, SLEEPING, 40, 1, false, 100, 0);
    layoutCues(boxes, 1 / 30);
    expect(boxes[1]!.thin).toBe(false);
  });

  it("doesn't thin a sleeper for one that is hidden", () => {
    const boxes = [box(0, 0, SLEEPING, 0), box(8, 2, SLEEPING)];
    layoutCues(boxes, 1 / 30);
    expect(boxes.map((b) => b.thin)).toEqual([false, false]);
  });
});

describe("ScreenScale.project", () => {
  it("gives CSS pixels from the centre, y up, and nothing behind the camera", () => {
    const camera = new THREE.PerspectiveCamera(30, 2, 0.5, 400);
    camera.position.set(0, 0, 10);
    camera.lookAt(0, 0, 0);
    const screen = new ScreenScale();
    const out = new THREE.Vector3();
    expect(screen.project(new THREE.Vector3(), out)).toBe(false); // no camera yet
    screen.set({ camera, heightPx: 200 });
    expect(screen.project(new THREE.Vector3(0, 0, 0), out)).toBe(true);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(0);
    // One metre up at 10 m is 1 / unitsPerPixel pixels up.
    screen.project(new THREE.Vector3(0, 1, 0), out);
    expect(out.y).toBeCloseTo(1 / screen.unitsPerPixel(0, 1, 0), 0);
    screen.project(new THREE.Vector3(1, 0, 0), out);
    expect(out.x).toBeGreaterThan(0);
    expect(screen.project(new THREE.Vector3(0, 0, 20), out)).toBe(false);
  });
});

describe("cue layout in CreatureBodies", () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const creature = (id: string, x: number, cues: Cue[]): CreatureSnapshot => ({
    id,
    speciesId: "test:critter",
    position: { regionId: "r", x, z: 0 },
    world: { x, y: 0, z: 0 },
    heading: 0,
    cues,
  });
  const make = () => {
    const layer = new SceneLayer("creatures");
    const bodies = new CreatureBodies(layer, {
      resolveSpecies: () => ({ appearance: "x", sizeClass: "small", body: { thickness: 0.25 } }),
      resolveAsset: () => undefined,
    });
    // Far off, like the strip: small creatures are a few dozen pixels tall.
    const camera = new THREE.PerspectiveCamera(30, 4, 0.5, 400);
    camera.position.set(0, 4, 25);
    camera.lookAt(0, 0, 0);
    const view = { camera, heightPx: 220 };
    const shown = (name: string) => {
      const found: THREE.Sprite[] = [];
      layer.group.traverse((o) => {
        if (o instanceof THREE.Sprite && o.visible && o.name === name) found.push(o);
      });
      return found;
    };
    return { bodies, view, shown };
  };

  it("keeps the bubbles of creatures side by side apart, the same whatever order they come in", () => {
    const run = (order: string[]) => {
      const { bodies, view, shown } = make();
      const poses = order.map((id) => creature(id, id === "a" ? 0 : 0.05, ["hungry"]));
      for (let t = 0; t <= 2; t += 0.05) bodies.update(poses, { time: t, realTime: t, view });
      return shown("cue:bubble")
        .map((s) => s.position.x)
        .sort((p, q) => p - q);
    };
    const xs = run(["a", "b"]);
    expect(xs).toHaveLength(2);
    // 5 cm apart, the creatures' bubbles are moved most of a bubble apart.
    const screen = new ScreenScale();
    const { view } = make();
    screen.set(view);
    const bubblePx = (xs[1]! - xs[0]!) / screen.unitsPerPixel(0, 0.4, 0);
    expect(bubblePx).toBeGreaterThan(0.7 * BUBBLE_PX.min);
    const back = run(["b", "a"]);
    back.forEach((x, k) => expect(x).toBeCloseTo(xs[k]!, 9));
  });

  it("lets fewer z's rise from a sleeper next to another, by ID", () => {
    const { bodies, view, shown } = make();
    const poses = [creature("b", 0.05, ["sleeping"]), creature("a", 0, ["sleeping"])];
    for (let t = 0; t <= 10; t += 0.05) bodies.update(poses, { time: t, realTime: t, view });
    expect(shown("cue:z")).toHaveLength(Z_COUNT_SMALL + Z_COUNT_THIN);
    // Apart, both rise in full again within a rise or two.
    poses[0] = creature("b", 6, ["sleeping"]);
    for (let t = 10; t <= 20; t += 0.05) bodies.update(poses, { time: t, realTime: t, view });
    expect(shown("cue:z")).toHaveLength(2 * Z_COUNT_SMALL);
  });
});
