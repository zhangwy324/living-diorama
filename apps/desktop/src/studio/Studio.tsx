import { SIZE_CLASSES, type SizeClass } from "@living-diorama/content-schema";
import {
  connectLibraryStore,
  connectStudioWindow,
  openStudioChannel,
} from "@living-diorama/desktop-integration";
import { checkBody, createBodyPreview, type BodyPreview } from "@living-diorama/renderer";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LibrarySnapshot, StudioRequests, StudioSpecies } from "../studio-protocol";
import { CloseDialog } from "./CloseDialog";
import { CreatureDetails, DEFAULT_SIZE_CLASS, defaultName } from "./CreatureDetails";
import { DeleteDialog } from "./DeleteDialog";
import { DrawingEditor, type EditorState } from "./editor";
import { drawingHints, limitHints } from "./hints";
import type { Brush } from "./live-stroke";
import { MyCreatures } from "./MyCreatures";
import { canRelease, describeFailure, keptMessage, releasedMessage } from "./release";
import { Thumbnails } from "./thumbnails";

// The Creation Studio's page (ADR 0015). It never starts a simulation and never creates a
// DesktopShell, so the shell's events and quit_ready stay the strip's.

const studioWindow = connectStudioWindow();
const channel = openStudioChannel<StudioRequests, LibrarySnapshot>();
const libraryStore = connectLibraryStore();

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

/** The preview and the drawing hints follow the drawing this long after it last changed. */
const REBUILD_DELAY_MS = 200;

/** How long "… is off into the world!" stays. */
const CELEBRATION_MS = 4000;

