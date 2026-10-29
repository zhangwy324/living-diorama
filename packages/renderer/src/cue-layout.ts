import { BUBBLE_PX, CUE_GAP_PX, RING_PX, SNAP_SECONDS, Z_PX, cuePixels, ease } from "./cues";
import type { CueWeights } from "./cues";

// Keeping cues apart where creatures bunch up (issue #93, ADR 0018 as built): bubbles and rings
// that overlap on screen are pushed apart a little, and sleepers whose z's overlap let fewer of
// them rise. In CSS pixels on screen, y up, worked out each frame from where the cues would be.

/** Bubbles and rings keep at least this many pixels apart. */
export const CUE_MARGIN_PX = 2;
/** Passes of pushing pairs apart a frame; enough for a handful bunched together. */
export const LAYOUT_PASSES = 4;
/** A cue that shows less than this (faded or hidden) neither pushes nor is laid out. */
export const MIN_LAYOUT_WEIGHT = 0.05;
/** Seconds for a shift to move most of the way (about 63%) to where it is heading. */
export const SHIFT_SECONDS = 0.2;
/**
 * A sleeper's z's thin when this share of the smaller z column overlaps an earlier sleeper's,
 * and stay thin until the share falls below `THIN_EXIT`, so a sleeper near the line doesn't flip.
 */
export const THIN_ENTER = 0.3;
export const THIN_EXIT = 0.15;

/** Where a bubble's round body is, and how big, in shares of its sprite's size (see `bubblePixels`). */
const BUBBLE_BODY = { y: 0.6, radius: 0.39 };
/** The same for the progress ring (see `ringPixels`). */
const RING_BODY = { y: 0.5, radius: 0.48 };
/** A bubble steps left by this share of its size while z's rise (see `CueSprites.place`). */
const BUBBLE_STEP = 0.45;
/** Where a sleeper's z's rise, in shares of a z's size, right and up of the head's top. */
const Z_COLUMN = { left: 0.1, right: 1.5, height: 2.8 };

/** One creature's cues as the layout sees them. Kept per creature and reused every frame. */
export interface CueBox {
  /** Where its bubble's or ring's body would be, unshifted, on screen. */
  x: number;
  y: number;
  radius: number;
  /** Its full size; it never shifts further than this. */
  size: number;
  /** How far it shows, 0–1 (its fade times the creature's visibility). */
  weight: number;
  /** The rectangle its z's rise through: left and bottom edges, width and height. */
  zLeft: number;
  zBottom: number;
  zWidth: number;
  zHeight: number;
  /** How far the z's show, 0–1. */
  zWeight: number;
  /** How far the bubble or ring is shifted now, eased towards where the layout wants it. */
  shiftX: number;
  shiftY: number;
  /** Whether it was laid out last frame: one joining starts where the layout puts it. */
  active: boolean;
  /** Whether its z's are thinned because they overlap an earlier sleeper's. */
  thin: boolean;
  /** The layout's working: where this frame's layout puts it, and the current pass's push. */
  targetX: number;
  targetY: number;
  pushX: number;
  pushY: number;
}

export const emptyCueBox = (): CueBox => ({
  x: 0,
  y: 0,
  radius: 0,
  size: 0,
  weight: 0,
  zLeft: 0,
  zBottom: 0,
  zWidth: 0,
  zHeight: 0,
  zWeight: 0,
  shiftX: 0,
  shiftY: 0,
  active: false,
  thin: false,
  targetX: 0,
  targetY: 0,
  pushX: 0,
  pushY: 0,
});

/**
 * Fills in `box` for a creature whose head's top is at (`x`, `y`) on screen, `creaturePx` tall,
 * with these cue weights and `visible` (`CueVisibility`). `ring` says whether it has a meal's
 * progress to show. Mirrors where `CueSprites.place` puts the sprites, without the bob.
 */
export function describeCues(
  box: CueBox,
  weights: CueWeights,
  creaturePx: number,
  visible: number,
  ring: boolean,
  x: number,
  y: number,
): CueBox {
  const sleeping = ease(weights.sleeping);
  const eating = ring ? ease(weights.eating) : 0;
  const hungry = ease(weights.hungry) * (1 - ease(weights.eating));
  if (hungry >= eating) {
    const size = cuePixels(BUBBLE_PX, creaturePx);
    box.x = x - BUBBLE_STEP * size * sleeping;
    box.y = y + CUE_GAP_PX + BUBBLE_BODY.y * size;
    box.radius = BUBBLE_BODY.radius * size;
    box.size = size;
    box.weight = hungry * visible;
  } else {
    const size = cuePixels(RING_PX, creaturePx);
    box.x = x;
    box.y = y + CUE_GAP_PX + RING_BODY.y * size;
    box.radius = RING_BODY.radius * size;
    box.size = size;
    box.weight = eating * visible;
  }
  const z = cuePixels(Z_PX, creaturePx);
  box.zLeft = x + Z_COLUMN.left * z;
  box.zBottom = y + CUE_GAP_PX;
  box.zWidth = (Z_COLUMN.right - Z_COLUMN.left) * z;
  box.zHeight = Z_COLUMN.height * z;
  box.zWeight = sleeping * visible;
  return box;
}

