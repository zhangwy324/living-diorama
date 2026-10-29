import {
  BODY_TEMPLATE_ANCHORS,
  type AnchorName,
  type Anchors,
  type BodyTemplate,
  type LandGait,
} from "@living-diorama/content-schema";

// A drawn species' body plan as the player chooses it in the Studio (ADR 0020 §11, §12, §14):
// its template, where it can move, its land gait and its anchors. The one app-owned map from a
// template to its default locomotion lives here, shared by the Studio and the species library, so
// the panel starts from what the release will register. Kept free of content imports, like
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
  template: BodyTemplate;
  locomotion: LocomotionChoice;
  /** Placed anchors, in drawing pixels; left out, an anchor sits where `defaultAnchor` puts it. */
  anchors: Anchors;
}

/** What each template starts from (ADR 0020 §11). The player can change it afterwards. */
export const TEMPLATE_LOCOMOTION: Readonly<Record<BodyTemplate, Readonly<LocomotionChoice>>> = {
  walker: { land: true, gait: "walk", swim: false },
  hopper: { land: true, gait: "hop", swim: false },
  swimmer: { land: false, gait: "walk", swim: true },
};

/** The capabilities behind each way of moving. App configuration, like `STARTUP`. */
export const LAND_CAPABILITY = "core:land";
export const SWIM_CAPABILITY = "core:swim";

/** A drawn species' speed factor for each of its capabilities (ADR 0020 §14). */
export const DRAWN_SPEED_FACTOR = 1;

/** A fresh plan for `template`: its locomotion and no anchors placed. */
export const templatePlan = (template: BodyTemplate = "walker"): BodyPlanChoice => ({
  template,
  locomotion: { ...TEMPLATE_LOCOMOTION[template] },
  anchors: {},
});

/** The anchors `template` has (walker: feet, swimmer: tail, hopper: none). */
export const templateAnchors = (template: BodyTemplate): readonly AnchorName[] =>
  BODY_TEMPLATE_ANCHORS[template];

/**
 * Switches `plan` to `template`: its default locomotion, and only the placed anchors the new
 * template also has, so the release passes validation (ADR 0020 §10). A fresh object.
 */
export function changeTemplate(plan: BodyPlanChoice, template: BodyTemplate): BodyPlanChoice {
  const allowed = templateAnchors(template);
  const anchors: Anchors = {};
  for (const name of allowed) {
    const anchor = plan.anchors[name];
    if (anchor) anchors[name] = { ...anchor };
  }
  return { template, locomotion: { ...TEMPLATE_LOCOMOTION[template] }, anchors };
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
export function planBody({ template, locomotion, anchors }: BodyPlanChoice, thickness: number) {
  return {
    thickness,
    template,
    locomotion: { land: { gait: locomotion.gait } },
    anchors: structuredClone(anchors),
  };
}
