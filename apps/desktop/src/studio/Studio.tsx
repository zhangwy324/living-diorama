import {
  BODY_THICKNESS,
  SIZE_CLASSES,
  type AnchorName,
  type DrawingBounds,
  type SizeClass,
} from "@living-diorama/content-schema";
import {
  connectLibraryStore,
  connectStudioWindow,
  openStudioChannel,
} from "@living-diorama/desktop-integration";
import type { LocomotionRule } from "@living-diorama/extension-api";
import { checkBody, createBodyPreview, type BodyPreview } from "@living-diorama/renderer";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  activeAnchors,
  canMove,
  defaultPlan,
  planAnchors,
  planBody,
  type BodyPlanChoice,
} from "../body-plan";
import {
  NO_LOCOMOTION,
  type LibrarySnapshot,
  type StudioRequests,
  type StudioSpecies,
} from "../studio-protocol";
import { AnchorLayer, BodyPlanPanel } from "./BodyPlanPanel";
import {
  afterDrawingEdit,
  chosenMode,
  placeAnchor,
  placingAnchor,
  previewModes,
  resetAnchors,
  type PreviewMode,
} from "./body-plan-view";
import { CloseDialog } from "./CloseDialog";
import { CreatureDetails, DEFAULT_SIZE_CLASS } from "./CreatureDetails";
import { DeleteDialog } from "./DeleteDialog";
import { DrawingEditor, type EditorState, type Tool } from "./editor";
import { drawingHints, limitHints } from "./hints";
import { MyCreatures } from "./MyCreatures";
import { anotherName, randomNameSeed, suggestName } from "./name-suggestion";
import { useReducedMotion } from "./reduced-motion";
import { NO_NAME, canRelease, describeFailure, keptMessage, releasedMessage } from "./release";
import { Thumbnails } from "./thumbnails";
import { hasWarningTint, WarningToggle } from "./WarningToggle";

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
  const [state, setState] = useState<EditorState>({
    canUndo: false,
    canRedo: false,
    empty: true,
    blank: true,
  });
  // Whether the latest check of the image found a body to build. False from each change until
  // the check after it, so an erased or faint drawing can't be released as an empty image.
  const [hasBody, setHasBody] = useState(false);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(PALETTE[0] ?? "#000000");
  const [width, setWidth] = useState(BRUSH_WIDTHS[1] ?? 10);
  const [closing, setClosing] = useState(false);
  const previewBox = useRef<HTMLDivElement>(null);
  const preview = useRef<BodyPreview>(undefined);
  const [sizeClass, setSizeClass] = useState<SizeClass>(DEFAULT_SIZE_CLASS);
  const [thickness, setThickness] = useState<number>(BODY_THICKNESS.default);
  // Undefined until the player types one, so the suggestion shows.
  const [name, setName] = useState<string>();
  // Chosen once the library arrives, then kept until a reroll or a release, so it doesn't jump
  // when the library changes.
  const [suggestion, setSuggestion] = useState<string>();
  const [library, setLibrary] = useState<LibrarySnapshot>();
  const [shapeHints, setShapeHints] = useState<string[]>(["Nothing drawn yet."]);
  // The preview's warning tint: off until the player asks for it (issue #141), and only for a
  // drawing that has parts to tint.
  const [warningsShown, setWarningsShown] = useState(false);
  const [warningTint, setWarningTint] = useState(false);
  const [sizeHints, setSizeHints] = useState<string[]>([]);
  // By size and ways of moving: the navigation profile the limits are for.
  const sizeHintCache = useRef(new Map<string, string[]>());
  // How each capability asked about moves, from the limits answers (issue #136). The world doesn't
  // change while the app runs, so the rules only gather.
  const [locomotionRules, setLocomotionRules] = useState<Readonly<Record<string, LocomotionRule>>>(
    {},
  );
  // Drawing, then the confirm step: the body plan and Release (ADR 0020 §12).
  const [step, setStep] = useState<"draw" | "plan">("draw");
  const [plan, setPlan] = useState<BodyPlanChoice>(defaultPlan);
  const [previewMode, setPreviewMode] = useState<PreviewMode["key"]>();
  // Which point a click on the drawing places, when both are shown.
  const [placingChoice, setPlacingChoice] = useState<AnchorName>();
  // The drawn shape's bounds, from the latest check, for the anchors' defaults.
  const [bounds, setBounds] = useState<DrawingBounds>();
  const planHeadingRef = useRef<HTMLHeadingElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  // Where the focus goes when the step changes: the panel's heading on Next, the Next button on
  // Back. Not on opening, and not after a release, which says so in its own words.
  const focusOnStep = useRef(false);
  useEffect(() => {
    if (!focusOnStep.current) return;
    focusOnStep.current = false;
    (step === "plan" ? planHeadingRef.current : nextButton.current)?.focus();
  }, [step]);
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
      setWarningTint(!check.empty && hasWarningTint(check));
      setHasBody(!check.empty);
      setBounds(check.bounds);
    };
    const created = new DrawingEditor(
      element,
      (next) => {
        setState(next);
        setHasBody(false);
        // Anchors were placed on the drawing as it was: back to their defaults.
        setPlan(afterDrawingEdit);
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
  useEffect(() => preview.current?.setThickness(thickness), [thickness]);
  useEffect(() => preview.current?.setHighlightsShown(warningsShown), [warningsShown]);

  // The preview plays the chosen way of moving in the confirm step, and stands still while drawing.
  // A way of moving stands still until the world has said how it moves.
  const body = useMemo(() => planBody(plan, thickness), [plan, thickness]);
  const modes = previewModes(plan.locomotion, body, locomotionRules);
  const mode = chosenMode(modes, previewMode);
  // With reduced motion asked for, it holds the pose it has at rest: a swimmer still sits in the
  // water, with only its slow bob.
  const reducedMotion = useReducedMotion();
  const motion = step === "plan" ? mode?.motion : undefined;
  const moving = motion !== undefined;
  const profile = motion?.profile;
  const submersion = motion?.submersion ?? 0;
  const speed = reducedMotion ? 0 : (motion?.speed ?? 0);
  useEffect(
    () => preview.current?.setMotion(moving ? { profile, submersion, speed } : undefined),
    [moving, profile, submersion, speed],
  );
  // The preview turns about the points the release will carry: the shown ones.
  const releasedAnchors = useMemo(() => activeAnchors(plan), [plan]);
  useEffect(() => preview.current?.setAnchors(releasedAnchors), [releasedAnchors]);

  // The limits in the world follow the size picker and the ways of moving (ADR 0015 §8, ADR 0020
  // §12); the gait doesn't change them. The world doesn't change while the app runs, so each
  // pairing is asked about once.
  const { land, swim } = plan.locomotion;
  useEffect(() => {
    // Nothing to ask with no way of moving; the panel shows no limits then.
    if (!land && !swim) return;
    const key = `${sizeClass}:${land ? "land" : ""}:${swim ? "swim" : ""}`;
    const cached = sizeHintCache.current.get(key);
    setSizeHints(cached ?? []);
    if (cached) return;
    let current = true;
    channel
      .request("limits", { sizeClass, locomotion: { land, swim } })
      .then(({ limits, locomotion }) => {
        setLocomotionRules((known) => ({ ...known, ...locomotion }));
        const hints = limitHints(limits);
        sizeHintCache.current.set(key, hints);
        if (current) setSizeHints(hints);
      })
      .catch((error: unknown) => console.warn(`Could not check the limits for ${key}`, error));
    return () => {
      current = false;
    };
  }, [sizeClass, land, swim]);

  useEffect(() => {
    if (editor.current) {
      const erasing = tool === "eraser";
      editor.current.brush = {
        tool: erasing ? "eraser" : "pen",
        color: erasing ? ERASER_COLOR : color,
        width,
      };
      editor.current.filling = tool === "fill";
    }
  }, [tool, color, width]);

  // Closing with something drawn asks first (ADR 0015 §10).
  useEffect(
    () =>
      studioWindow.onCloseRequested(() => {
        // Nothing visible means nothing to lose.
        if (editor.current?.state.blank ?? true) return true;
        setClosing(true);
        return false;
      }),
    [],
  );

  // The Studio is focusable, unlike the strip, so it has keyboard shortcuts. Not while asking.
  useEffect(() => {
    if (closing || step !== "draw") return;
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
  }, [closing, step]);

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
      const seed = randomNameSeed();
      setSuggestion(
        (kept) =>
          kept ??
          suggestName(
            seed,
            snapshot.species.map((s) => s.name),
          ),
      );
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

  const shownName = name ?? suggestion ?? "";
  const libraryNames = () => library?.species.map((species) => species.name) ?? [];
  const moves = canMove(plan.locomotion);
  const placing = placingAnchor(planAnchors(plan.locomotion), placingChoice);
  const releasable = canRelease({ name: shownName, empty: !hasBody, releasing, moves });
  /** A change to the body plan: a different release from any tried before. */
  const changePlan = (next: BodyPlanChoice) => {
    releaseId.current = undefined;
    setReleaseError(undefined);
    setPlan(next);
  };

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
        thickness,
        plan,
      });
      // A fresh start for the next one.
      current.reset();
      releaseId.current = undefined;
      setName(undefined);
      setSuggestion(suggestName(randomNameSeed(), [...libraryNames(), released.name]));
      setSizeClass(DEFAULT_SIZE_CLASS);
      setThickness(BODY_THICKNESS.default);
      setPlan(defaultPlan());
      setPreviewMode(undefined);
      setPlacingChoice(undefined);
      setStep("draw");
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
      <div
        className={step === "draw" ? "toolbar" : "toolbar locked"}
        role="toolbar"
        aria-label="Drawing tools"
        inert={step !== "draw"}
      >
        <div className="tool-group">
          <ToolButton label="Pen" pressed={tool === "pen"} onClick={() => setTool("pen")}>
            <path className="stroke" d="M3 13l1-3.5 7-7 2.5 2.5-7 7zM9.5 4l2.5 2.5" />
          </ToolButton>
          <ToolButton label="Eraser" pressed={tool === "eraser"} onClick={() => setTool("eraser")}>
            <path className="stroke" d="M6 13.5h7.5M2.5 10l6-6.5 5 5-5 5.5H6z" />
          </ToolButton>
          <ToolButton label="Fill" pressed={tool === "fill"} onClick={() => setTool("fill")}>
            <path className="stroke" d="M2.5 6.5h8l-1 7h-6zM3.5 6.5a3 3.5 0 0 1 6 0" />
            <path d="M13.5 11.2a1.3 1.3 0 0 1-2.6 0c0-1 1.3-2.7 1.3-2.7s1.3 1.7 1.3 2.7z" />
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
              aria-pressed={tool !== "eraser" && color === swatch}
              style={{ background: swatch }}
              onClick={() => {
                setColor(swatch);
                // The fill tool keeps filling, in the new colour.
                if (tool === "eraser") setTool("pen");
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
              disabled={tool === "fill"}
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
            <canvas ref={canvas} className={tool === "fill" ? "drawing filling" : "drawing"} />
            {/* Not part of the drawing: the body's feet are the bottom of what is drawn. */}
            {step === "draw" ? (
              <div className="guide" aria-hidden="true">
                <span>facing right →, feet on this line</span>
              </div>
            ) : (
              <AnchorLayer
                plan={plan}
                bounds={bounds}
                placing={placing}
                onPlace={(anchor, point) => changePlan(placeAnchor(plan, anchor, point))}
              />
            )}
          </div>
        </div>
        <aside className={step === "draw" ? "side-panel" : "side-panel planning"}>
          <div className="preview-frame">
            <div ref={previewBox} className="preview" aria-label="3D preview" role="img" />
            <WarningToggle
              available={warningTint}
              shown={warningsShown}
              onToggle={() => setWarningsShown((shown) => !shown)}
            />
          </div>
          {step === "plan" ? (
            <>
              <BodyPlanPanel
                name={shownName}
                plan={plan}
                onLocomotion={(locomotion) => changePlan({ ...plan, locomotion })}
                placing={placing}
                onPlacing={setPlacingChoice}
                onResetAnchors={() => changePlan(resetAnchors(plan))}
                modes={modes}
                mode={mode?.key}
                onMode={setPreviewMode}
                hints={moves ? sizeHints : []}
                headingRef={planHeadingRef}
              />
              <div className="release-slot">
                {shownName.trim() === "" && (
                  <p className="release-hint" role="status">
                    {NO_NAME}
                  </p>
                )}
                {!moves && (
                  <p className="release-hint" role="status">
                    {NO_LOCOMOTION}
                  </p>
                )}
                {releaseError && (
                  <p className="release-error" role="alert">
                    {releaseError}
                  </p>
                )}
                <div className="step-buttons">
                  <button
                    type="button"
                    className="back"
                    disabled={releasing}
                    onClick={() => {
                      setReleaseError(undefined);
                      focusOnStep.current = true;
                      setStep("draw");
                    }}
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    className="release"
                    disabled={!releasable}
                    aria-busy={releasing}
                    onClick={() => void release()}
                  >
                    {releasing ? "Releasing…" : "Release"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              <CreatureDetails
                name={shownName}
                placeholder="Creature"
                onName={(next) => {
                  releaseId.current = undefined;
                  setName(next);
                }}
                onSuggestName={() => {
                  releaseId.current = undefined;
                  setName(undefined);
                  setSuggestion(anotherName(shownName, libraryNames()));
                }}
                sizeClass={sizeClass}
                onSizeClass={(next) => {
                  releaseId.current = undefined;
                  setSizeClass(next);
                }}
                thickness={thickness}
                onThickness={(next) => {
                  releaseId.current = undefined;
                  setThickness(next);
                }}
                hints={[...shapeHints, ...(moves ? sizeHints : [])]}
              />
              <div className="release-slot">
                <button
                  type="button"
                  className="release"
                  disabled={!hasBody}
                  title={hasBody ? undefined : "Draw your creature first"}
                  ref={nextButton}
                  onClick={() => {
                    setReleaseError(undefined);
                    focusOnStep.current = true;
                    setStep("plan");
                  }}
                >
                  Next: how it moves →
                </button>
              </div>
            </>
          )}
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
