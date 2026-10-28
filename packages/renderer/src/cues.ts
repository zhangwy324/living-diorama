import type { Cue } from "@living-diorama/simulation";
import * as THREE from "three";

// What a creature visibly shows (ADR 0018 §15): a gentle bob while eating, a lowered, slowly
// breathing body with rising z's while sleeping, and a food bubble while hungry. The renderer knows
// only the cue vocabulary, never action or need IDs. Cues fade in and out, so nothing pops.

/** How far each cue is shown, 0–1, eased in and out over time. */
export interface CueWeights {
  eating: number;
  sleeping: number;
  hungry: number;
}

/** Seconds a cue takes to fade fully in or out. */
const FADE_SECONDS: CueWeights = { eating: 0.4, sleeping: 1.2, hungry: 0.5 };

/** Moves `weights` towards the cues in `cues` by `dt` seconds of fading. Mutates and returns it. */
export function stepCueWeights(weights: CueWeights, cues: readonly Cue[], dt: number): CueWeights {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  for (const cue of ["eating", "sleeping", "hungry"] as const) {
    const target = cues.includes(cue) ? 1 : 0;
    const delta = step / FADE_SECONDS[cue];
    const current = weights[cue];
    weights[cue] =
      target > current ? Math.min(target, current + delta) : Math.max(target, current - delta);
  }
  return weights;
}

/** Smoothstep: eases a linear 0–1 weight so a cue starts and ends softly. */
export const ease = (w: number) => {
  const t = Math.min(1, Math.max(0, w));
  return t * t * (3 - 2 * t);
};

/** A stable 0–1 phase per creature, so neighbours don't bob or breathe in step. */
export function cuePhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 2 ** 32;
}

const TAU = 2 * Math.PI;
const EAT_PERIOD = 0.9;
/** Eating lifts the body by up to this share of its height... */
const EAT_LIFT = 0.04;
/** ...and dips its front by up to this many radians, like a peck. */
const EAT_PITCH = 0.12;
/** Sleeping lowers the body's top by this share of its height. */
const SLEEP_LOWER = 0.1;
const BREATH_PERIOD = 4;
/** Breathing swells the sleeping body's height by up to this share. */
const BREATH = 0.025;

/** How a creature's body is posed for its cues, relative to its plain pose. */
export interface BodyMotion {
  /** Rise of the feet, as a share of the body's height. */
  lift: number;
  /** Forward tilt in radians; positive dips the drawing's front (+X). */
  pitch: number;
  /** Vertical scale of the body. */
  scaleY: number;
  /** Horizontal scale of the body. */
  scaleXZ: number;
}

export const restingMotion = (): BodyMotion => ({ lift: 0, pitch: 0, scaleY: 1, scaleXZ: 1 });

/**
 * The body's motion at `time` seconds for these weights. Writes into `out` and returns it, so the
 * frame loop allocates nothing. Bounded: |lift| ≤ 0.04, |pitch| ≤ 0.12, scaleY in [0.875, 1].
 */
export function bodyMotion(
  weights: CueWeights,
  time: number,
  phase: number,
  out: BodyMotion,
): BodyMotion {
  const eating = ease(weights.eating);
  const sleeping = ease(weights.sleeping);
  // A bob from rest up and back (0–1), so the feet never sink below the ground.
  const bob = 0.5 - 0.5 * Math.cos(TAU * (time / EAT_PERIOD + phase));
  // A breath in and out (−1–1).
  const breath = Math.sin(TAU * (time / BREATH_PERIOD + phase));
  out.lift = eating * EAT_LIFT * bob;
  out.pitch = eating * EAT_PITCH * bob;
  out.scaleY = 1 - sleeping * (SLEEP_LOWER + BREATH * (0.5 - 0.5 * breath));
  out.scaleXZ = 1 + sleeping * BREATH * 0.4 * (0.5 + 0.5 * breath);
  return out;
}

/** How many z's rise from a sleeping creature at once, and how long each takes. */
export const Z_COUNT = 3;
const Z_PERIOD = 3.6;

/** One rising z, in units of its own full size. */
export interface ZMotion {
  /** Up from the top of the head. */
  rise: number;
  /** Sideways, to the right on screen. */
  drift: number;
  scale: number;
  /** Before the sleeping weight. */
  opacity: number;
}

