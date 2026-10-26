import type { ReactNode } from "react";

export interface ControlsOverlayProps {
  paused: boolean;
  expanded: boolean;
  debug: boolean;
  onTogglePaused(): void;
  onToggleExpanded(): void;
  onResetCamera(): void;
  onToggleDebug(): void;
  onHide(): void;
}

/**
 * Icon buttons in the top-right corner that fade in while the pointer is over the window (ADR 0008
 * §11). The strip never takes keyboard focus, so these are its only controls besides the tray.
 */
export function ControlsOverlay(props: ControlsOverlayProps) {
  return (
    <div className="controls">
      <ControlButton label={props.paused ? "Resume" : "Pause"} onClick={props.onTogglePaused}>
        {props.paused ? (
          <path d="M5 3.5v9l7-4.5z" />
        ) : (
          <path d="M4.5 3.5h2.5v9H4.5zm4.5 0h2.5v9H9z" />
        )}
      </ControlButton>
      <ControlButton
        label={props.expanded ? "Collapse" : "Expand"}
        onClick={props.onToggleExpanded}
      >
        {props.expanded ? (
          <path className="stroke" d="M2.5 6.5h4v-4M13.5 9.5h-4v4M6.5 6.5l-4-4M9.5 9.5l4 4" />
        ) : (
          <path className="stroke" d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4 4M2.5 13.5l4-4" />
        )}
      </ControlButton>
      <ControlButton label="Reset camera" onClick={props.onResetCamera}>
        <path className="stroke" d="M3.5 8a4.5 4.5 0 1 0 1.3-3.2M4.5 2v3h3" />
      </ControlButton>
      <ControlButton
        label={props.debug ? "Hide debug overlays" : "Show debug overlays"}
        pressed={props.debug}
        onClick={props.onToggleDebug}
      >
        <path className="stroke" d="M2.5 2.5h11v11h-11zM2.5 8h11M8 2.5v11" />
      </ControlButton>
      <ControlButton label="Hide" onClick={props.onHide}>
        <path className="stroke" d="M3.5 6l4.5 4.5 4.5-4.5" />
      </ControlButton>
    </div>
  );
}

function ControlButton(props: {
  label: string;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        {props.children}
      </svg>
    </button>
  );
}
