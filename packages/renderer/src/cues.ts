import type { Cue } from "@living-diorama/simulation";
import * as THREE from "three";

// What a creature visibly shows (ADR 0018 §15): a gentle bob and a filling ring while eating, a
// lowered, slowly breathing body with rising z's while sleeping, and a food bubble while hungry. The renderer knows
// only the cue vocabulary, never action or need IDs. Cues fade in and out, so nothing pops.

/** How far each cue is shown, 0–1, eased in and out over time. */
export interface CueWeights {
  eating: number;
  sleeping: number;
  hungry: number;
}

/** Seconds a cue takes to fade fully in or out. */
const FADE_SECONDS: CueWeights = { eating: 0.4, sleeping: 1.2, hungry: 0.5 };

const CUE_NAMES = ["eating", "sleeping", "hungry"] as const;
/**
 * A longer gap between frames (the page was hidden, the PC slept) shows cues as they are now
 * instead of slowly fading out ones long gone.
 */
export const SNAP_SECONDS = 1;

/**
 * Moves `weights` towards the cues in `cues` by `dt` seconds of fading, or straight to them after a
 * gap longer than `SNAP_SECONDS`. Mutates and returns it.
 */
export function stepCueWeights(weights: CueWeights, cues: readonly Cue[], dt: number): CueWeights {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  for (const cue of CUE_NAMES) {
    const target = cues.includes(cue) ? 1 : 0;
    const delta = step > SNAP_SECONDS ? 1 : step / FADE_SECONDS[cue];
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
  /**
   * Forward tilt in radians about the feet; positive dips the drawing's front (+X). Lift the body
   * by `frontLift` so its front doesn't sink into the ground.
   */
  pitch: number;
  /** Vertical scale of the body. */
  scaleY: number;
  /** Horizontal scale of the body. */
  scaleXZ: number;
}

/** How far to lift a body whose front reaches `front` metres ahead of its feet, tilted by `pitch`. */
export const frontLift = (front: number, pitch: number) => Math.max(0, front * Math.sin(pitch));

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

/** At most this many z's rise from a sleeping creature at once... */
export const Z_COUNT = 3;
/** ...and this many when they are small on screen, so they don't run together. */
export const Z_COUNT_SMALL = 2;
/** ...and one when its z's overlap an earlier sleeper's on screen (`layoutCues`). */
export const Z_COUNT_THIN = 1;
/** Seconds each z takes to rise and fade. */
export const Z_PERIOD = 3.6;
/** Each z leans by this much, alternately left and right, like hand lettering (radians, ~9°). */
export const Z_TILT = 0.16;

/** One rising z, in units of its own full size. */
export interface ZMotion {
  /** Up from the top of the head. */
  rise: number;
  /** Sideways, to the right on screen. */
  drift: number;
  scale: number;
  /** Counterclockwise lean in radians. */
  tilt: number;
  /** Before the sleeping weight. */
  opacity: number;
}

export const restingZ = (): ZMotion => ({ rise: 0, drift: 0, scale: 0, tilt: 0, opacity: 0 });

/**
 * The z numbered `serial` (counting the creature's z's as they start) at `p`, 0–1 through its
 * rise. It starts small and quickly, then slows as it grows and fades (an ease-out); every other
 * z leans the other way. Writes into `out`.
 */
export function zAt(p: number, serial: number, out: ZMotion): ZMotion {
  const t = Math.min(1, Math.max(0, p));
  const eased = 1 - (1 - t) ** 2;
  out.rise = eased * 1.8;
  out.drift = 0.35 + eased * 0.6 + 0.12 * Math.sin(TAU * t);
  out.scale = 0.45 + 0.55 * eased;
  out.tilt = serial % 2 === 0 ? Z_TILT : -Z_TILT;
  out.opacity = Math.min(1, t / 0.2, (1 - t) / 0.35);
  return out;
}

/** Z's smaller than this on screen rise two at a time instead of three... */
const Z_SMALL_PX = 18;
/** ...give or take this much, so a size near the line doesn't flip the count back and forth. */
const Z_HYSTERESIS_PX = 1;

/**
 * How many z's should rise for a z this many CSS pixels tall, given the `previous` target. The
 * count only aims the stream: a change takes effect as the next z starts.
 */
export function zTarget(zPx: number, previous?: number): number {
  if (zPx < Z_SMALL_PX - Z_HYSTERESIS_PX) return Z_COUNT_SMALL;
  if (zPx > Z_SMALL_PX + Z_HYSTERESIS_PX) return Z_COUNT;
  return previous ?? (zPx < Z_SMALL_PX ? Z_COUNT_SMALL : Z_COUNT);
}

const BUBBLE_PERIOD = 1.6;
/** Up-and-down of the food bubble, in units of its size; within ±0.06. */
export const bubbleBob = (time: number, phase: number) =>
  0.06 * Math.sin(TAU * (time / BUBBLE_PERIOD + phase));

/** Screen sizes in CSS pixels: a share of the creature's own height on screen, within limits. */
export const BUBBLE_PX = { share: 0.7, min: 26, max: 44 };
export const Z_PX = { share: 0.4, min: 15, max: 24 };
export const RING_PX = { share: 0.5, min: 16, max: 30 };

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
  /** Pointing up on screen, in world space. */
  readonly up = new THREE.Vector3(0, 1, 0);
  /** The camera's position, in world space. */
  readonly position = new THREE.Vector3();
  readonly #forward = new THREE.Vector3(0, 0, -1);
  readonly #ndc = new THREE.Vector3();
  #perPixelPerMetre = 0.002;
  #camera: THREE.Camera | undefined;
  #halfWidth = 0.5;
  #halfHeight = 0.5;

  /** Takes the camera's current state; call once a frame before `unitsPerPixel`. */
  set({ camera, heightPx }: CueView): void {
    camera.updateMatrixWorld();
    this.position.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.#forward);
    this.right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    this.up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    const fov = THREE.MathUtils.degToRad(camera.getEffectiveFOV());
    this.#perPixelPerMetre = (2 * Math.tan(fov / 2)) / Math.max(1, heightPx);
    this.#camera = camera;
    this.#halfHeight = Math.max(1, heightPx) / 2;
    this.#halfWidth = this.#halfHeight * camera.aspect;
  }

  /**
   * Where `point` is on screen, in CSS pixels from the centre with y up, written into `out`.
   * False, leaving `out` as it was, for a point behind the camera or before the first `set`.
   */
  project(point: THREE.Vector3, out: THREE.Vector3): boolean {
    const camera = this.#camera;
    if (!camera) return false;
    const ndc = this.#ndc.copy(point).project(camera);
    if (!(ndc.z < 1)) return false;
    out.set(ndc.x * this.#halfWidth, ndc.y * this.#halfHeight, 0);
    return true;
  }

  unitsPerPixel(x: number, y: number, z: number): number {
    const p = this.position;
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

/** Unions two distances with a rounded fillet of radius `k` where they meet. */
const smoothUnion =
  (a: (x: number, y: number) => number, b: (x: number, y: number) => number, k: number) =>
  (x: number, y: number) => {
    const da = a(x, y);
    const db = b(x, y);
    const h = Math.min(1, Math.max(0, 0.5 + (0.5 * (db - da)) / k));
    return db + (da - db) * h - k * h * (1 - h);
  };
/** Signed distance to the triangle a, b, c. */
const triangle = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => {
  const edges = union(
    segment(ax, ay, bx, by, 0),
    segment(bx, by, cx, cy, 0),
    segment(cx, cy, ax, ay, 0),
  );
  return (x: number, y: number) => {
    const edge = edges(x, y);
    const side = (px: number, py: number, qx: number, qy: number) =>
      (qx - px) * (y - py) - (qy - py) * (x - px);
    const s1 = side(ax, ay, bx, by);
    const s2 = side(bx, by, cx, cy);
    const s3 = side(cx, cy, ax, ay);
    const inside = (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
    return inside ? -edge : edge;
  };
};

const OUTLINE = rgb("#3a3330");

/**
 * The picture inside a cue bubble: shapes drawn back to front, in their own square from −1 to 1
 * (y up), with distances in those units. The bubble fits it into its round body.
 */
export type CueIcon = readonly Shape[];

const fruit = union(circle(-0.2, -0.12, 0.56), circle(0.2, -0.12, 0.56));
const stem = segment(0, 0.3, 0.12, 0.72, 0.08);
// A leaf as two circles' overlap, leaning up to the right from the stem.
const leaf = (x: number, y: number) =>
  Math.max(circle(0.3, 0.42, 0.36)(x, y), circle(0.55, 0.85, 0.36)(x, y));

/**
 * Food in general: a round red fruit with a stem and a leaf. It stands for every food, so it
 * says "hungry" whether the creature eats mushrooms or berries from a bush. A bubble shows it
 * until the creature heads for food whose picture is drawn, then that picture instead (#110).
 */
export const FOOD_ICON: CueIcon = [
  { distance: grow(union(fruit, stem, leaf), 0.13), color: OUTLINE },
  { distance: stem, color: rgb("#6b4a2b") },
  { distance: leaf, color: rgb("#5aa83c") },
  { distance: fruit, color: rgb("#d8402f") },
  { distance: circle(-0.3, 0.05, 0.13), color: rgb("#fff6e8") },
];

/** The bubble's round body, its outline's width and where its icon goes (texture units). */
const BUBBLE = { x: 0.5, y: 0.6, radius: 0.31, outline: 0.08, icon: 0.23 };
/**
 * A prop's picture in the bubble (`PropIcons`) is this share of the bubble's width, centred in
 * its round body: the width of its round body, as a model rarely fills the corners of its square.
 */
export const PROP_ICON_SHARE = 0.62;
/** The prop picture's sprite centre, so it sits on the bubble's round body (issue #110). */
const PROP_ICON_CENTER = new THREE.Vector2(0.5, 0.5 - BUBBLE.y / PROP_ICON_SHARE);

/**
 * A round speech bubble with `icon` in it and a short tail at the bottom centre. The outline is
 * about 2 CSS px at the bubble's smallest size.
 */
export function bubblePixels(size: number, icon: CueIcon = FOOD_ICON): Uint8Array {
  const { x: cx, y: cy, radius, outline } = BUBBLE;
  const tail = grow(
    triangle(cx - 0.1, cy - radius + 0.06, cx + 0.1, cy - radius + 0.06, cx, 0.13),
    0.01,
  );
  const bubble = smoothUnion(circle(cx, cy, radius), tail, 0.05);
  const scale = BUBBLE.icon;
  const placed = icon.map(({ distance, color }): Shape => ({
    distance: (x, y) => distance((x - cx) / scale, (y - cy) / scale) * scale,
    color,
  }));
  return rasterize(size, [
    { distance: grow(bubble, outline), color: OUTLINE },
    { distance: bubble, color: rgb("#fffaf0") },
    ...placed,
  ]);
}

/** A z's two colours: dark on light by day, light on dark at night, so it stands out from the scene. */
export const Z_COLORS = {
  day: { fill: "#262c45", outline: "#f4f6ff" },
  night: { fill: "#eef3ff", outline: "#1d2236" },
} as const;

/** A bold "z" with a thick outline, in the day or night colours. */
export function zPixels(size: number, night = false): Uint8Array {
  const { fill, outline } = night ? Z_COLORS.night : Z_COLORS.day;
  const glyph = union(
    segment(0.26, 0.76, 0.74, 0.76, 0.075),
    segment(0.74, 0.76, 0.26, 0.24, 0.075),
    segment(0.26, 0.24, 0.74, 0.24, 0.075),
  );
  return rasterize(size, [
    { distance: grow(glyph, 0.1), color: rgb(outline) },
    { distance: glyph, color: rgb(fill) },
  ]);
}

/** The progress ring is drawn in this many steps, each a texture of its own. */
export const RING_STEPS = 32;

/**
 * The ring texture step, 0–`RING_STEPS`, for a progress of 0–1, rounded down: the ring is full only
 * at progress 1, which a meal never reports, as it ends then.
 */
export function ringStep(progress: number): number {
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  return Math.floor(p * RING_STEPS);
}

/**
 * Signed distance to the wedge that sweeps clockwise from 12 o'clock round `share` of a full turn
 * about (cx, cy): the distance to its nearer edge. Exact enough for antialiasing.
 */
const wedge = (cx: number, cy: number, share: number) => (x: number, y: number) => {
  if (share <= 0) return 1;
  if (share >= 1) return -1;
  const dx = x - cx;
  const dy = y - cy;
  const radius = Math.hypot(dx, dy);
  const angle = (Math.atan2(dx, dy) + TAU) % TAU; // clockwise from up
  const end = share * TAU;
  const toEdge = (edge: number) => {
    const apart = Math.abs(((((angle - edge + Math.PI) % TAU) + TAU) % TAU) - Math.PI);
    return apart < Math.PI / 2 ? radius * Math.sin(apart) : radius;
  };
  const d = Math.min(toEdge(0), toEdge(end));
  return angle <= end ? -d : d;
};

const RING_FILL = rgb("#f2a531");

/**
 * A progress ring filled clockwise from the top by `progress` (0–1): an amber arc over a cream
 * track, with a dark outline so it reads by day and by night. Clear inside and around it.
 */
export function ringPixels(size: number, progress: number): Uint8Array {
  const band = (x: number, y: number) => Math.abs(Math.hypot(x - 0.5, y - 0.5) - 0.28) - 0.11;
  const sweep = wedge(0.5, 0.5, progress);
  return rasterize(size, [
    { distance: grow(band, 0.09), color: OUTLINE },
    { distance: band, color: rgb("#fffaf0") },
    { distance: (x, y) => Math.max(band(x, y), sweep(x, y)), color: RING_FILL },
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

/** Where the sprite shader samples its texture, to bias it towards a sharper mipmap. */
export const MAP_SAMPLE = "texture2D( map, vMapUv )";
/**
 * Cues are mostly seen at their smallest, a few times smaller than their textures, where the
 * mipmaps blend in a level too blurry for their outlines. Sampling this many levels finer keeps
 * them crisp; the textures are smooth shapes, so it doesn't shimmer.
 */
export const MIP_BIAS = -0.75;

/** Makes a cue material sample its texture sharper (`MIP_BIAS`); all cues share one program. */
export function sharpen(material: THREE.SpriteMaterial): THREE.SpriteMaterial {
  material.onBeforeCompile = sampleSharper;
  material.customProgramCacheKey = sharpKey;
  return material;
}

function sampleSharper(shader: THREE.WebGLProgramParametersWithUniforms): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <map_fragment>",
    THREE.ShaderChunk.map_fragment.replace(
      MAP_SAMPLE,
      `texture2D( map, vMapUv, ${MIP_BIAS.toFixed(2)} )`,
    ),
  );
}

const sharpKey = () => "cue-sharp";

/** Where the sprite shader encodes its colour for the screen, after which it is blended. */
export const COLORSPACE_FRAGMENT = "#include <colorspace_fragment>";

/**
 * Makes a sharpened cue material (`sharpen`) draw a texture whose colour is premultiplied by its
 * alpha, such as a prop's picture, and fade it with `opacity`. Blending premultiplied takes the
 * colour as it is, and three's sprite shader doesn't scale it by `opacity`: a picture fading or
 * dimmed by `CueVisibility` would only grow see-through, keeping its full colour on top. So this
 * scales the colour by `opacity` too, after it is encoded for the screen, where blending happens.
 */
export function premultiplied(material: THREE.SpriteMaterial): THREE.SpriteMaterial {
  sharpen(material);
  material.premultipliedAlpha = true;
  material.onBeforeCompile = sampleSharperPremultiplied;
  material.customProgramCacheKey = premultipliedKey;
  return material;
}

function sampleSharperPremultiplied(shader: THREE.WebGLProgramParametersWithUniforms): void {
  sampleSharper(shader);
  shader.fragmentShader = shader.fragmentShader.replace(
    COLORSPACE_FRAGMENT,
    `${COLORSPACE_FRAGMENT}
	gl_FragColor.rgb *= opacity;`,
  );
}

const premultipliedKey = () => "cue-sharp-premultiplied";

/**
 * Cue sprites draw over the scene: a bubble behind a tree would say nothing. A creature hidden by
 * the terrain or a structure fades its cues out instead (`CueVisibility`). Below the debug
 * overlays (10–11) and creature labels (12), so with debug on its readouts stay on top.
 */
const CUE_RENDER_ORDER = 9;
/** A prop's picture draws over its bubble. */
const ICON_RENDER_ORDER = CUE_RENDER_ORDER + 0.5;

/** Sprites of one look, reused as cues come and go. */
class SpritePool {
  readonly #free: THREE.Sprite[] = [];
  readonly #all: THREE.Sprite[] = [];
  readonly #parent: THREE.Object3D;
  readonly #map: THREE.Texture;
  readonly #center: THREE.Vector2;
  readonly #name: string;
  readonly #renderOrder: number;
  readonly #premultipliedAlpha: boolean;

  constructor(
    parent: THREE.Object3D,
    map: THREE.Texture,
    center: THREE.Vector2,
    name: string,
    { renderOrder = CUE_RENDER_ORDER, premultipliedAlpha = false } = {},
  ) {
    this.#parent = parent;
    this.#map = map;
    this.#center = center;
    this.#name = name;
    this.#renderOrder = renderOrder;
    this.#premultipliedAlpha = premultipliedAlpha;
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
    if (this.#premultipliedAlpha) premultiplied(material);
    else sharpen(material);
    const sprite = new THREE.Sprite(material);
    sprite.name = this.#name;
    sprite.center.copy(this.#center);
    sprite.renderOrder = this.#renderOrder;
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
  /** The picture of the prop the creature heads for, over its bubble (issue #110). */
  icon: THREE.Sprite | undefined;
  ring: THREE.Sprite | undefined;
  /** The rising z's, oldest first. */
  zs: THREE.Sprite[];
  /** When each z started rising, in animation seconds, and its serial number (for its lean). */
  zStarts: number[];
  zSerials: number[];
  /**
   * How many z's should rise at once (`zTarget`). It sets the gap before the next z starts, so a
   * change never cuts a z short or moves one mid-rise.
   */
  zTarget: number | undefined;
  /** The target for the z's size alone, kept for its hysteresis; thinning may lower `zTarget`. */
  zSizeTarget: number | undefined;
  /** When the next z starts, or undefined while no z's rise. */
  zNext: number | undefined;
  /** The next z's serial number. */
  zSerial: number;
}

export const noCueSprites = (): CreatureCueSprites => ({
  bubble: undefined,
  icon: undefined,
  ring: undefined,
  zs: [],
  zStarts: [],
  zSerials: [],
  zTarget: undefined,
  zSizeTarget: undefined,
  zNext: undefined,
  zSerial: 0,
});

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
  /**
   * How far the creature is in view for its cues, 0–1 (`CueVisibility`): multiplies every cue's
   * opacity, and the sprites go back to the pool when it is 0.
   */
  visible: number;
  /**
   * How far the bubble and ring move, in world space, to keep clear of other creatures' cues
   * (`layoutCues`).
   */
  shift: THREE.Vector3;
  /** Whether this sleeper's z's are thinned, as they overlap another's on screen (`layoutCues`). */
  zThin: boolean;
}

/** Ring textures are this many pixels square. */
const RING_SIZE = 64;

/** Below this weight a cue's sprites go back to the pool. */
const HIDDEN = 0.001;
/** Cues sit this many CSS pixels above the head. */
export const CUE_GAP_PX = 3;

/** The z's, food bubbles and progress rings of every creature, pooled and drawn over the scene. */
export class CueSprites {
  readonly group = new THREE.Group();
  /**
   * Night look for the z's: light on dark instead of dark on light. A z takes the new look only
   * as it starts its next rise, so a change at dusk or dawn rolls through without a pop.
   */
  night = false;
  /**
   * A hook for a future reduced-motion setting, not wired to one yet: z's stand still in a
   * stack and the bubble doesn't bob.
   */
  reducedMotion = false;
  readonly #bubbleMap = texture(bubblePixels(128), 128);
  /** The bubble without its icon, behind a prop's picture. */
  readonly #plainBubbleMap = texture(bubblePixels(128, []), 128);
  readonly #zMaps = { day: texture(zPixels(64), 64), night: texture(zPixels(64, true), 64) };
  readonly #bubbles = new SpritePool(
    this.group,
    this.#bubbleMap,
    new THREE.Vector2(0.5, 0),
    "cue:bubble",
  );
  readonly #zs = new SpritePool(this.group, this.#zMaps.day, new THREE.Vector2(0.5, 0), "cue:z");
  // Prop pictures are drawn on a clear background, so their colour is premultiplied by their
  // alpha; `premultiplied` fades that colour with the opacity too.
  readonly #icons = new SpritePool(this.group, this.#plainBubbleMap, PROP_ICON_CENTER, "cue:icon", {
    renderOrder: ICON_RENDER_ORDER,
    premultipliedAlpha: true,
  });
  /** Ring textures by step, drawn when first needed. */
  readonly #ringMaps: (THREE.DataTexture | undefined)[] = [];
  readonly #rings = new SpritePool(
    this.group,
    this.#ringMap(0),
    new THREE.Vector2(0.5, 0),
    "cue:ring",
  );
  readonly #z = restingZ();

  constructor() {
    this.group.name = "cues";
  }

  /**
   * Shows `sprites` for a creature with these weights at `time` seconds. `progress` is how far
   * through its meal an eating creature is, 0–1, or undefined for no ring. `icon` is the picture
   * of the prop it heads for, shown in its bubble in place of the neutral food icon (issue #110).
   */
  place(
    sprites: CreatureCueSprites,
    weights: CueWeights,
    anchor: CueAnchor,
    time: number,
    phase: number,
    progress?: number,
    icon?: THREE.Texture,
  ): void {
    const { top, right, unitsPerPixel, visible, shift } = anchor;
    const gap = CUE_GAP_PX * unitsPerPixel;

    const sleeping = ease(weights.sleeping);
    if (sleeping * visible > HIDDEN) {
      const zPx = cuePixels(Z_PX, anchor.creaturePx);
      sprites.zSizeTarget = zTarget(zPx, sprites.zSizeTarget);
      sprites.zTarget = anchor.zThin
        ? Math.min(Z_COUNT_THIN, sprites.zSizeTarget)
        : sprites.zSizeTarget;
      if (this.reducedMotion) this.#holdZs(sprites);
      else this.#streamZs(sprites, time, phase);
      const size = zPx * unitsPerPixel;
      const count = sprites.zs.length;
      let k = 0;
      for (const sprite of sprites.zs) {
        const serial = sprites.zSerials[k] ?? k;
        const z = this.reducedMotion
          ? zAt((count - k - 0.5) / count, serial, this.#z)
          : zAt((time - (sprites.zStarts[k] ?? time)) / Z_PERIOD, serial, this.#z);
        sprite.position
          .copy(top)
          .addScaledVector(right, z.drift * size)
          .setY(top.y + gap + z.rise * size);
        sprite.scale.set(size * z.scale, size * z.scale, 1);
        sprite.material.rotation = z.tilt;
        sprite.material.opacity = sleeping * z.opacity * visible;
        k++;
      }
    } else {
      this.#releaseZs(sprites);
    }

    // A meal answers the hunger: the bubble fades out as eating fades in, and back after it.
    const hungry = ease(weights.hungry) * (1 - ease(weights.eating));
    if (hungry * visible > HIDDEN) {
      sprites.bubble ??= this.#bubbles.acquire();
      const size = cuePixels(BUBBLE_PX, anchor.creaturePx) * unitsPerPixel;
      // Grows in as it fades in; steps left while z's rise to the right.
      const scale = size * (0.6 + 0.4 * hungry);
      sprites.bubble.position
        .copy(top)
        .addScaledVector(right, -0.45 * size * sleeping)
        .setY(top.y + gap + (this.reducedMotion ? 0 : bubbleBob(time, phase)) * size);
      sprites.bubble.position.add(shift);
      sprites.bubble.scale.set(scale, scale, 1);
      sprites.bubble.material.opacity = hungry * visible;
      sprites.bubble.material.map = icon ? this.#plainBubbleMap : this.#bubbleMap;
      if (icon) {
        sprites.icon ??= this.#icons.acquire();
        sprites.icon.position.copy(sprites.bubble.position);
        sprites.icon.scale.set(scale * PROP_ICON_SHARE, scale * PROP_ICON_SHARE, 1);
        sprites.icon.material.map = icon;
        sprites.icon.material.opacity = hungry * visible;
      } else {
        this.#releaseIcon(sprites);
      }
    } else if (sprites.bubble) {
      this.#bubbles.release(sprites.bubble);
      sprites.bubble = undefined;
      this.#releaseIcon(sprites);
    }

    // Where the bubble was, a ring fills over the meal; it grows in as eating fades in.
    const eating = ease(weights.eating);
    if (eating * visible > HIDDEN && progress !== undefined) {
      sprites.ring ??= this.#rings.acquire();
      const size = cuePixels(RING_PX, anchor.creaturePx) * unitsPerPixel;
      const scale = size * (0.6 + 0.4 * eating);
      sprites.ring.position.copy(top).setY(top.y + gap);
      sprites.ring.position.add(shift);
      sprites.ring.scale.set(scale, scale, 1);
      sprites.ring.material.map = this.#ringMap(ringStep(progress));
      sprites.ring.material.opacity = eating * visible;
    } else if (sprites.ring) {
      this.#rings.release(sprites.ring);
      sprites.ring = undefined;
    }
  }

  /** Hands a creature's sprites back, e.g. when it leaves. */
  release(sprites: CreatureCueSprites): void {
    this.#releaseZs(sprites);
    if (sprites.bubble) this.#bubbles.release(sprites.bubble);
    sprites.bubble = undefined;
    this.#releaseIcon(sprites);
    if (sprites.ring) this.#rings.release(sprites.ring);
    sprites.ring = undefined;
  }

  /** Sprites in use. */
  get active(): number {
    return this.#bubbles.active + this.#icons.active + this.#zs.active + this.#rings.active;
  }

  dispose(): void {
    this.#bubbles.dispose();
    this.#icons.dispose();
    this.#zs.dispose();
    this.#rings.dispose();
    this.#bubbleMap.dispose();
    this.#plainBubbleMap.dispose();
    this.#zMaps.day.dispose();
    this.#zMaps.night.dispose();
    for (const map of this.#ringMaps) map?.dispose();
    this.#ringMaps.length = 0;
    this.group.removeFromParent();
  }

  #ringMap(step: number): THREE.DataTexture {
    let map = this.#ringMaps[step];
    if (!map) {
      map = texture(ringPixels(RING_SIZE, step / RING_STEPS), RING_SIZE);
      this.#ringMaps[step] = map;
    }
    return map;
  }

  #releaseIcon(sprites: CreatureCueSprites): void {
    if (sprites.icon) this.#icons.release(sprites.icon);
    sprites.icon = undefined;
  }

  #releaseZs(sprites: CreatureCueSprites): void {
    for (const sprite of sprites.zs) this.#zs.release(sprite);
    sprites.zs.length = 0;
    sprites.zStarts.length = 0;
    sprites.zSerials.length = 0;
    sprites.zNext = undefined;
  }

  /** Starts a z at `start`, in the current day or night look, which it keeps all its rise. */
  #startZ(sprites: CreatureCueSprites, start: number): void {
    const sprite = this.#zs.acquire();
    sprite.material.map = this.night ? this.#zMaps.night : this.#zMaps.day;
    sprites.zs.push(sprite);
    sprites.zStarts.push(start);
    sprites.zSerials.push(sprites.zSerial++);
  }

  /**
   * Keeps z's rising one after another, `Z_PERIOD / zTarget` apart, each for `Z_PERIOD`. A new
   * target only changes the gap before the next z, so the count follows it smoothly. The first
   * z's start as if they had been rising for a while, staggered by the creature's phase.
   */
  #streamZs(sprites: CreatureCueSprites, time: number, phase: number): void {
    const target = sprites.zTarget ?? Z_COUNT;
    const latest = sprites.zStarts[sprites.zStarts.length - 1];
    // Afresh when z's start, after a gap longer than a rise (a hidden page), or if time went back.
    if (
      sprites.zNext === undefined ||
      time >= sprites.zNext + Z_PERIOD ||
      (latest !== undefined && time < latest)
    ) {
      this.#releaseZs(sprites);
      const gap = Z_PERIOD / target;
      const last = time - ((((time / gap + phase * target) % 1) + 1) % 1) * gap;
      for (let k = target - 1; k >= 0; k--) this.#startZ(sprites, last - k * gap);
      sprites.zNext = last + gap;
    }
    // Hands back z's that have finished rising first, keeping the rest in order.
    let kept = 0;
    let k = 0;
    for (const sprite of sprites.zs) {
      const start = sprites.zStarts[k] ?? time;
      const serial = sprites.zSerials[k] ?? k;
      k++;
      if (time - start >= Z_PERIOD) {
        this.#zs.release(sprite);
        continue;
      }
      sprites.zs[kept] = sprite;
      sprites.zStarts[kept] = start;
      sprites.zSerials[kept] = serial;
      kept++;
    }
    sprites.zs.length = kept;
    sprites.zStarts.length = kept;
    sprites.zSerials.length = kept;
    // Then starts any z's due, reusing the sprites just handed back. Each starts after the
    // oldest one alive, so none of them has finished yet.
    while (time >= sprites.zNext) {
      this.#startZ(sprites, sprites.zNext);
      sprites.zNext += Z_PERIOD / target;
    }
  }

  /**
   * Reduced motion: a still stack of `zTarget` z's, all in the current look. Note for whoever
   * wires reduced motion: a change of target, such as thinning starting or stopping as sleepers
   * come together or part (`layoutCues`), rebuilds the stack at once, so z's pop in or out.
   */
  #holdZs(sprites: CreatureCueSprites): void {
    const target = sprites.zTarget ?? Z_COUNT;
    if (sprites.zs.length !== target || sprites.zNext !== undefined) {
      this.#releaseZs(sprites);
      for (let k = 0; k < target; k++) this.#startZ(sprites, 0);
    }
    const map = this.night ? this.#zMaps.night : this.#zMaps.day;
    for (const sprite of sprites.zs) sprite.material.map = map;
  }
}
