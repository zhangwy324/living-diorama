import { STUDIO_MODES, type StudioMode } from "./modes";

export const MODE_LABELS: Readonly<Record<StudioMode, string>> = { build: "Build", draw: "Draw" };

/** The switch between the Studio's modes, at the start of each mode's toolbar (ADR 0023 §1). */
export function ModeSwitch(props: { mode: StudioMode; onMode(mode: StudioMode): void }) {
  return (
    <div className="tool-group mode-switch" role="group" aria-label="Mode">
      {STUDIO_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={props.mode === mode}
          onClick={() => props.onMode(mode)}
        >
          {MODE_LABELS[mode]}
        </button>
      ))}
    </div>
  );
}
