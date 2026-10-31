import type { PlayerPartEntry } from "@living-diorama/content-schema";
import type { ReactNode } from "react";
import type { LibrarySnapshot, Released } from "../studio-protocol";
import type { AskLimits } from "./limits";

/**
 * The Studio's modes (ADR 0023 §1, ADR 0025 §9): Build assembles a voxel creature, Draw draws a
 * part for it.
 */
export type StudioMode = "build" | "draw";

/** Every mode, in the order the mode switch shows them. */
export const STUDIO_MODES: readonly StudioMode[] = ["build", "draw"];

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

/**
 * What Draw mode opens on (ADR 0025 §9): a new drawing of a part type, e.g. from a tray section's
 * "Draw your own" tile, or a saved player part to edit in place, e.g. from My parts. Each new
 * `key` opens once.
 */
export interface DrawRequest {
  key: number;
  /** The part type of a new drawing; Draw mode's first type when neither is given. */
  partType?: string | undefined;
  /** A saved part to edit; its type wins over `partType`. */
  entry?: PlayerPartEntry | undefined;
}

/** Opens Draw mode on a new drawing or a saved part, asking first if a drawing would be lost. */
export type OpenDraw = (request: Omit<DrawRequest, "key">) => void;

/**
 * What closing the Studio would lose, by mode, said in the close dialog (ADR 0015 §10): an
 * unreleased creature, an unsaved part drawing, or both.
 */
export function closeMessage(unsaved: Readonly<Record<StudioMode, boolean>>): string {
  if (unsaved.build && unsaved.draw) {
    return "Your creature hasn't been released and your part hasn't been saved. Closing now loses them.";
  }
  if (unsaved.draw) return "Your part hasn't been saved. Closing now loses it.";
  return "Your creature hasn't been released. Closing now loses it.";
}
