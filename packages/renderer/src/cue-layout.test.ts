import { defaultBody } from "@living-diorama/content-schema";
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
/** A frame after a long gap, so shifts go straight to where the layout puts them. */
const SETTLE = SNAP_SECONDS + 1;

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
    layoutCues(boxes, SETTLE);
    const [a, b] = boxes as [CueBox, CueBox];
    expect(apart(a, b)).toBeGreaterThanOrEqual(a.radius + b.radius + CUE_MARGIN_PX - 1e-6);
    expect(a.shiftX).toBeLessThan(0);
    expect(b.shiftX).toBeCloseTo(-a.shiftX);
    // Bubbles clear of each other stay put.
    const clear = [box(0), box(200)];
    layoutCues(clear, SETTLE);
    expect(clear.map(shift)).toEqual([0, 0]);
  });

  it("sends the earlier of two bubbles on the same spot left, and never down into a head", () => {
    const boxes = [box(0, 0), box(0, 0), box(0, -5)];
    layoutCues(boxes, SETTLE);
    expect(boxes[0]!.shiftX).toBeLessThan(0);
    expect(boxes[1]!.shiftX).toBeGreaterThan(0);
    for (const b of boxes) expect(b.shiftY).toBeGreaterThanOrEqual(0);
  });

  it("shifts no bubble further than its own size, however many bunch up", () => {
    const boxes = Array.from({ length: 20 }, (_, k) => box((k % 5) * 2, Math.floor(k / 5) * 2));
    layoutCues(boxes, SETTLE);
    for (const b of boxes) expect(shift(b)).toBeLessThanOrEqual(b.size + 1e-9);
    expect(boxes.some((b) => shift(b) > 0.9 * b.size)).toBe(true);
  });

  it("ignores hidden cues and lets a faint one give way to a clear one", () => {
    const hidden = [box(0), box(10, 0, HUNGRY, 0)];
    layoutCues(hidden, SETTLE);
    expect(hidden.map(shift)).toEqual([0, 0]);

    const faint = [box(0), box(10, 0, HUNGRY, 0.25)];
    layoutCues(faint, SETTLE);
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
      layoutCues(boxes, SETTLE);
      return boxes[0]!.shiftX;
    })();
    const at60 = settle(1 / 60);
    const at20 = settle(1 / 20);
    // After one time constant about 63% of the way, at 60 or 20 fps alike.
    expect(at60 / target).toBeCloseTo(1 - Math.exp(-1), 1);
    expect(at20).toBeCloseTo(at60, 6);
  });

  it("moves smoothly as a cue fades in or out across the layout's weight line", () => {
    const dt = 1 / 30;
    const boxes = [box(0), box(10, 0, HUNGRY, 0)];
    /** Fades the second cue's visibility from `from` to `to` over a second, noting the shifts. */
    const fade = (from: number, to: number) => {
      const shifts: number[][] = [];
      for (let t = 0; t <= 1 + 1e-9; t += dt) {
        describeCues(boxes[1]!, HUNGRY, 40, from + (to - from) * t, false, 10, 0);
        layoutCues(boxes, dt);
        shifts.push(boxes.map((b) => b.shiftX));
      }
      // Then lets it settle, still noting every frame.
      for (let k = 0; k < 15; k++) {
        layoutCues(boxes, dt);
        shifts.push(boxes.map((b) => b.shiftX));
      }
      return shifts;
    };
    const steps = (shifts: number[][]) =>
      Math.max(
        ...shifts
          .slice(1)
          .map((s, k) => Math.max(...s.map((x, i) => Math.abs(x - shifts[k]![i]!)))),
      );
    const settled = (() => {
      const pair = [box(0), box(10)];
      layoutCues(pair, SETTLE);
      return pair[1]!.shiftX;
    })();
    // Fading in: the newcomer eases out from where it is, nothing jumps.
    const fadeIn = fade(0, 1);
    expect(fadeIn[0]![1]).toBeLessThan(0.2 * settled);
    // Easing, not a jump: no frame moves a cue a tenth of its size (snapping moved it about half).
    const most = 0.1 * boxes[1]!.size;
    expect(steps(fadeIn)).toBeLessThan(most);
    expect(boxes[1]!.shiftX).toBeCloseTo(settled, 0);
    // Fading out, through the line where it stops counting: both ease back, nothing jumps.
    const fadeOut = fade(1, 0);
    expect(steps(fadeOut)).toBeLessThan(most);
    expect(Math.abs(boxes[0]!.shiftX)).toBeLessThan(0.1 * settled);
    expect(Math.abs(boxes[1]!.shiftX)).toBeLessThan(0.1 * settled);
  });

  it("snaps to where the layout puts cues after a long gap", () => {
    const boxes = [box(0), box(10)];
    layoutCues(boxes, 1 / 30);
    const eased = boxes[1]!.shiftX;
    layoutCues(boxes, SETTLE);
    expect(boxes[1]!.shiftX).toBeGreaterThan(2 * eased);
    const settled = boxes[1]!.shiftX;
    layoutCues(boxes, 1 / 30);
    expect(boxes[1]!.shiftX).toBeCloseTo(settled, 9);
  });

  it("pushes the upper of two cues stacked on screen up, as the lower can't go down", () => {
    const boxes = [box(0, 0), box(0, 10)];
    const [lower, upper] = boxes as [CueBox, CueBox];
    const overlap = lower.radius + upper.radius + CUE_MARGIN_PX - 10;
    layoutCues(boxes, SETTLE);
    expect(lower.shiftY).toBe(0);
    expect(lower.shiftX).toBe(0);
    expect(upper.shiftX).toBe(0);
    // It takes the lower one's half too, all but what's left after the last pass.
    expect(upper.shiftY).toBeGreaterThan(0.9 * overlap);
    expect(upper.shiftY).toBeLessThanOrEqual(overlap + 1e-9);
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
      resolveSpecies: () => ({
        appearance: "x",
        sizeClass: "small",
        body: { ...defaultBody(), thickness: 0.25 },
      }),
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
