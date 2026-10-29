import type { BodyCheck } from "@living-diorama/renderer";

// The preview's "Show warnings" toggle (issue #141). The preview shows the creature as it will
// look; the toggle tints the parts the hints warn about. The hints themselves always show.

/** Whether the check found parts to tint: thin parts or shapes that aren't joined. */
export const hasWarningTint = (check: BodyCheck) => check.thinParts > 0 || check.shapes > 1;

/**
 * Off by default, and disabled while there is nothing to tint; it then reads as off, whatever
 * was chosen before.
 */
export function WarningToggle(props: { available: boolean; shown: boolean; onToggle(): void }) {
  return (
    <button
      type="button"
      className="warning-toggle"
      title={props.available ? undefined : "No warnings to show"}
      aria-pressed={props.available && props.shown}
      disabled={!props.available}
      onClick={props.onToggle}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
        <circle cx="8" cy="8" r="2" />
      </svg>
      Show warnings
    </button>
  );
}
