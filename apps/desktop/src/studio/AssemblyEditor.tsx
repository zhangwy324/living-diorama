import type { SocketRef, VoxelAssembly } from "@living-diorama/content-schema";
import { connectPartsStore, type PartsStore } from "@living-diorama/desktop-integration";
import { createAssemblyView, type AssemblyView } from "@living-diorama/renderer";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { canMove, defaultPlan, planVoxelBody, type LocomotionChoice } from "../body-plan";
import { NO_LOCOMOTION, type studioClient } from "../studio-protocol";
import {
  sameAssembly,
  canRedo,
  canRemove,
  canRotate,
  canUndo,
  clearNotice,
  colorsOf,
  endRecolorRun,
  fillEmpty,
  ghostAt,
  isRootPart,
  measureOf,
  pickPart,
  placeAt,
  randomize,
  randomSeed,
  recolorSelected,
  redo,
  releaseBlock,
  removeSelected,
  replaceRoot,
  reset,
  rotateSelected,
  selectInstance,
  selectionOf,
  startBuild,
  STEP_SPREAD_HINT,
  stepCreature,
  stepSelected,
  stepSpread,
  targetsFor,
  toggleMirror,
  undo,
  type BuildState,
} from "./assembly-state";
import { BodyPlanPanel } from "./BodyPlanPanel";
import { chosenMode, previewModes, type PreviewMode } from "./body-plan-view";
import { CreatureDetails } from "./CreatureDetails";
import { angleBetween, DRAG_REACH_PX, dragTarget } from "./drag-to-socket";
import { useLimits } from "./limits";
import type { ModeProps } from "./modes";
import { PartColours } from "./PartColours";
import type { PartThumbnails } from "./part-thumbnails";
import { partsKit, withPlayerParts, type PartsKit } from "./parts-kit";
import { PartsTray } from "./PartsTray";
import { usePlayerParts, type PlayerPartsState } from "./player-parts";
import { useReducedMotion } from "./reduced-motion";
import { NO_NAME, voxelReleaseFailure } from "./release";
import { keepTrying } from "./retry";
import { ToolButton } from "./ToolButton";
import { useCreatureName } from "./use-creature-name";

// The Studio's Build mode (ADR 0023): a voxel creature assembled from the parts tray in the
// assembly view, then the confirm step and Release. Click a tray part, then one of the marked
// sockets, or drag it onto the view; click a part to select it, then turn, resize or recolour it.

/** How long a refused edit's reason stays. */
export const NOTICE_MS = 3000;

/** A pointer that moved further than this between press and release dragged the camera. */
const CLICK_SLOP_PX = 4;

/** A press on a tray part that moves further than this is a drag, not a click. */
export const DRAG_START_PX = 6;

/** Said when the strip lists no part a creature can be built on. */
export const NO_PARTS = "There are no parts to build with.";

export type BuildClient = Pick<ReturnType<typeof studioClient>, "parts" | "releaseVoxel">;

/**
 * A creature to edit, e.g. a released one's assembly for Edit a copy (ADR 0023 §3). Each new `key`
 * loads it once: a fresh history from it under `name`, in the build step, and it becomes what
 * Reset goes back to and what closing compares against. A key that arrives while a release is on
 * its way waits for it to finish, so the release's fresh start doesn't wipe the loaded creature;
 * only the latest key is loaded then. Loading drops a drag, the hovered socket and the colour slot.
 */
export interface LoadRequest {
  key: number;
  assembly: VoxelAssembly;
  name: string;
}

/**
 * A part to pick in the tray, e.g. one Draw mode just saved, for its "Use in Build" (ADR 0025 §9).
 * Each new `key` is picked once, exactly as a click on its tray tile picks it: a part of a root
 * type swaps the torso, another is placed at once if it has one place, else its sockets are marked.
 * It waits until the part is in the tray (the Studio reloads the player's parts after saving one)
 * and until a release on its way has finished; it takes Build mode back to the build step. Only
 * the latest key is picked.
 */
export interface PickRequest {
  key: number;
  /** The part's ID, e.g. `user-part:<uuid>`. */
  partId: string;
}

/** Where Build mode reads the player's parts while the Studio doesn't give them. */
let fallbackPartsStore: PartsStore | undefined;

