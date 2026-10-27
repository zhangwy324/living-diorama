import { connectStudioWindow, openStudioChannel } from "@living-diorama/desktop-integration";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LibrarySnapshot, StudioRequests } from "../studio-protocol";
import { CloseDialog } from "./CloseDialog";
import { DrawingEditor, type EditorState } from "./editor";
import type { Brush } from "./live-stroke";

// The Creation Studio's page (ADR 0015). It never starts a simulation and never creates a
// DesktopShell, so the shell's events and quit_ready stay the strip's.

const studioWindow = connectStudioWindow();
const channel = openStudioChannel<StudioRequests, LibrarySnapshot>();

export const PALETTE = [
  "#1e2a14",
  "#ffffff",
  "#8a8f86",
  "#7a4a2a",
  "#c8433a",
  "#e8892f",
  "#f2cf3c",
  "#5a8f3c",
  "#3c7fc2",
  "#8a56b5",
  "#f0a6c0",
];

/** Brush widths in canvas units at full pressure. */
export const BRUSH_WIDTHS = [4, 10, 20, 40];

/** The eraser's colour is stored but never drawn. */
const ERASER_COLOR = "#000000";

export function Studio() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const editor = useRef<DrawingEditor>(undefined);
  const [state, setState] = useState<EditorState>({ canUndo: false, canRedo: false, empty: true });
  const [tool, setTool] = useState<Brush["tool"]>("pen");
  const [color, setColor] = useState(PALETTE[0] ?? "#000000");
  const [width, setWidth] = useState(BRUSH_WIDTHS[1] ?? 10);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const created = new DrawingEditor(element, setState);
    editor.current = created;
    return () => {
      created.dispose();
      editor.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (editor.current) {
      editor.current.brush = { tool, color: tool === "eraser" ? ERASER_COLOR : color, width };
    }
  }, [tool, color, width]);

  // Closing with something drawn asks first (ADR 0015 §10).
  useEffect(
    () =>
      studioWindow.onCloseRequested(() => {
        if (editor.current?.state.empty ?? true) return true;
        setClosing(true);
        return false;
      }),
    [],
  );

  // The Studio is focusable, unlike the strip, so it has keyboard shortcuts. Not while asking.
  useEffect(() => {
    if (closing) return;
    const onKey = (event: KeyboardEvent) => {
      const current = editor.current;
      if (!current || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) current.undo();
      else if (key === "y" || (key === "z" && event.shiftKey)) current.redo();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closing]);

  // The library lives in the strip's window: ask for it now, then hear about every change.
  useEffect(() => {
    let library: LibrarySnapshot | undefined;
    const keep = (snapshot: LibrarySnapshot) => (library = snapshot);
    const stop = channel.onLibraryChanged(keep);
    channel
      .request("snapshot", undefined)
      .then(keep)
      .catch((error: unknown) => console.warn("Could not read the species library", error));
    // Until the Studio shows the library (PR 4), development builds reach it from the console.
    if (import.meta.env.DEV) {
      window.livingDiorama = { ...window.livingDiorama, studio: { library: () => library } };
    }
    return stop;
  }, []);

  return (
    <div className="studio">
      <div className="toolbar" role="toolbar" aria-label="Drawing tools">
        <div className="tool-group">
          <ToolButton label="Pen" pressed={tool === "pen"} onClick={() => setTool("pen")}>
            <path className="stroke" d="M3 13l1-3.5 7-7 2.5 2.5-7 7zM9.5 4l2.5 2.5" />
          </ToolButton>
          <ToolButton label="Eraser" pressed={tool === "eraser"} onClick={() => setTool("eraser")}>
            <path className="stroke" d="M6 13.5h7.5M2.5 10l6-6.5 5 5-5 5.5H6z" />
          </ToolButton>
        </div>
        <div className="tool-group palette">
          {PALETTE.map((swatch) => (
            <button
              key={swatch}
              type="button"
              className="swatch"
              title={swatch}
              aria-label={`Colour ${swatch}`}
              aria-pressed={tool === "pen" && color === swatch}
              style={{ background: swatch }}
              onClick={() => {
                setColor(swatch);
                setTool("pen");
              }}
            />
          ))}
        </div>
        <div className="tool-group">
          {BRUSH_WIDTHS.map((size) => (
            <ToolButton
              key={size}
              label={`Brush size ${size}`}
              pressed={width === size}
              onClick={() => setWidth(size)}
            >
              <circle cx="8" cy="8" r={1 + (size / Math.max(...BRUSH_WIDTHS)) * 5.5} />
            </ToolButton>
          ))}
        </div>
        <div className="tool-group">
          <ToolButton
            label="Undo (Ctrl+Z)"
            disabled={!state.canUndo}
            onClick={() => editor.current?.undo()}
          >
            <path className="stroke" d="M5.5 3L2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8h-3" />
          </ToolButton>
          <ToolButton
            label="Redo (Ctrl+Y)"
            disabled={!state.canRedo}
            onClick={() => editor.current?.redo()}
          >
            <path className="stroke" d="M10.5 3l3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8h3" />
          </ToolButton>
          <ToolButton label="Clear" disabled={state.empty} onClick={() => editor.current?.clear()}>
            <path className="stroke" d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
          </ToolButton>
        </div>
      </div>
      <div className="sheet-area">
        <div className="sheet">
          <canvas ref={canvas} className="drawing" />
          {/* Not part of the drawing: the body's feet are the bottom of what is drawn. */}
          <div className="guide" aria-hidden="true">
            <span>facing right →, feet on this line</span>
          </div>
        </div>
      </div>
      {closing && (
        <CloseDialog
          onDiscard={() => void studioWindow.close()}
          onCancel={() => setClosing(false)}
        />
      )}
    </div>
  );
}

function ToolButton(props: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
        {props.children}
      </svg>
    </button>
  );
}
