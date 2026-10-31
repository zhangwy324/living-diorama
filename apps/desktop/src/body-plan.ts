import type { BodyShape, LandGait } from "@living-diorama/content-schema";

// A player's species' body plan as the player chooses it in the Studio (ADR 0020 §11, §12, §14):
// where it can move and its land gait. Its cubes give its shape and anchors (ADR 0022, M19
// decisions). Shared by the Studio and the species library, so the panel starts from what the
// release will register. Kept free of content imports, like `startup.ts`.

/** Where a species can move, and how it moves on land. */
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

/** A player's species' speed factor for each of its capabilities (ADR 0020 §14). */
export const SPEED_FACTOR = 1;

/** A fresh plan: on land, walking. */
export const defaultPlan = (): BodyPlanChoice => ({ locomotion: { ...DEFAULT_LOCOMOTION } });

/** At least one way of moving: on land, swimming or both (ADR 0020 §1). */
export const canMove = ({ land, swim }: Pick<LocomotionChoice, "land" | "swim">): boolean =>
  land || swim;

/** The capabilities map a player's species registers with: a speed factor of 1 for each. */
export function locomotionCapabilities({
  land,
  swim,
}: Pick<LocomotionChoice, "land" | "swim">): Record<string, number> {
  return {
    ...(land ? { [LAND_CAPABILITY]: SPEED_FACTOR } : {}),
    ...(swim ? { [SWIM_CAPABILITY]: SPEED_FACTOR } : {}),
  };
}

/**
 * A voxel species' `body` for this plan: its gait only, since its cubes give its shape and anchors
 * (ADR 0022, M19 decisions).
 */
export const planVoxelBody = ({ locomotion }: BodyPlanChoice): BodyShape => ({
  locomotion: { land: { gait: locomotion.gait } },
});
