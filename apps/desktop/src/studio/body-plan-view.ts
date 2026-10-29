import {
  DRAWING_SIZE,
  type Anchor,
  type AnchorName,
  type BodyTemplate,
  type LandGait,
} from "@living-diorama/content-schema";
import type { PreviewMotion } from "@living-diorama/renderer";
import { SWIM_SUBMERSION } from "@living-diorama/simulation";
import {
  DRAWN_SPEED_FACTOR,
  templateAnchors,
  type BodyPlanChoice,
  type LocomotionChoice,
} from "../body-plan";
import { DRAWN_SPECIES_DEFAULTS } from "../startup";

// The confirm panel's words and small rules (ADR 0020 §12): what each template, gait and anchor is
// called, which ways of moving the preview plays, and placing anchors by clicking the drawing.

export const TEMPLATE_LABELS: Readonly<Record<BodyTemplate, { name: string; blurb: string }>> = {
  walker: { name: "Walker", blurb: "Walks on its feet" },
  hopper: { name: "Hopper", blurb: "Bounces along" },
  swimmer: { name: "Swimmer", blurb: "Lives in the water" },
};

export const GAIT_LABELS: Readonly<Record<LandGait, string>> = { walk: "Walks", hop: "Hops" };

/** What the preview says it plays for each gait. */
export const GAIT_PREVIEW_LABELS: Readonly<Record<LandGait, string>> = {
  walk: "Walking",
  hop: "Hopping",
};

/** The preview moves at a drawn creature's pace: its base speed times a speed factor of 1. */
export const PREVIEW_SPEED = DRAWN_SPECIES_DEFAULTS.baseSpeed * DRAWN_SPEED_FACTOR;

export const ANCHOR_LABELS: Readonly<
  Record<AnchorName, { name: string; help: string; them: string }>
> = {
  feet: { name: "Feet", help: "where it stands and steps from", them: "them" },
  tail: { name: "Tail", help: "the end that swishes as it swims", them: "it" },
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

/** `plan` with its template's anchor `name` placed at `point`. Other templates' anchors are refused. */
export function placeAnchor(plan: BodyPlanChoice, name: AnchorName, point: Anchor): BodyPlanChoice {
  if (!templateAnchors(plan.template).includes(name)) return plan;
  return { ...plan, anchors: { ...plan.anchors, [name]: { ...point } } };
}

/**
 * `plan` after the drawing changed: placed anchors are dropped, back to their defaults, since
 * they were placed on the old drawing (owner's call). Everything else stays. The same object when
 * nothing was placed.
 */
export const afterDrawingEdit = (plan: BodyPlanChoice): BodyPlanChoice =>
  Object.values(plan.anchors).some((anchor) => anchor !== undefined) ? resetAnchors(plan) : plan;

/** What the anchor layer says to a screen reader: each point, placed or at its default. */
export function anchorNote(plan: BodyPlanChoice): string {
  const anchors = templateAnchors(plan.template);
  if (anchors.length === 0) return "A hopper has no points to place.";
  return anchors
    .map((name) => {
      const { name: label, them } = ANCHOR_LABELS[name];
      return plan.anchors[name]
        ? `${label} placed. Click the drawing to move ${them}.`
        : `${label} not placed, so the default position is used. Click the drawing to place ${them}.`;
    })
    .join(" ");
}

/** `plan` with every anchor back where `defaultAnchor` puts it. */
export const resetAnchors = (plan: BodyPlanChoice): BodyPlanChoice => ({ ...plan, anchors: {} });