/** Share of the smaller of two z columns that the other overlaps. */
function zOverlap(a: CueBox, b: CueBox): number {
  const w = Math.min(a.zLeft + a.zWidth, b.zLeft + b.zWidth) - Math.max(a.zLeft, b.zLeft);
  const h = Math.min(a.zBottom + a.zHeight, b.zBottom + b.zHeight) - Math.max(a.zBottom, b.zBottom);
  if (w <= 0 || h <= 0) return 0;
  const smaller = Math.min(a.zWidth * a.zHeight, b.zWidth * b.zHeight);
  return smaller > 0 ? (w * h) / smaller : 0;
}

/**
 * Lays out every creature's cues for a frame `dt` seconds of real time after the last, mutating
 * `boxes` and allocating nothing. Boxes come in a stable order (by creature ID), so the result
 * doesn't depend on map order and the same scene always lays out the same way.
 */
export function layoutCues(boxes: readonly CueBox[], dt: number): void {
  push(boxes);
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  const follow = step > SNAP_SECONDS ? 1 : 1 - Math.exp(-step / SHIFT_SECONDS);
  for (const box of boxes) {
    if (box.weight < MIN_LAYOUT_WEIGHT) {
      box.active = false;
      box.shiftX = 0;
      box.shiftY = 0;
      continue;
    }
    // A cue joining starts where it belongs; one already shown eases there.
    const k = box.active ? follow : 1;
    box.shiftX += (box.targetX - box.shiftX) * k;
    box.shiftY += (box.targetY - box.shiftY) * k;
    box.active = true;
  }
  thin(boxes);
}

/** Where each bubble or ring should be shifted to keep apart from the others, capped. */
function push(boxes: readonly CueBox[]): void {
  const n = boxes.length;
  for (const box of boxes) {
    box.targetX = 0;
    box.targetY = 0;
  }
  for (let pass = 0; pass < LAYOUT_PASSES; pass++) {
    for (const box of boxes) {
      box.pushX = 0;
      box.pushY = 0;
    }
    let moved = false;
    for (let i = 0; i < n; i++) {
      const a = boxes[i];
      if (!a || a.weight < MIN_LAYOUT_WEIGHT) continue;
      for (let j = i + 1; j < n; j++) {
        const b = boxes[j];
        if (!b || b.weight < MIN_LAYOUT_WEIGHT) continue;
        let dx = a.x + a.targetX - (b.x + b.targetX);
        let dy = a.y + a.targetY - (b.y + b.targetY);
        const need = a.radius + b.radius + CUE_MARGIN_PX;
        const d2 = dx * dx + dy * dy;
        if (d2 >= need * need) continue;
        let d = Math.sqrt(d2);
        // On top of each other: the earlier one goes left.
        if (d < 1e-6) {
          dx = -1;
          dy = 0;
          d = 1;
        }
        const overlap = need - d;
        // Each gives way by the other's share, so a faint cue hardly moves a clear one.
        const total = a.weight + b.weight;
        const ka = ((b.weight / total) * overlap) / d;
        const kb = ((a.weight / total) * overlap) / d;
        a.pushX += dx * ka;
        a.pushY += dy * ka;
        b.pushX -= dx * kb;
        b.pushY -= dy * kb;
        moved = true;
      }
    }
    if (!moved) break;
    for (const box of boxes) {
      let x = box.targetX + box.pushX;
      // Never down into the creature's own head.
      let y = Math.max(0, box.targetY + box.pushY);
      const length = Math.hypot(x, y);
      if (length > box.size) {
        x *= box.size / length;
        y *= box.size / length;
      }
      box.targetX = x;
      box.targetY = y;
    }
  }
}

/**
 * Thins the z's of a sleeper whose z column overlaps an earlier sleeper's, so the first keeps all
 * its z's and the rest let fewer rise. Hidden or faded sleepers don't count.
 */
function thin(boxes: readonly CueBox[]): void {
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (!a) continue;
    if (a.zWeight < MIN_LAYOUT_WEIGHT) {
      a.thin = false;
      continue;
    }
    const enough = a.thin ? THIN_EXIT : THIN_ENTER;
    let thinned = false;
    for (let j = 0; j < i && !thinned; j++) {
      const b = boxes[j];
      thinned = b !== undefined && b.zWeight >= MIN_LAYOUT_WEIGHT && zOverlap(a, b) > enough;
    }
    a.thin = thinned;
  }
}
