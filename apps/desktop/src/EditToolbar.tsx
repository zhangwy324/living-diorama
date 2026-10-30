import type { PropSummary } from "@living-diorama/simulation";
import type { ReactNode } from "react";
import { aProp } from "./prop-drawer";
import type { EditorState } from "./prop-editor";

export interface EditToolbarProps {
  state: EditorState;
  /** The registered prop types, by ID, to name the one being placed. */
  propTypes: Record<string, PropSummary>;
  onToggleDrawer(): void;
  onRotate(direction: 1 | -1): void;
  onDelete(): void;
  onUndo(): void;
  onRedo(): void;
}

/**
 * Edit mode's toolbar in the top-left corner (ADR 0021 §12): the prop drawer's toggle, then turn,
 * delete, undo and redo, with a line below saying what a click does now, or what the last edit
 * was refused for or warned about. Every key has a button here too. The prop types to add are in
 * the drawer (PR 7b).
 */
export function EditToolbar({ state, propTypes, ...props }: EditToolbarProps) {
  const selected = state.selected !== undefined;
  const placing = state.placing === undefined ? undefined : propTypes[state.placing];
  return (
    <div className="editor">
      <div className="editor-toolbar" role="toolbar" aria-label="Edit props">
        <ToolButton
          label={state.drawerOpen ? "Hide the props drawer" : "Show the props drawer"}
          pressed={state.drawerOpen}
          onClick={props.onToggleDrawer}
        >
          <path className="stroke" d="M2.5 3.5h11v9h-11zM9.5 3.5v9M11 6h1M11 8h1M11 10h1" />
        </ToolButton>
        <ToolButton
          label="Turn left (R)"
          disabled={!selected && !placing}
          onClick={() => props.onRotate(1)}
        >
          <path className="stroke" d="M4 6.5a4.5 4.5 0 1 1 0 4M4 2.5v4h4" />
        </ToolButton>
        <ToolButton
          label="Turn right (Shift+R)"
          disabled={!selected && !placing}
          onClick={() => props.onRotate(-1)}
        >
          <path className="stroke" d="M12 6.5a4.5 4.5 0 1 0 0 4M12 2.5v4H8" />
        </ToolButton>
        <ToolButton label="Delete (Del)" disabled={!selected} onClick={props.onDelete}>
          <path className="stroke" d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
        </ToolButton>
        <ToolButton label="Undo (Ctrl+Z)" disabled={!state.canUndo} onClick={props.onUndo}>
          <path className="stroke" d="M5.5 3L2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H7" />
        </ToolButton>
        <ToolButton label="Redo (Ctrl+Y)" disabled={!state.canRedo} onClick={props.onRedo}>
          <path className="stroke" d="M10.5 3l3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8H9" />
        </ToolButton>
      </div>
      <p
        className={`editor-line${state.notice ? ` editor-${state.notice.kind}` : ""}`}
        role="status"
      >
        {state.notice?.text ?? hint(state, placing)}
      </p>
    </div>
  );
}

/** What a click does now. */
function hint(state: EditorState, placing: PropSummary | undefined): string {
  if (placing && state.placingDrag) {
    return `Release over the ground to place ${aProp(placing.name)}`;
  }
  if (placing) return `Click the ground to place ${aProp(placing.name)}`;
  if (state.selected !== undefined) return "Drag it to move, scroll to scale";
  return state.drawerOpen
    ? "Click a prop to select it, or drag one in from the drawer"
    : "Click a prop to select it";
}

function ToolButton(props: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        {props.children}
      </svg>
    </button>
  );
}