export function Studio() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const editor = useRef<DrawingEditor>(undefined);
  const [state, setState] = useState<EditorState>({ canUndo: false, canRedo: false, empty: true });
  const [tool, setTool] = useState<Brush["tool"]>("pen");
  const [color, setColor] = useState(PALETTE[0] ?? "#000000");
  const [width, setWidth] = useState(BRUSH_WIDTHS[1] ?? 10);
  const [closing, setClosing] = useState(false);
  const previewBox = useRef<HTMLDivElement>(null);
  const preview = useRef<BodyPreview>(undefined);
  const [sizeClass, setSizeClass] = useState<SizeClass>(DEFAULT_SIZE_CLASS);
  // Undefined until the player types one, so the default follows the library.
  const [name, setName] = useState<string>();
  const [library, setLibrary] = useState<LibrarySnapshot>();
  const speciesInLibrary = library?.species.length;
  const [shapeHints, setShapeHints] = useState<string[]>(["Nothing drawn yet."]);
  const [sizeHints, setSizeHints] = useState<string[]>([]);
  const sizeHintCache = useRef(new Map<SizeClass, string[]>());
  // Made once per drawing and kept while it is unchanged, so retrying a release whose answer was
  // lost can't save it twice (ADR 0015 §5).
  const releaseId = useRef<string>(undefined);
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string>();
  const [celebration, setCelebration] = useState<{ text: string; happy: boolean }>();
  const [listOpen, setListOpen] = useState(true);
  const [busySpecies, setBusySpecies] = useState<string>();
  const [listMessage, setListMessage] = useState<string>();
  const [deleting, setDeleting] = useState<StudioSpecies>();
  const [, setThumbnailsLoaded] = useState(0);
  const thumbnails = useRef<Thumbnails>(undefined);

  // The preview's WebGL context lives only while the Studio is open (ADR 0015 §7).
  useEffect(() => {
    const element = previewBox.current;
    if (!element) return;
    let created: BodyPreview;
    try {
      created = createBodyPreview(element);
    } catch (error) {
      // Drawing works without it; the hints still come.
      console.warn("The preview could not start", error);
      return;
    }
    preview.current = created;
    return () => {
      created.dispose();
      preview.current = undefined;
    };
  }, []);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // A short while after the drawing changes, never during a stroke, so drawing stays smooth.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rebuild = () => {
      timer = undefined;
      const current = editor.current;
      if (!current) return;
      const pixels = current.pixels();
      const check = checkBody(pixels);
      preview.current?.setDrawing(check.empty ? undefined : pixels, check);
      setShapeHints(drawingHints(check));
    };
    const created = new DrawingEditor(
      element,
      (next) => {
        setState(next);
        releaseId.current = undefined;
        setReleaseError(undefined);
        clearTimeout(timer);
        timer = setTimeout(rebuild, REBUILD_DELAY_MS);
      },
      (stroking) => {
        preview.current?.setPaused(stroking);
        if (stroking) clearTimeout(timer);
      },
    );
    editor.current = created;
    return () => {
      clearTimeout(timer);
      created.dispose();
      editor.current = undefined;
    };
  }, []);

  useEffect(() => preview.current?.setHeight(SIZE_CLASSES[sizeClass].height), [sizeClass]);

  // The size's limits in the world follow the size picker (ADR 0015 §8). The world doesn't change
  // while the app runs, so each size is asked about once.
  useEffect(() => {
    const cached = sizeHintCache.current.get(sizeClass);
    setSizeHints(cached ?? []);
    if (cached) return;
    let current = true;
    channel
      .request("limits", { sizeClass })
      .then((limits) => {
        const hints = limitHints(limits);
        sizeHintCache.current.set(sizeClass, hints);
        if (current) setSizeHints(hints);
      })
      .catch((error: unknown) =>
        console.warn(`Could not check the limits for ${sizeClass}`, error),
      );
    return () => {
      current = false;
    };
  }, [sizeClass]);

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
    const created = new Thumbnails({
      load: (libraryId) => libraryStore.loadImage(libraryId),
      onChange: () => setThumbnailsLoaded((n) => n + 1),
    });
    thumbnails.current = created;
    const keep = (snapshot: LibrarySnapshot) => {
      created.sync(snapshot.species);
      setLibrary(snapshot);
    };
    const stop = channel.onLibraryChanged(keep);
    channel
      .request("snapshot", undefined)
      .then(keep)
      .catch((error: unknown) => console.warn("Could not read the species library", error));
    return () => {
      stop();
      created.dispose();
      thumbnails.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!celebration) return;
    const timer = setTimeout(() => setCelebration(undefined), CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [celebration]);

  const shownName = name ?? (speciesInLibrary === undefined ? "" : defaultName(speciesInLibrary));
  const releasable = canRelease({ name: shownName, empty: state.empty, releasing });

  const release = async () => {
    const current = editor.current;
    if (!current || !releasable) return;
    setReleasing(true);
    setReleaseError(undefined);
    setCelebration(undefined);
    releaseId.current ??= crypto.randomUUID();
    const drawing = current.drawing;
    try {
      const released = await channel.request("release", {
        releaseId: releaseId.current,
        drawing,
        image: Array.from(await current.png()),
        name: shownName,
        sizeClass,
      });
      // A fresh start for the next one.
      current.reset();
      releaseId.current = undefined;
      setName(undefined);
      setSizeClass(DEFAULT_SIZE_CLASS);
      setCelebration(
        released.notAdded === undefined
          ? { text: releasedMessage(released.name), happy: true }
          : { text: keptMessage(released.name, released.notAdded), happy: false },
      );
    } catch (error) {
      // The drawing stays, so the player can try again.
      setReleaseError(describeFailure(error));
    } finally {
      setReleasing(false);
    }
  };

  /** Runs a My creatures request, one species at a time, saying what went wrong if it fails. */
  const ask = (speciesId: string, request: () => Promise<unknown>) => {
    setBusySpecies(speciesId);
    setListMessage(undefined);
    request()
      .catch((error: unknown) => setListMessage(describeFailure(error)))
      .finally(() => setBusySpecies(undefined));
  };

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
      <div className="workspace">
        <div className={releasing ? "sheet-area releasing" : "sheet-area"}>
          <div className="sheet">
            <canvas ref={canvas} className="drawing" />
            {/* Not part of the drawing: the body's feet are the bottom of what is drawn. */}
            <div className="guide" aria-hidden="true">
              <span>facing right →, feet on this line</span>
            </div>
          </div>
        </div>
        <aside className="side-panel">
          <div ref={previewBox} className="preview" aria-label="3D preview" role="img" />
          <CreatureDetails
            name={shownName}
            placeholder="Creature"
            onName={(next) => {
              releaseId.current = undefined;
              setName(next);
            }}
            sizeClass={sizeClass}
            onSizeClass={(next) => {
              releaseId.current = undefined;
              setSizeClass(next);
            }}
            hints={[...shapeHints, ...sizeHints]}
          />
          <div className="release-slot">
            {releaseError && (
              <p className="release-error" role="alert">
                {releaseError}
              </p>
            )}
            <button
              type="button"
              className="release"
              disabled={!releasable}
              aria-busy={releasing}
              title={shownName.trim() === "" ? "Give your creature a name first" : undefined}
              onClick={() => void release()}
            >
              {releasing ? "Releasing…" : "Release"}
            </button>
          </div>
        </aside>
        <MyCreatures
          library={library}
          thumbnail={(speciesId) => thumbnails.current?.get(speciesId)}
          open={listOpen}
          onToggle={() => setListOpen(!listOpen)}
          busy={busySpecies}
          message={listMessage}
          onAdd={(speciesId) => ask(speciesId, () => channel.request("addCreature", { speciesId }))}
          onRemove={(speciesId) =>
            ask(speciesId, () => channel.request("removeCreature", { speciesId }))
          }
          onDelete={setDeleting}
        />
      </div>
      {celebration && (
        <div
          key={celebration.text}
          className={celebration.happy ? "celebration" : "celebration quiet"}
          role="status"
        >
          {celebration.happy && <span className="sparkles" aria-hidden="true" />}
          {celebration.text}
        </div>
      )}
      {deleting && (
        <DeleteDialog
          name={deleting.name}
          inWorld={deleting.inWorld}
          onDelete={() => {
            const { speciesId } = deleting;
            setDeleting(undefined);
            ask(speciesId, () => channel.request("deleteSpecies", { speciesId }));
          }}
          onCancel={() => setDeleting(undefined)}
        />
      )}
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