export const restingZ = (): ZMotion => ({ rise: 0, drift: 0, scale: 0, opacity: 0 });

/** Z number `index` of a creature with `phase` at `time` seconds. Writes into `out`. */
export function zMotion(time: number, index: number, phase: number, out: ZMotion): ZMotion {
  const p = (((time / Z_PERIOD + index / Z_COUNT + phase) % 1) + 1) % 1;
  out.rise = p * 1.8;
  out.drift = 0.35 + p * 0.6 + 0.15 * Math.sin(TAU * p);
  out.scale = 0.55 + 0.45 * p;
  out.opacity = Math.min(1, p / 0.2, (1 - p) / 0.35);
  return out;
}

const BUBBLE_PERIOD = 1.6;
/** Up-and-down of the food bubble, in units of its size; within ±0.06. */
export const bubbleBob = (time: number, phase: number) =>
  0.06 * Math.sin(TAU * (time / BUBBLE_PERIOD + phase));

/** Screen sizes in CSS pixels: a share of the creature's own height on screen, within limits. */
export const BUBBLE_PX = { share: 0.7, min: 22, max: 44 };
export const Z_PX = { share: 0.4, min: 13, max: 24 };

export const cuePixels = (limits: typeof BUBBLE_PX, creaturePx: number) =>
  Math.min(limits.max, Math.max(limits.min, limits.share * creaturePx));

/** The camera the cues are sized and turned for. */
export interface CueView {
  camera: THREE.PerspectiveCamera;
  /** The view's height in CSS pixels. */
  heightPx: number;
}

/** World units per CSS pixel at a point, for a perspective camera; for sizing in screen pixels. */
export class ScreenScale {
  /** Pointing right on screen, in world space. */
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly #position = new THREE.Vector3();
  readonly #forward = new THREE.Vector3(0, 0, -1);
  #perPixelPerMetre = 0.002;

  /** Takes the camera's current state; call once a frame before `unitsPerPixel`. */
  set({ camera, heightPx }: CueView): void {
    camera.updateMatrixWorld();
    this.#position.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.#forward);
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const fov = THREE.MathUtils.degToRad(camera.getEffectiveFOV());
    this.#perPixelPerMetre = (2 * Math.tan(fov / 2)) / Math.max(1, heightPx);
  }

  unitsPerPixel(x: number, y: number, z: number): number {
    const p = this.#position;
    const depth =
      (x - p.x) * this.#forward.x + (y - p.y) * this.#forward.y + (z - p.z) * this.#forward.z;
    return Math.max(0.01, depth) * this.#perPixelPerMetre;
  }
}

// Procedural textures, drawn from signed distances so they need no canvas (and run in tests).

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};

interface Shape {
  /** Signed distance in texture units (0–1, y up): negative inside. */
  distance(x: number, y: number): number;
  color: Rgb;
}

const circle = (cx: number, cy: number, r: number) => (x: number, y: number) =>
  Math.hypot(x - cx, y - cy) - r;
const segment =
  (ax: number, ay: number, bx: number, by: number, r: number) => (x: number, y: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(x - ax - dx * t, y - ay - dy * t) - r;
  };
const box =
  (cx: number, cy: number, hx: number, hy: number, r = 0) =>
  (x: number, y: number) => {
    const qx = Math.abs(x - cx) - hx + r;
    const qy = Math.abs(y - cy) - hy + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
const union =
  (...parts: ((x: number, y: number) => number)[]) =>
  (x: number, y: number) =>
    Math.min(...parts.map((part) => part(x, y)));
const grow = (d: (x: number, y: number) => number, by: number) => (x: number, y: number) =>
  d(x, y) - by;

/** Draws `shapes` back to front into RGBA pixels, `size` square, antialiased. */
export function rasterize(size: number, shapes: readonly Shape[]): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  // Fully transparent pixels take the first shape's colour, so filtering leaves no dark fringe.
  const [fringe] = shapes;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = (column + 0.5) / size;
      const y = (row + 0.5) / size; // DataTexture rows run bottom up, like y
      let r = fringe?.color[0] ?? 0;
      let g = fringe?.color[1] ?? 0;
      let b = fringe?.color[2] ?? 0;
      let a = 0;
      for (const shape of shapes) {
        const cover = Math.min(1, Math.max(0, 0.5 - shape.distance(x, y) * size));
        if (cover === 0) continue;
        const alpha = cover + a * (1 - cover);
        const keep = (a * (1 - cover)) / alpha;
        r = shape.color[0] * (1 - keep) + r * keep;
        g = shape.color[1] * (1 - keep) + g * keep;
        b = shape.color[2] * (1 - keep) + b * keep;
        a = alpha;
      }
      const k = (row * size + column) * 4;
      data[k] = Math.round(r * 255);
      data[k + 1] = Math.round(g * 255);
      data[k + 2] = Math.round(b * 255);
      data[k + 3] = Math.round(a * 255);
    }
  }
  return data;
}