const centimetres = (metres: number) => `${Math.round(metres * 100)} cm`;

/** Whether a key press is typing in a field, which the shortcuts leave alone. */
const typing = (event: KeyboardEvent) =>
  event.target instanceof HTMLElement &&
  (event.target.isContentEditable || ["INPUT", "TEXTAREA"].includes(event.target.tagName));

/** Puts the drag token at a page point. */
const placeToken = (token: HTMLElement | null, x: number, y: number) => {
  if (!token) return;
  token.style.left = `${x}px`;
  token.style.top = `${y}px`;
};

/** Whether a page point lies inside an element's box. */
const inside = (element: Element | null, x: number, y: number) => {
  if (!element) return false;
  const box = element.getBoundingClientRect();
  return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
};

export function AssemblyEditor({
  active,
  keysEnabled,
  library,
  modeSwitch,
  askLimits,
  client,
  loadRequest,
  onReleaseStart,
  onReleased,
  onUnsaved,
  playerParts: givenPlayerParts,
  onDrawPart,
  pickRequest,
  onThumbnails,
}: ModeProps & {
  client: BuildClient;
  loadRequest?: LoadRequest | undefined;
  /**
   * The player's parts, for the tray (ADR 0025 §9). The Studio shares them with My parts; without
   * them Build mode reads the parts store itself.
   */
  playerParts?: PlayerPartsState | undefined;
  /** Opens Draw mode for a part of this type, from the tray's "Draw your own" tiles. */
  onDrawPart?: ((partType: string) => void) | undefined;
  pickRequest?: PickRequest | undefined;
  /** Hears of the view's part thumbnails, e.g. for My parts' images, so no second renderer is made. */
  onThumbnails?: ((thumbnails: PartThumbnails | undefined) => void) | undefined;
}) {
  // The packs' kit, from the strip; the view is made for it alone, so it stays when the player's
  // parts change (#247).
  const [packKit, setKit] = useState<PartsKit>();
  const ownPlayerParts = usePlayerParts(
    givenPlayerParts ? undefined : (fallbackPartsStore ??= connectPartsStore()),
  );
  const playerParts = givenPlayerParts ?? ownPlayerParts;
  const loadedParts = playerParts.parts;
  const mine = useMemo(() => (loadedParts ?? []).map(({ summary }) => summary), [loadedParts]);
  const kit = useMemo(() => packKit && withPlayerParts(packKit, mine), [packKit, mine]);
  const [noParts, setNoParts] = useState(false);
  const [build, setBuild] = useState<BuildState>();
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<AssemblyView>();
  // The socket a click or drop would put a part on, which shows that part there see-through.
  const [hovered, setHover] = useState<{ at: SocketRef; part: string }>();
  // A tray part being dragged; the pointer's place is kept in a ref (`dragAt`).
  const [drag, setDrag] = useState<{ part: string }>();
  // The colour slot being recoloured, of the part it was chosen on; another part starts at its first.
  const [colorSlot, setColorSlot] = useState<{ part: string | undefined; slot: number }>({
    part: undefined,
    slot: 0,
  });
  const [step, setStep] = useState<"build" | "plan">("build");
  const [locomotion, setLocomotion] = useState<LocomotionChoice>(() => defaultPlan().locomotion);
  const [previewMode, setPreviewMode] = useState<PreviewMode["key"]>();
  const creatureName = useCreatureName(library);
  const name = creatureName.name;
  const typeName = creatureName.type;
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
    if (!element || !packKit) return;
    let created: AssemblyView;
    try {
      created = createAssemblyView(element, {
        roleOf: packKit.lookup.roleOf,
        motionOf: packKit.motionOf,
      });
    } catch (error) {
      console.warn("The assembly view could not start", error);
      return;
    }
    setView(created);
    return () => {
      created.dispose();
      setView(undefined);
    };
  }, [packKit]);

  const thumbnails = view?.thumbnails;
  useEffect(() => onThumbnails?.(thumbnails), [onThumbnails, thumbnails]);

  // Made once per creature and kept while its assembly, name and plan are unchanged, so retrying a
  // release whose answer was lost can't save it twice (ADR 0023 §17); any edit makes a new one.
  const releaseId = useRef<string>(undefined);

  const assembly = build?.history.present;
  // A picked part that left the tray, e.g. a deleted player part, counts as not picked.
  const picked =
    step === "build" && build?.picked !== undefined && kit?.byId.has(build.picked)
      ? build.picked
      : undefined;
  // The part a click or drop would place: the dragged one, else the picked one.
  const placing = drag?.part ?? picked;
  const mirror = build?.mirror ?? true;
  useEffect(() => view?.setAssembly(assembly), [view, assembly]);
  const targets = useMemo(
    () =>
      kit && assembly && placing && !isRootPart(kit, placing)
        ? targetsFor(kit, assembly, placing, mirror)
        : undefined,
    [kit, assembly, placing, mirror],
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
  const hover = hovered && hovered.part === placing ? hovered.at : undefined;
  const hoverKey = hover && `${hover.instance}/${hover.socket}`;
  useEffect(() => {
    if (!view) return;
    view.setGhost(
      build && kit && hover && hoverKey ? ghostAt(build, kit, hover, placing) : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, hoverKey, placing, assembly, mirror]);

  // Closing asks once the creature differs from where it started (ADR 0023 §21). Compared by
  // content, so once per edit rather than per render.
  const baseline = build?.baseline;
  const unchanged = useMemo(
    () => !assembly || !baseline || sameAssembly(assembly, baseline),
    [assembly, baseline],
  );
  useEffect(() => {
    onUnsaved(!unchanged);
  }, [onUnsaved, unchanged]);

  const notice = build?.notice;
  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setBuild((s) => s && clearNotice(s)), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    releaseId.current = undefined;
  }, [assembly, name, locomotion]);

  const measure = kit && assembly ? measureOf(assembly, kit) : undefined;
  const sizeClass = measure?.sizeClass;
  const tooBig = measure !== undefined && sizeClass === undefined;
  const limits = useLimits(askLimits, sizeClass, locomotion);
  const block = releaseBlock({ tooBig, limitErrors: limits.errors });
  const moves = canMove(locomotion);
  const releasable = !!assembly && name.trim() !== "" && moves && !releasing && block.length === 0;

  // The confirm step walks the creature in place (ADR 0023 §13), its parts moving as in the strip
  // (ADR 0024 §7). With no way of moving to play it stands, but still blinks and twitches; the
  // build step keeps it at rest, where parts are placed and picked.
  const body = useMemo(() => planVoxelBody({ locomotion }), [locomotion]);
  const modes = previewModes(locomotion, body, limits.rules);
  const mode = chosenMode(modes, previewMode);
  const reducedMotion = useReducedMotion();
  // Only while shown: a hidden Build mode draws nothing.
  const moving = active && step === "plan";
  const motion = moving ? mode?.motion : undefined;
  const profile = motion?.profile;
  const submersion = motion?.submersion ?? 0;
  const speed = reducedMotion ? 0 : (motion?.speed ?? 0);
  useEffect(
    () => view?.setTestWalk(moving ? { profile, submersion, speed } : undefined),
    [view, moving, profile, submersion, speed],
  );

  const edit = (change: (state: BuildState, kit: PartsKit) => BuildState) =>
    setBuild((state) => (state && kit ? change(state, kit) : state));

  // Drag-to-socket (ADR 0023 §4): a press on a tray part that moves becomes a drag; over the view
  // the part is shown see-through on the socket the pointer points at best, and dropped there.
  const press = useRef<{ part: string; x: number; y: number }>(undefined);
  const dragging = useRef(false);
  const dragFrame = useRef<number>(undefined);
  // Where the pointer is while dragging; the token beside it follows by ref, not by render.
  const dragAt = useRef({ x: 0, y: 0 });
  const dragToken = useRef<HTMLDivElement>(null);
  // A drag that ended (dropped, cancelled or lost) with the button still down would also click
  // the part it began on when released over it. Cleared after that release and by the next press.
  const dropClick = useRef(false);
  // What the window's pointer listeners read: the latest of each, without listening anew per edit.
  const latest = useRef({ build, kit, view });
  useEffect(() => {
    latest.current = { build, kit, view };
  });

  /** The socket a part dragged to a page point would go to, if it is over the view. */
  const dropTarget = useCallback((part: string, x: number, y: number) => {
    const { build: state, kit: k, view: v } = latest.current;
    if (!state || !k || !v || !inside(stage.current, x, y)) return undefined;
    const probe = v.probe(x, y);
    const edge = v.probe(x + DRAG_REACH_PX, y);
    if (!probe || !edge) return undefined;
    const reach = angleBetween(probe.direction, edge.direction);
    return dragTarget(k, state.history.present, part, state.mirror, probe, reach);
  }, []);

  const endDrag = useCallback(() => {
    press.current = undefined;
    if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = undefined;
    if (!dragging.current) return;
    dragging.current = false;
    dropClick.current = true;
    setDrag(undefined);
    setHover(undefined);
  }, []);

  // A creature to edit, once per key, as soon as the parts are here and no release is on its way
  // (ADR 0023 §3; see `LoadRequest`).
  const loadedKey = useRef<number>(undefined);
  useEffect(() => {
    if (!kit || !loadRequest || releasing || loadRequest.key === loadedKey.current) return;
    loadedKey.current = loadRequest.key;
    endDrag();
    setHover(undefined);
    setColorSlot({ part: undefined, slot: 0 });
    setBuild(startBuild(kit, loadRequest.assembly));
    typeName(loadRequest.name);
    setLocomotion(defaultPlan().locomotion);
    setPreviewMode(undefined);
    setReleaseError(undefined);
    setStep("build");
    releaseId.current = undefined;
  }, [kit, loadRequest, releasing, typeName, endDrag]);

  // A part to pick, e.g. from Draw mode's "Use in Build", once it is in the tray (`PickRequest`).
  const pickedKey = useRef<number>(undefined);
  useEffect(() => {
    if (!kit || !pickRequest || releasing || pickRequest.key === pickedKey.current) return;
    if (!kit.byId.has(pickRequest.partId)) return;
    pickedKey.current = pickRequest.key;
    endDrag();
    // A request from outside, taken once per key as `loadRequest` is.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHover(undefined);
    setReleaseError(undefined);
    setStep("build");
    // Picking the picked part again would drop the pick.
    setBuild(
      (state) => state && pickPart({ ...state, picked: undefined }, kit, pickRequest.partId),
    );
  }, [kit, pickRequest, releasing, endDrag]);

  useEffect(() => {
    if (step !== "build") return;
    const onMove = (event: PointerEvent) => {
      const pressed = press.current;
      if (!pressed) return;
      // No button down: the release was missed, e.g. outside the window.
      if (event.buttons === 0) {
        endDrag();
        return;
      }
      const { clientX: x, clientY: y } = event;
      dragAt.current = { x, y };
      if (!dragging.current) {
        if (Math.hypot(x - pressed.x, y - pressed.y) < DRAG_START_PX) return;
        dragging.current = true;
        setDrag({ part: pressed.part });
        // The drag takes over from a click's pick.
        setBuild((state) => state && { ...state, picked: undefined, notice: undefined });
      }
      placeToken(dragToken.current, x, y);
      // Picking costs about 1.5 ms, so the pointer is followed at most once a frame.
      if (dragFrame.current !== undefined) cancelAnimationFrame(dragFrame.current);
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = undefined;
        const at = dropTarget(pressed.part, x, y);
        setHover((known) =>
          !at
            ? undefined
            : known?.part === pressed.part &&
                known.at.instance === at.instance &&
                known.at.socket === at.socket
              ? known
              : { at, part: pressed.part },
        );
      });
    };
    const onUp = (event: PointerEvent) => {
      const pressed = press.current;
      const wasDragging = dragging.current;
      endDrag();
      // After the click this release may fire on the part the drag began on.
      setTimeout(() => {
        dropClick.current = false;
      });
      if (!pressed || !wasDragging) return;
      const { clientX: x, clientY: y } = event;
      const { kit: k } = latest.current;
      if (!k || !inside(stage.current, x, y)) return;
      if (isRootPart(k, pressed.part)) {
        // A torso has one place: the torso's.
        edit((state, kk) => replaceRoot(state, kk, pressed.part));
        return;
      }
      const at = dropTarget(pressed.part, x, y);
      if (at) edit((state, kk) => placeAt(state, kk, at, pressed.part));
    };
    const onDown = () => {
      dropClick.current = false;
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", endDrag);
    window.addEventListener("blur", endDrag);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", endDrag);
      window.removeEventListener("blur", endDrag);
      endDrag();
    };
    // `edit` reads `kit` through the state setter; the rest are refs or stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, kit, dropTarget, endDrag]);

  const onTrayPress = (part: string, event: ReactPointerEvent) => {
    if (event.button !== 0 || step !== "build") return;
    press.current = { part, x: event.clientX, y: event.clientY };
  };

  // Undo and redo; Delete removes the selected part, R turns it, + and − grow and
  // shrink its cubes; Escape drops a drag, the pick or the selection. Not while typing a name.
  useEffect(() => {
    if (!keysEnabled || step !== "build") return;
    const onKey = (event: KeyboardEvent) => {
      if (typing(event)) return;
      const key = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (!event.ctrlKey && !event.metaKey) return;
        if (key === "z" && !event.shiftKey) edit(undo);
        else if (key === "y" || (key === "z" && event.shiftKey)) edit(redo);
        else return;
      } else if (key === "delete" || key === "backspace") {
        edit(removeSelected);
      } else if (key === "r") {
        edit(rotateSelected);
      } else if (key === "+" || key === "=") {
        edit((state) => stepSelected(state, 1));
      } else if (key === "-" || key === "_") {
        edit((state) => stepSelected(state, -1));
      } else if (key === "escape") {
        if (dragging.current) endDrag();
        else edit((state) => selectInstance(state, undefined));
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
  const onPointerDown = (event: ReactPointerEvent) => {
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
  const onPointerMove = (event: ReactPointerEvent) => {
    if (!view || !picked || drag || event.buttons !== 0) return;
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
    onReleaseStart();
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

  const placingPart = placing !== undefined ? kit?.byId.get(placing) : undefined;
  const stageHint =
    step === "plan"
      ? undefined
      : drag && placingPart
        ? kit && isRootPart(kit, placingPart.id)
          ? `Drop it on the view to swap the torso for the ${placingPart.name.toLowerCase()}.`
          : `Drop the ${placingPart.name.toLowerCase()} on a marked spot.`
        : placingPart
          ? `Click a marked spot for the ${placingPart.name.toLowerCase()}. Esc cancels.`
          : build?.selected !== undefined
            ? canRemove(build)
              ? "R turns it, + and − change its size, Delete removes it."
              : "Pick another torso in the tray to swap it."
            : "Pick a part from the tray, or drag one onto the creature.";
  const limitHints = limits.hints.filter((hint) => !limits.errors.includes(hint));
  const hints = [
    ...(assembly && stepSpread(assembly) ? [STEP_SPREAD_HINT] : []),
    ...(moves ? limitHints : []),
  ];
  const colors = build && step === "build" ? colorsOf(build) : undefined;
  const selected = build?.selected;
  const slot = colors
    ? Math.min(colorSlot.part === selected ? colorSlot.slot : 0, colors.length - 1)
    : 0;
  const onColorDone = useCallback(() => setBuild((s) => s && endRecolorRun(s)), []);
  const hasSelection = !!build && build.selected !== undefined;

  return (
    <div className={drag ? "studio-mode dragging" : "studio-mode"} hidden={!active}>
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
          <div className="tool-group" role="group" aria-label="Selected part">
            <ToolButton
              label="Remove part (Delete)"
              disabled={!build || !canRemove(build)}
              onClick={() => edit(removeSelected)}
            >
              <path className="stroke" d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
            </ToolButton>
            <ToolButton
              label="Turn part (R)"
              disabled={!build || !canRotate(build)}
              onClick={() => edit(rotateSelected)}
            >
              <path className="stroke" d="M13 8a5 5 0 1 1-1.5-3.5M11.5 1.5v3h-3" />
            </ToolButton>
            <ToolButton
              label="Smaller part (−)"
              disabled={!hasSelection}
              onClick={() => edit((state) => stepSelected(state, -1))}
            >
              <rect className="stroke" x="5" y="5" width="6" height="6" rx="1" />
              <path className="stroke" d="M2 2l2.5 2.5M14 2l-2.5 2.5M2 14l2.5-2.5M14 14l-2.5-2.5" />
            </ToolButton>
            <ToolButton
              label="Bigger part (+)"
              disabled={!hasSelection}
              onClick={() => edit((state) => stepSelected(state, 1))}
            >
              <rect className="stroke" x="4" y="4" width="8" height="8" rx="1" />
              <path className="stroke" d="M4 4L1.5 1.5M12 4l2.5-2.5M4 12l-2.5 2.5M12 12l2.5 2.5" />
            </ToolButton>
          </div>
          <div className="tool-group">
            <button
              type="button"
              className="text-button"
              aria-pressed={mirror}
              title="Place, swap and change parts on both sides at once"
              disabled={!build}
              onClick={() => edit(toggleMirror)}
            >
              <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
                <path className="stroke" d="M8 2v12M6 4L2.5 8 6 12zM10 4l3.5 4L10 12z" />
              </svg>
              Mirror
            </button>
          </div>
          <div className="tool-group" role="group" aria-label="Whole creature">
            <ToolButton
              label="Smaller creature"
              disabled={!build}
              onClick={() => edit((state) => stepCreature(state, -1))}
            >
              <path className="stroke" d="M5 13.5V9.5a3 3 0 0 1 6 0v4M3.5 13.5h9" />
              <path className="stroke" d="M8 2v3.5M6.5 4L8 5.5 9.5 4" />
            </ToolButton>
            <ToolButton
              label="Bigger creature"
              disabled={!build}
              onClick={() => edit((state) => stepCreature(state, 1))}
            >
              <path className="stroke" d="M3.5 13.5V9a4.5 4.5 0 0 1 9 0v4.5M2 13.5h12" />
              <path className="stroke" d="M8 5.5V1.5M6.5 3L8 1.5 9.5 3" />
            </ToolButton>
            <button
              type="button"
              className="text-button"
              title="A new random creature"
              disabled={!build}
              onClick={() => edit((state, k) => randomize(state, k, randomSeed()))}
            >
              Randomize
            </button>
            <button
              type="button"
              className="text-button"
              title="Put parts on every free place, keeping these"
              disabled={!build}
              onClick={() => edit((state, k) => fillEmpty(state, k, randomSeed()))}
            >
              Fill empty
            </button>
            <button
              type="button"
              className="text-button"
              title={
                baseline !== kit?.start
                  ? "Back to the creature as it was loaded"
                  : "Back to the plain torso"
              }
              disabled={!build || unchanged}
              onClick={() => edit(reset)}
            >
              Reset
            </button>
          </div>
        </div>
      </div>
      <div className="workspace">
        {kit && (
          <PartsTray
            sections={kit.sections}
            picked={picked}
            onPick={(partId) => {
              if (dropClick.current) return;
              edit((state, k) => pickPart(state, k, partId));
            }}
            onPress={onTrayPress}
            thumbnails={thumbnails}
            onDrawPart={onDrawPart}
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
            onPointerLeave={() => {
              if (!drag) setHover(undefined);
            }}
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
                locomotion={locomotion}
                onLocomotion={(next) => {
                  setReleaseError(undefined);
                  setLocomotion(next);
                }}
                modes={modes}
                mode={mode?.key}
                onMode={setPreviewMode}
                hints={hints}
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
                {moves && <BlockingHints hints={block} />}
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
                hints={hints}
              />
              {colors && kit && (
                <PartColours
                  colors={colors}
                  slot={slot}
                  onSlot={(next) => {
                    setColorSlot({ part: selected, slot: next });
                    setBuild((s) => s && endRecolorRun(s));
                  }}
                  suggested={kit.suggestedColors}
                  onColor={(color, live) =>
                    edit((state) => recolorSelected(state, slot, color, { live }))
                  }
                  onColorDone={onColorDone}
                />
              )}
              <div className="release-slot">
                <BlockingHints hints={block} />
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
      {drag && placingPart && (
        <div
          className="drag-token"
          ref={(element) => {
            dragToken.current = element;
            placeToken(element, dragAt.current.x, dragAt.current.y);
          }}
          aria-hidden="true"
        >
          {placingPart.name}
        </div>
      )}
    </div>
  );
}

/** What keeps the creature from being released, each on its own line (ADR 0023 §14). */
function BlockingHints({ hints }: { hints: readonly string[] }) {
  return hints.map((hint) => (
    <p key={hint} className="release-hint blocking" role="status">
      {hint}
    </p>
  ));
}
