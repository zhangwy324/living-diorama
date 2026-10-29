import type { AnchorName, Anchors, LandGait } from "@living-diorama/content-schema";

// A drawn species' body plan as the player chooses it in the Studio (ADR 0020 §11, §12, §14):
// where it can move, its land gait and its anchors. Shared by the Studio and the species library,
// so the panel starts from what the release will register. Kept free of content imports, like
// `startup.ts`.

/** Where a drawn species can move, and how it moves on land. */
export interface LocomotionChoice {
  /** Land movement (`core:land`). */
  land: boolean;
  /** Walk or hop. Used only with land movement, but kept while it is off, so it comes back. */
  gait: LandGait;
  /** Swimming (`core:swim`). */
  swim: boolean;
}

/** What the Studio sends with a release. */
export interface BodyPlanChoice {
  locomotion: LocomotionChoice;
  /**
   * Placed anchors, in drawing pixels; left out, an anchor sits where `defaultAnchor` puts it. One
   * whose way of moving is off is kept, so it comes back, but not released (`planBody`).
   */
  anchors: Anchors;
}

/** What a new creature starts from: on land, walking. */
export const DEFAULT_LOCOMOTION: Readonly<LocomotionChoice> = {
  land: true,
  gait: "walk",
  swim: false,
};

/** The capabilities behind each way of moving. App configuration, like `STARTUP`. */
export const LAND_CAPABILITY = "core:land";
export const SWIM_CAPABILITY = "core:swim";

/** A drawn species' speed factor for each of its capabilities (ADR 0020 §14). */
export const DRAWN_SPEED_FACTOR = 1;

/** A fresh plan: on land, walking, no anchors placed. */
export const defaultPlan = (): BodyPlanChoice => ({
  locomotion: { ...DEFAULT_LOCOMOTION },
  anchors: {},
});

/**
 * The anchors that matter for these ways of moving, land first: the center of gravity, which land
 * movement tilts and squashes about, and the tail, which sets the swim's axis.
 */
export const planAnchors = ({
  land,
  swim,
}: Pick<LocomotionChoice, "land" | "swim">): AnchorName[] => [
  ...(land ? (["centerOfGravity"] as const) : []),
  ...(swim ? (["tail"] as const) : []),
];

/** The placed anchors that matter for the plan's ways of moving, as copies. */
export function activeAnchors({ locomotion, anchors }: BodyPlanChoice): Anchors {
  const active: Anchors = {};
  for (const name of planAnchors(locomotion)) {
    const anchor = anchors[name];
    if (anchor) active[name] = { ...anchor };
  }
  return active;
}

/** At least one way of moving: on land, swimming or both (ADR 0020 §1). */
export const canMove = ({ land, swim }: Pick<LocomotionChoice, "land" | "swim">): boolean =>
  land || swim;

/** The capabilities map a drawn species registers with: a speed factor of 1 for each. */
export function locomotionCapabilities({
  land,
  swim,
}: Pick<LocomotionChoice, "land" | "swim">): Record<string, number> {
  return {
    ...(land ? { [LAND_CAPABILITY]: DRAWN_SPEED_FACTOR } : {}),
    ...(swim ? { [SWIM_CAPABILITY]: DRAWN_SPEED_FACTOR } : {}),
  };
}

/** The species' `body` for this plan and thickness (`BodyShape`'s input). */
export function planBody(plan: BodyPlanChoice, thickness: number) {
  return {
    thickness,
    locomotion: { land: { gait: plan.locomotion.gait } },
    anchors: activeAnchors(plan),
  };
}
