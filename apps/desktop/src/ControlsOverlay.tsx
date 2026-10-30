import type { ReactNode } from "react";

export interface ControlsOverlayProps {
  paused: boolean;
  expanded: boolean;
  fullScreen: boolean;
  debug: boolean;
  editing: boolean;
  onTogglePaused(): void;
  onToggleExpanded(): void;
  onResetCamera(): void;
  onToggleDebug(): void;
  onToggleFullScreen(): void;
  onHide(): void;
  onOpenStudio(): void;
  onToggleEditing(): void;
}

/**
 * Icon buttons in the top-right corner that fade in while the pointer is over the window (ADR 0008
 * §11), and the Creation Studio (ADR 0015 §1). The strip never takes keyboard focus, so these are
 * its only controls besides the tray. The normal window has Full screen where the strip has Hide,
 * since minimizing hides it (ADR 0016 §7); Collapse stays where Expand was. Edit props turns the
 * prop editor's Edit mode on and off (ADR 0021 §12).
 */
export function ControlsOverlay(props: ControlsOverlayProps) {
  return (
    <div className="controls">
      <ControlButton label="Creation Studio" onClick={props.onOpenStudio}>
        <path className="stroke" d="M3 13l1-3.5 7-7 2.5 2.5-7 7zM9.5 4l2.5 2.5" />
      </ControlButton>
      <ControlButton
        label={props.editing ? "Stop editing props" : "Edit props"}
        pressed={props.editing}
        onClick={props.onToggleEditing}
      >
        <path
          className="stroke"
          d="M8 2v12M2 8h12M8 2L6.5 3.5M8 2l1.5 1.5M8 14l-1.5-1.5M8 14l1.5-1.5M2 8l1.5-1.5M2 8l1.5 1.5M14 8l-1.5-1.5M14 8l-1.5 1.5"
        />
      </ControlButton>
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
      {props.expanded ? (
        <ControlButton
          label={props.fullScreen ? "Leave full screen" : "Full screen"}
          onClick={props.onToggleFullScreen}
        >
          {props.fullScreen ? (
            <path className="stroke" d="M6 2.5V6H2.5M10 2.5V6h3.5M13.5 10H10v3.5M2.5 10H6v3.5" />
          ) : (
            <path className="stroke" d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
          )}
        </ControlButton>
      ) : (
        <ControlButton label="Hide" onClick={props.onHide}>
          <path className="stroke" d="M3.5 6l4.5 4.5 4.5-4.5" />
        </ControlButton>
      )}
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