const OUTLINE = rgb("#3a3330");

/** A speech bubble with a mushroom in it, its tail at the bottom centre. */
export function bubblePixels(size: number): Uint8Array {
  const bubble = union(circle(0.5, 0.58, 0.37), segment(0.46, 0.3, 0.42, 0.06, 0.035));
  const dome = circle(0.5, 0.5, 0.24);
  const cap = (x: number, y: number) => Math.max(dome(x, y), 0.5 - y);
  const stem = box(0.5, 0.44, 0.075, 0.11, 0.04);
  const mushroom = union(cap, stem);
  return rasterize(size, [
    { distance: grow(bubble, 0.045), color: OUTLINE },
    { distance: bubble, color: rgb("#fffaf0") },
    { distance: grow(mushroom, 0.03), color: OUTLINE },
    { distance: stem, color: rgb("#f0dfbf") },
    { distance: cap, color: rgb("#d8402f") },
    { distance: circle(0.41, 0.6, 0.04), color: rgb("#fff6e8") },
    { distance: circle(0.56, 0.66, 0.035), color: rgb("#fff6e8") },
    { distance: circle(0.6, 0.55, 0.028), color: rgb("#fff6e8") },
  ]);
}

/** A bold "z", light with a dark outline so it reads by day and by night. */
export function zPixels(size: number): Uint8Array {
  const glyph = union(
    segment(0.24, 0.78, 0.76, 0.78, 0.07),
    segment(0.76, 0.78, 0.24, 0.22, 0.07),
    segment(0.24, 0.22, 0.76, 0.22, 0.07),
  );
  return rasterize(size, [
    { distance: grow(glyph, 0.07), color: rgb("#262c45") },
    { distance: glyph, color: rgb("#eef3ff") },
  ]);
}

const texture = (data: Uint8Array, size: number) => {
  const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearMipmapLinearFilter;
  map.generateMipmaps = true;
  map.needsUpdate = true;
  return map;
};

/** Cue sprites draw over everything: a bubble behind a tree would say nothing. */
const CUE_RENDER_ORDER = 10;

/** Sprites of one look, reused as cues come and go. */
class SpritePool {
  readonly #free: THREE.Sprite[] = [];
  readonly #all: THREE.Sprite[] = [];
  readonly #parent: THREE.Object3D;
  readonly #map: THREE.Texture;
  readonly #center: THREE.Vector2;
  readonly #name: string;

  constructor(parent: THREE.Object3D, map: THREE.Texture, center: THREE.Vector2, name: string) {
    this.#parent = parent;
    this.#map = map;
    this.#center = center;
    this.#name = name;
  }

