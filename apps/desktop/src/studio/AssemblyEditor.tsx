import type { SocketRef } from "@living-diorama/content-schema";
import { createAssemblyView, type AssemblyView } from "@living-diorama/renderer";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { canMove, defaultPlan, planVoxelBody, type LocomotionChoice } from "../body-plan";
import { NO_LOCOMOTION, type studioClient } from "../studio-protocol";
import {
  canRedo,
  canRemove,
  canUndo,
  clearNotice,
  ghostAt,
  isStart,
  measureOf,
  pickPart,
  placeAt,
  redo,
  releaseBlock,
  removeSelected,
  selectInstance,
  selectionOf,
  startBuild,
  targetsFor,
  toggleMirror,
  undo,
  type BuildState,
} from "./assembly-state";
import { BodyPlanPanel } from "./BodyPlanPanel";
import { chosenMode, previewModes, type PreviewMode } from "./body-plan-view";
import { CreatureDetails } from "./CreatureDetails";
import { useLimits } from "./limits";
import type { ModeProps } from "./modes";
import { partsKit, type PartsKit } from "./parts-kit";
import { PartsTray } from "./PartsTray";
import { useReducedMotion } from "./reduced-motion";
import { NO_NAME, voxelReleaseFailure } from "./release";
import { keepTrying } from "./retry";
import { ToolButton } from "./ToolButton";
import { useCreatureName } from "./use-creature-name";

// The Studio's Build mode (ADR 0023): a voxel creature assembled from the parts tray in the
// assembly view, then the confirm step and Release. Click a tray part, then one of the marked
// sockets; click a part to select it.

/** How long a refused edit's reason stays. */
export const NOTICE_MS = 3000;

/** A pointer that moved further than this between press and release dragged the camera. */
const CLICK_SLOP_PX = 4;

/** Said when the strip lists no part a creature can be built on. */
export const NO_PARTS = "There are no parts to build with.";

export type BuildClient = Pick<ReturnType<typeof studioClient>, "parts" | "releaseVoxel">;

const centimetres = (metres: number) => `${Math.round(metres * 100)} cm`;

/** Whether a key press is typing in a field, which the shortcuts leave alone. */
const typing = (event: KeyboardEvent) =>
  event.target instanceof HTMLElement &&
  (event.target.isContentEditable || ["INPUT", "TEXTAREA"].includes(event.target.tagName));

