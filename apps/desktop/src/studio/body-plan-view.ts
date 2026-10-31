import type { BodyShape, LandGait } from "@living-diorama/content-schema";
import {
  animationProfile,
  locomotionSubmersion,
  type LocomotionRule,
} from "@living-diorama/extension-api";
import type { PreviewMotion } from "@living-diorama/renderer";
import {
  LAND_CAPABILITY,
  SPEED_FACTOR,
  SWIM_CAPABILITY,
  type LocomotionChoice,
} from "../body-plan";
import { USER_SPECIES_DEFAULTS } from "../startup";

// The confirm panel's words and small rules (ADR 0020 §12): what each gait is called and which
// ways of moving the preview plays.

export const GAIT_LABELS: Readonly<Record<LandGait, string>> = { walk: "Walks", hop: "Hops" };

/** What the preview says it plays for each gait. */
export const GAIT_PREVIEW_LABELS: Readonly<Record<LandGait, string>> = {
  walk: "Walking",
  hop: "Hopping",
};

/** The preview moves at a player's creature's pace: its base speed times its speed factor. */
export const PREVIEW_SPEED = USER_SPECIES_DEFAULTS.baseSpeed * SPEED_FACTOR;

/** The panel's heading: the reveal names the creature when it has a name. */
export const planHeading = (name: string) =>
  name.trim() === "" ? "How does it move?" : `How does ${name.trim()} move?`;

/** One way of moving the preview can play. */
export interface PreviewMode {
  key: "land" | "swim";
  label: string;
  /** Undefined until the world has said how its capability moves: the preview stands still. */
  motion: PreviewMotion | undefined;
}

/**
 * The ways of moving the preview plays, land first, each as its capability's locomotion rule in
 * `rules` says for a species with `body` (issue #136): the rule's animation profile and
 * submersion, as in the diorama. A way of moving whose rule hasn't come yet has no motion.
 */
export function previewModes(
  { land, gait, swim }: LocomotionChoice,
  body: BodyShape,
  rules: Readonly<Record<string, LocomotionRule>>,
): PreviewMode[] {
  const motion = (capability: string): PreviewMotion | undefined => {
    const rule = rules[capability];
    return (
      rule && {
        profile: animationProfile(rule, body),
        submersion: locomotionSubmersion(rule),
        speed: PREVIEW_SPEED,
      }
    );
  };
  return [
    ...(land
      ? [
          {
            key: "land" as const,
            label: GAIT_PREVIEW_LABELS[gait],
            motion: motion(LAND_CAPABILITY),
          },
        ]
      : []),
    ...(swim ? [{ key: "swim" as const, label: "Swimming", motion: motion(SWIM_CAPABILITY) }] : []),
  ];
}

/** The mode to play: the one picked if it is still offered, else the first. */
export const chosenMode = (modes: readonly PreviewMode[], key: PreviewMode["key"] | undefined) =>
  modes.find((mode) => mode.key === key) ?? modes[0];
