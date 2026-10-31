import type { ReactNode } from "react";
import type { LibrarySnapshot, Released } from "../studio-protocol";
import type { AskLimits } from "./limits";

/**
 * The Studio's modes (ADR 0023 §1): Build assembles a voxel creature. Draw mode, which drew a
 * creature, went with drawn bodies; it comes back to draw parts (M23).
 */
export type StudioMode = "build";

/** Every mode, in the order the mode switch shows them. */
export const STUDIO_MODES: readonly StudioMode[] = ["build"];

/** What the Studio gives each of its modes. All stay mounted; those not shown are hidden. */
export interface ModeProps {
  /** Whether this mode is shown. */
  active: boolean;
  /** Whether its keyboard shortcuts work: shown, with no dialog open. */
  keysEnabled: boolean;
  /** The strip's library, for name suggestions; undefined until it answers. */
  library: LibrarySnapshot | undefined;
  /** The switch between modes, for the mode's toolbar. */
  modeSwitch: ReactNode;
  askLimits: AskLimits;
  /** A release is on its way: the Studio stops saying the last one went. */
  onReleaseStart(): void;
  /** A creature was released: the Studio says so. */
  onReleased(released: Released): void;
  /** Whether closing now would lose something not released (ADR 0015 §10, ADR 0023 §21). */
  onUnsaved(unsaved: boolean): void;
}