  acquire(): THREE.Sprite {
    const reused = this.#free.pop();
    if (reused) {
      reused.visible = true;
      return reused;
    }
    // Unlit, so a cue reads the same at night; its own material for its own opacity.
    const material = new THREE.SpriteMaterial({
      map: this.#map,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.name = this.#name;
    sprite.center.copy(this.#center);
    sprite.renderOrder = CUE_RENDER_ORDER;
    this.#parent.add(sprite);
    this.#all.push(sprite);
    return sprite;
  }

  release(sprite: THREE.Sprite): void {
    sprite.visible = false;
    this.#free.push(sprite);
  }

  /** Sprites in use. */
  get active(): number {
    return this.#all.length - this.#free.length;
  }

  dispose(): void {
    for (const sprite of this.#all) {
      sprite.removeFromParent();
      sprite.material.dispose();
    }
    this.#all.length = 0;
    this.#free.length = 0;
  }
}

/** One creature's cue sprites. */
export interface CreatureCueSprites {
  bubble: THREE.Sprite | undefined;
  zs: THREE.Sprite[];
}

export const noCueSprites = (): CreatureCueSprites => ({ bubble: undefined, zs: [] });

/** Where a creature's sprites go this frame. */
export interface CueAnchor {
  /** The top of the creature's head, in world space. */
  top: THREE.Vector3;
  /** The creature's height on screen, in CSS pixels. */
  creaturePx: number;
  /** World units per CSS pixel at the creature. */
  unitsPerPixel: number;
  /** Pointing right on screen. */
  right: THREE.Vector3;
}

/** Below this weight a cue's sprites go back to the pool. */
const HIDDEN = 0.001;
const GAP_PX = 3;

/** The z's and food bubbles of every creature, pooled and drawn over the scene. */
export class CueSprites {
  readonly group = new THREE.Group();
  readonly #bubbleMap = texture(bubblePixels(128), 128);
  readonly #zMap = texture(zPixels(64), 64);
  readonly #bubbles = new SpritePool(
    this.group,
    this.#bubbleMap,
    new THREE.Vector2(0.5, 0),
    "cue:bubble",
  );
  readonly #zs = new SpritePool(this.group, this.#zMap, new THREE.Vector2(0.5, 0), "cue:z");
  readonly #z = restingZ();

  constructor() {
    this.group.name = "cues";
  }

  /** Shows `sprites` for a creature with these weights at `time` seconds. */
  place(
    sprites: CreatureCueSprites,
    weights: CueWeights,
    anchor: CueAnchor,
    time: number,
    phase: number,
  ): void {
    const { top, right, unitsPerPixel } = anchor;
    const gap = GAP_PX * unitsPerPixel;

    const sleeping = ease(weights.sleeping);
    if (sleeping > HIDDEN) {
      while (sprites.zs.length < Z_COUNT) sprites.zs.push(this.#zs.acquire());
      const size = cuePixels(Z_PX, anchor.creaturePx) * unitsPerPixel;
      let index = 0;
      for (const sprite of sprites.zs) {
        const z = zMotion(time, index++, phase, this.#z);
        sprite.position
          .copy(top)
          .addScaledVector(right, z.drift * size)
          .setY(top.y + gap + z.rise * size);
        sprite.scale.set(size * z.scale, size * z.scale, 1);
        sprite.material.opacity = sleeping * z.opacity;
      }
    } else {
      this.#releaseZs(sprites);
    }

    const hungry = ease(weights.hungry);
    if (hungry > HIDDEN) {
      sprites.bubble ??= this.#bubbles.acquire();
      const size = cuePixels(BUBBLE_PX, anchor.creaturePx) * unitsPerPixel;
      // Grows in as it fades in; steps left while z's rise to the right.
      const scale = size * (0.6 + 0.4 * hungry);
      sprites.bubble.position
        .copy(top)
        .addScaledVector(right, -0.45 * size * sleeping)
        .setY(top.y + gap + bubbleBob(time, phase) * size);
      sprites.bubble.scale.set(scale, scale, 1);
      sprites.bubble.material.opacity = hungry;
    } else if (sprites.bubble) {
      this.#bubbles.release(sprites.bubble);
      sprites.bubble = undefined;
    }
  }

  /** Hands a creature's sprites back, e.g. when it leaves. */
  release(sprites: CreatureCueSprites): void {
    this.#releaseZs(sprites);
    if (sprites.bubble) this.#bubbles.release(sprites.bubble);
    sprites.bubble = undefined;
  }

  /** Sprites in use. */
  get active(): number {
    return this.#bubbles.active + this.#zs.active;
  }

  dispose(): void {
    this.#bubbles.dispose();
    this.#zs.dispose();
    this.#bubbleMap.dispose();
    this.#zMap.dispose();
    this.group.removeFromParent();
  }

  #releaseZs(sprites: CreatureCueSprites): void {
    for (const sprite of sprites.zs) this.#zs.release(sprite);
    sprites.zs.length = 0;
  }
}
