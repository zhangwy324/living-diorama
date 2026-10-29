import { DRAWING_SIZE, type DrawingBounds, type SizeClass } from "@living-diorama/content-schema";

// The size the Studio suggests for a drawing (issue #49). The body is always the size class's
// height whatever the drawing's own size, so how much of the canvas the drawing fills says only
// what the player had in mind: a doodle in a corner is a little thing, a drawing from edge to edge
// a big one. The player's pick always wins over the suggestion.

/**
 * How much of the canvas the drawing fills, in one dimension: the square root of its bounds'
 * share of the canvas's area, so 1 is the whole canvas and 0.5 a quarter of it. Width and height
 * count alike, so a long, low drawing isn't taken for a small one only because it is low.
 */
export const canvasFill = (bounds: DrawingBounds): number =>
  Math.sqrt(
    (Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top)) /
      (DRAWING_SIZE * DRAWING_SIZE),
  );

/**
 * The smallest fill each size class starts at, largest first. Each class is twice as tall as the
 * one below it, so the bands are about twice as wide in fill. Medium, the size the built-in world
 * is made for, gets the widest band: an ordinary drawing that fills a good part of the canvas.
 */
const FILL_THRESHOLDS: readonly (readonly [SizeClass, number])[] = [
  ["large", 0.85],
  ["medium", 0.45],
  ["small", 0.25],
  ["tiny", 0],
];

/** The size class suggested for a drawing with these bounds, or none when nothing is drawn. */
export function suggestSize(bounds: DrawingBounds | undefined): SizeClass | undefined {
  if (!bounds) return undefined;
  const fill = canvasFill(bounds);
  return FILL_THRESHOLDS.find(([, from]) => fill >= from)?.[0];
}

/** The size the Studio shows: the player's pick if they made one, else the suggestion, else `fallback`. */
export const shownSize = (
  picked: SizeClass | undefined,
  suggested: SizeClass | undefined,
  fallback: SizeClass,
): SizeClass => picked ?? suggested ?? fallback;