export function AssemblyEditor({
  active,
  keysEnabled,
  library,
  modeSwitch,
  askLimits,
  client,
  onReleased,
  onUnsaved,
}: ModeProps & { client: BuildClient }) {
  const [kit, setKit] = useState<PartsKit>();
  const [noParts, setNoParts] = useState(false);
  const [build, setBuild] = useState<BuildState>();
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<AssemblyView>();
  // The marked socket under the pointer, which shows the part picked then see-through.
  const [hovered, setHover] = useState<{ at: SocketRef; part: string }>();
  const [step, setStep] = useState<"build" | "plan">("build");
  const [locomotion, setLocomotion] = useState<LocomotionChoice>(() => defaultPlan().locomotion);
  const [previewMode, setPreviewMode] = useState<PreviewMode["key"]>();
  const creatureName = useCreatureName(library);
  const name = creatureName.name;
  const [releasing, setReleasing] = useState(false);
  const [releaseError, setReleaseError] = useState<string>();
  const planHeadingRef = useRef<HTMLHeadingElement>(null);
  const nextButton = useRef<HTMLButtonElement>(null);
  const focusOnStep = useRef(false);
  useEffect(() => {
    if (!focusOnStep.current) return;
    focusOnStep.current = false;
    (step === "plan" ? planHeadingRef.current : nextButton.current)?.focus();
  }, [step]);

  // The parts come from the strip's `ready`, so they are asked for until the world is running.
  useEffect(() => {
    let current = true;
    const stop = keepTrying(
      () =>
        client.parts().then((parts) => {
          if (!current) return;
          const made = partsKit(parts);
          if (!made) {
            setNoParts(true);
            return;
          }
          setKit(made);
          setBuild(startBuild(made));
        }),
      (error: unknown) => console.warn("Could not get the parts to build with", error),
    );
    return () => {
      current = false;
      stop();
    };
  }, [client]);

  // The view's WebGL context lives while the Studio is open (ADR 0015 §7); its thumbnails fill
  // the tray.
  useEffect(() => {
    const element = stage.current;
    if (!element || !kit) return;
    let created: AssemblyView;
    try {
      created = createAssemblyView(element, { roleOf: kit.lookup.roleOf });
    } catch (error) {
      console.warn("The assembly view could not start", error);
      return;
    }
    setView(created);
    return () => {
      created.dispose();
      setView(undefined);
    };
  }, [kit]);

  const assembly = build?.history.present;
  const picked = step === "build" ? build?.picked : undefined;
  const mirror = build?.mirror ?? true;
  useEffect(() => view?.setAssembly(assembly), [view, assembly]);
  const targets = useMemo(
    () => (kit && assembly && picked ? targetsFor(kit, assembly, picked, mirror) : undefined),
    [kit, assembly, picked, mirror],
  );
  useEffect(
    () => view?.setHighlightedSockets(targets ? [...targets.free, ...targets.occupied] : []),
    [view, targets],
  );
  const selection = useMemo(
    () => (build && step === "build" ? selectionOf(build) : []),
    // The selection follows the selected part, the assembly and Mirror.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [build?.selected, assembly, mirror, step],
  );
  useEffect(() => view?.setSelection(selection), [view, selection]);
  // A new ghost only when what it shows changes: `setGhost` meshes the part anew.
  const hover = hovered && hovered.part === picked ? hovered.at : undefined;
  const hoverKey = hover && `${hover.instance}/${hover.socket}`;
  useEffect(() => {
    if (!view) return;
    view.setGhost(build && kit && hover && hoverKey ? ghostAt(build, kit, hover) : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hoverKey, picked, assembly, mirror]);

  // Closing asks once the creature is more than the default torso (ADR 0023 §21).
  useEffect(() => {
    onUnsaved(kit !== undefined && assembly !== undefined && !isStart(assembly, kit));
  }, [onUnsaved, kit, assembly]);

  const notice = build?.notice;
  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setBuild((s) => s && clearNotice(s)), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // Made once per creature and kept while its assembly, name and plan are unchanged, so retrying a
  // release whose answer was lost can't save it twice (ADR 0023 §17); any edit makes a new one.
  const releaseId = useRef<string>(undefined);
  useEffect(() => {
    releaseId.current = undefined;
  }, [assembly, name, locomotion]);

  const measure = kit && assembly ? measureOf(assembly, kit) : undefined;
  const sizeClass = measure?.sizeClass;
  const tooBig = measure !== undefined && sizeClass === undefined;
  const limits = useLimits(askLimits, sizeClass, locomotion);
  const block = releaseBlock({ tooBig, limitErrors: limits.errors });
  const moves = canMove(locomotion);
  const releasable = !!assembly && name.trim() !== "" && moves && !releasing && !block;

  // The confirm step walks the creature in place (ADR 0023 §13).
  const body = useMemo(() => planVoxelBody({ locomotion }), [locomotion]);
  const modes = previewModes(locomotion, body, limits.rules);
  const mode = chosenMode(modes, previewMode);
  const reducedMotion = useReducedMotion();
  const motion = step === "plan" ? mode?.motion : undefined;
  const moving = motion !== undefined;
  const profile = motion?.profile;
  const submersion = motion?.submersion ?? 0;
  const speed = reducedMotion ? 0 : (motion?.speed ?? 0);
  useEffect(
    () => view?.setTestWalk(moving ? { profile, submersion, speed } : undefined),
    [view, moving, profile, submersion, speed],
  );

  const edit = (change: (state: BuildState, kit: PartsKit) => BuildState) =>
    setBuild((state) => (state && kit ? change(state, kit) : state));

  // Undo and redo as in Draw mode; Delete removes the selected part, Escape drops the pick or the
  // selection. Not while typing a name.
  useEffect(() => {
    if (!keysEnabled || step !== "build") return;
    const onKey = (event: KeyboardEvent) => {
      if (typing(event)) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey) {
        if (key === "z" && !event.shiftKey) edit(undo);
        else if (key === "y" || (key === "z" && event.shiftKey)) edit(redo);
        else return;
      } else if (key === "delete" || key === "backspace") {
        edit(removeSelected);
      } else if (key === "escape") {
        edit((state) => selectInstance(state, undefined));
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysEnabled, step, kit]);

  // A click on the view: a marked socket takes the picked part, a part is selected, empty space
  // drops both. A drag orbits the camera instead.
  const pressedAt = useRef<{ x: number; y: number }>(undefined);
  const hoverFrame = useRef<number>(undefined);
  const onPointerDown = (event: PointerEvent) => {
    pressedAt.current = { x: event.clientX, y: event.clientY };
  };
  const onClick = (event: { clientX: number; clientY: number }) => {
    const from = pressedAt.current;
    pressedAt.current = undefined;
    if (!view || step !== "build") return;
    if (from && Math.hypot(event.clientX - from.x, event.clientY - from.y) > CLICK_SLOP_PX) return;
    const hit = view.pick(event.clientX, event.clientY);
    setHover(undefined);
    if (hit?.kind === "socket") {
      edit((state, k) => placeAt(state, k, { instance: hit.instance, socket: hit.socket }));
    } else {
      edit((state) => selectInstance(state, hit?.instance));
    }
  };
  // Picking costs about 1.5 ms, so the pointer is followed at most once a frame.
  const onPointerMove = (event: PointerEvent) => {
    if (!view || !picked || event.buttons !== 0) return;
    const { clientX, clientY } = event;
    if (hoverFrame.current !== undefined) cancelAnimationFrame(hoverFrame.current);
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = undefined;
      const hit = view.pick(clientX, clientY);
      setHover((known) => {
        if (hit?.kind !== "socket") return undefined;
        const { at } = known ?? {};
        return known?.part === picked && at?.instance === hit.instance && at.socket === hit.socket
          ? known
          : { at: { instance: hit.instance, socket: hit.socket }, part: picked };
      });
    });
  };
  useEffect(
    () => () => {
      if (hoverFrame.current !== undefined) cancelAnimationFrame(hoverFrame.current);
    },
    [],
  );

  const release = async () => {
    if (!assembly || !kit || !releasable) return;
    setReleasing(true);
    setReleaseError(undefined);
    releaseId.current ??= crypto.randomUUID();
    try {
      const released = await client.releaseVoxel({
        releaseId: releaseId.current,
        assembly,
        name,
        plan: { locomotion },
      });
      // A fresh start for the next one, in Build mode from the default torso (ADR 0023 §10).
      releaseId.current = undefined;
      setBuild(startBuild(kit));
      creatureName.afterRelease(released.name);
      setLocomotion(defaultPlan().locomotion);
      setPreviewMode(undefined);
      setStep("build");
      onReleased(released);
    } catch (error) {
      // The creature stays, so the player can try again.
      setReleaseError(voxelReleaseFailure(error));
    } finally {
      setReleasing(false);
    }
  };

  const pickedPart = picked !== undefined ? kit?.byId.get(picked) : undefined;
  const stageHint =
    step === "plan"
      ? undefined
      : pickedPart
        ? `Click a marked spot for the ${pickedPart.name.toLowerCase()}. Esc cancels.`
        : build?.selected !== undefined
          ? canRemove(build)
            ? "Delete removes it."
            : undefined
          : "Pick a part from the tray.";
  const hints = limits.hints.filter((hint) => !limits.errors.includes(hint));

  return (
    <div className="studio-mode" hidden={!active}>
      <div className="toolbar" role="toolbar" aria-label="Building tools">
        {modeSwitch}
        <div
          className={step === "build" ? "tool-groups" : "tool-groups locked"}
          inert={step !== "build"}
        >
          <div className="tool-group">
            <ToolButton
              label="Undo (Ctrl+Z)"
              disabled={!build || !canUndo(build)}
              onClick={() => edit(undo)}
            >
              <path className="stroke" d="M5.5 3L2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8h-3" />
            </ToolButton>
            <ToolButton
              label="Redo (Ctrl+Y)"
              disabled={!build || !canRedo(build)}
              onClick={() => edit(redo)}
            >
              <path className="stroke" d="M10.5 3l3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8h3" />
            </ToolButton>
          </div>
          <div className="tool-group">
            <ToolButton
              label="Remove part (Delete)"
              disabled={!build || !canRemove(build)}
              onClick={() => edit(removeSelected)}
            >
              <path className="stroke" d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
            </ToolButton>
          </div>
          <div className="tool-group">
            <button
              type="button"
              className="text-button"
              aria-pressed={mirror}
              title="Place, swap and remove parts on both sides at once"
              disabled={!build}
              onClick={() => edit(toggleMirror)}
            >
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path className="stroke" d="M8 2v12M6 4L2.5 8 6 12zM10 4l3.5 4L10 12z" />
              </svg>
              Mirror
            </button>
          </div>
        </div>
      </div>
      <div className="workspace">
        {kit && (
          <PartsTray
            sections={kit.sections}
            picked={picked}
            onPick={(partId) => edit((state, k) => pickPart(state, k, partId))}
            thumbnails={view?.thumbnails}
            locked={step !== "build"}
          />
        )}
        <div className={releasing ? "stage-area releasing" : "stage-area"}>
          <div
            ref={stage}
            className={picked ? "assembly-stage placing" : "assembly-stage"}
            role="img"
            aria-label="Your creature"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(undefined)}
            onClick={onClick}
          />
          {!kit && (
            <p className="stage-message" role="status">
              {noParts ? NO_PARTS : "Getting the parts…"}
            </p>
          )}
          {stageHint && kit && (
            <p className="stage-hint" aria-live="polite">
              {stageHint}
            </p>
          )}
          {notice && (
            <p key={notice} className="stage-notice" role="status">
              {notice}
            </p>
          )}
        </div>
        <aside className="side-panel build-panel">
          {step === "plan" ? (
            <>
              <BodyPlanPanel
                name={name}
                plan={{ locomotion, anchors: {} }}
                onLocomotion={(next) => {
                  setReleaseError(undefined);
                  setLocomotion(next);
                }}
                showAnchors={false}
                placing={undefined}
                onPlacing={() => {}}
                onResetAnchors={() => {}}
                modes={modes}
                mode={mode?.key}
                onMode={setPreviewMode}
                hints={moves ? hints : []}
                headingRef={planHeadingRef}
              />
              <div className="release-slot">
                {name.trim() === "" && (
                  <p className="release-hint" role="status">
                    {NO_NAME}
                  </p>
                )}
                {!moves && (
                  <p className="release-hint" role="status">
                    {NO_LOCOMOTION}
                  </p>
                )}
                {moves && block && (
                  <p className="release-hint blocking" role="status">
                    {block}
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
                      setStep("build");
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
                name={name}
                placeholder="Creature"
                onName={creatureName.type}
                onSuggestName={creatureName.another}
                sizeClass={sizeClass}
                measured={measure && `${centimetres(measure.height)} tall`}
                hints={moves ? hints : []}
              />
              <div className="release-slot">
                {block && (
                  <p className="release-hint blocking" role="status">
                    {block}
                  </p>
                )}
                <button
                  type="button"
                  className="release"
                  disabled={!assembly || tooBig}
                  title={tooBig ? "Make it smaller first" : undefined}
                  ref={nextButton}
                  onClick={() => {
                    edit((state) => selectInstance(state, undefined));
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
      </div>
    </div>
  );
}
