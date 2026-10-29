import {
  DRAWING_SIZE,
  type Anchor,
  type AnchorName,
  type LandGait,
} from "@living-diorama/content-schema";
import type { PreviewMotion } from "@living-diorama/renderer";
import { SWIM_SUBMERSION } from "@living-diorama/simulation";
import {
  DRAWN_SPEED_FACTOR,
  planAnchors,
  type BodyPlanChoice,
  type LocomotionChoice,
} from "../body-plan";
import { DRAWN_SPECIES_DEFAULTS } from "../startup";

// The confirm panel's words and small rules (ADR 0020 §12): what each gait and anchor is called,
// which ways of moving the preview plays, and placing anchors by clicking the drawing.

export const GAIT_LABELS: Readonly<Record<LandGait, string>> = { walk: "Walks", hop: "Hops" };

/** What the preview says it plays for each gait. */
export const GAIT_PREVIEW_LABELS: Readonly<Record<LandGait, string>> = {
  walk: "Walking",
  hop: "Hopping",
};

/** The preview moves at a drawn creature's pace: its base speed times a speed factor of 1. */
export const PREVIEW_SPEED = DRAWN_SPECIES_DEFAULTS.baseSpeed * DRAWN_SPEED_FACTOR;

export const ANCHOR_LABELS: Readonly<Record<AnchorName, { name: string; help: string }>> = {
  centerOfGravity: {
    name: "Center of gravity",
    help: "where the body balances. Only left–right matters; it's what the body rocks and squashes around",
  },
  tail: { name: "Tail", help: "the end that swishes as it swims" },
};

/** The panel's heading: the reveal names the creature when it has a name. */
export const planHeading = (name: string) =>
  name.trim() === "" ? "How does it move?" : `How does ${name.trim()} move?`;

/** One way of moving the preview can play. */
export interface PreviewMode {
  key: "land" | "swim";
  label: string;
  motion: PreviewMotion;
}

/**
 * The ways of moving the preview plays, land first. The land gait names its profile (ADR 0020 §8:
 * each gait is a profile of the same name); swimming is `core:swim`'s `swim`, lowered by its
 * submersion.
 */
export function previewModes({ land, gait, swim }: LocomotionChoice): PreviewMode[] {
  return [
    ...(land
      ? [
          {
            key: "land" as const,
            label: GAIT_PREVIEW_LABELS[gait],
            motion: { profile: gait, submersion: 0, speed: PREVIEW_SPEED },
          },
        ]
      : []),
    ...(swim
      ? [
          {
            key: "swim" as const,
            label: "Swimming",
            motion: { profile: "swim", submersion: SWIM_SUBMERSION, speed: PREVIEW_SPEED },
          },
        ]
      : []),
  ];
}

/** The mode to play: the one picked if it is still offered, else the first. */
export const chosenMode = (modes: readonly PreviewMode[], key: PreviewMode["key"] | undefined) =>
  modes.find((mode) => mode.key === key) ?? modes[0];

/**
 * The point on the drawing under a click at (`clientX`, `clientY`) on an element showing the whole
 * drawing in `box`, in whole drawing pixels, kept on the drawing.
 */
export function drawingPoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
): Anchor {
  const pixel = (offset: number, size: number) =>
    Math.min(DRAWING_SIZE, Math.max(0, Math.round((offset / size) * DRAWING_SIZE)));
  return { x: pixel(clientX - box.left, box.width), y: pixel(clientY - box.top, box.height) };
}

/**
 * `plan` with anchor `name` placed at `point`. An anchor its ways of moving don't use is refused,
 * since the player can't see it.
 */
export function placeAnchor(plan: BodyPlanChoice, name: AnchorName, point: Anchor): BodyPlanChoice {
  if (!planAnchors(plan.locomotion).includes(name)) return plan;
  return { ...plan, anchors: { ...plan.anchors, [name]: { ...point } } };
}

/**
 * `plan` after the drawing changed: placed anchors are dropped, back to their defaults, since
 * they were placed on the old drawing (owner's call). Everything else stays. The same object when
 * nothing was placed.
 */
export const afterDrawingEdit = (plan: BodyPlanChoice): BodyPlanChoice =>
  Object.values(plan.anchors).some((anchor) => anchor !== undefined)
    ? { ...plan, anchors: {} }
    : plan;

/**
 * The anchor a click on the drawing places: the one chosen if it is still shown, else the first.
 * Undefined with no way of moving, as nothing is shown then.
 */
export const placingAnchor = (
  shown: readonly AnchorName[],
  chosen: AnchorName | undefined,
): AnchorName | undefined => (chosen !== undefined && shown.includes(chosen) ? chosen : shown[0]);

/**
 * What the anchor layer says to a screen reader: each point, placed or at its default, and which
 * one a click places.
 */
export function anchorNote(plan: BodyPlanChoice, placing: AnchorName | undefined): string {
  const points = planAnchors(plan.locomotion).map((name) =>
    plan.anchors[name]
      ? `${ANCHOR_LABELS[name].name} placed.`
      : `${ANCHOR_LABELS[name].name} not placed, so the default position is used.`,
  );
  if (placing === undefined) return points.join(" ");
  const verb = plan.anchors[placing] ? "move" : "place";
  return [...points, `Click the drawing to ${verb} the ${anchorWord(placing)}.`].join(" ");
}

/** An anchor's name in running text: "center of gravity", "tail". */
export const anchorWord = (name: AnchorName) => ANCHOR_LABELS[name].name.toLowerCase();

/**
 * `plan` with the points its ways of moving show back where `defaultAnchor` puts them. A placed
 * point hidden by a way of moving that is off is kept, so it comes back with it.
 */
export function resetAnchors(plan: BodyPlanChoice): BodyPlanChoice {
  const shown: readonly string[] = planAnchors(plan.locomotion);
  const kept = Object.entries(plan.anchors).filter(([name]) => !shown.includes(name));
  return { ...plan, anchors: Object.fromEntries(kept) };
}
