import {
  DRAWING_GRID,
  DRAWN_SOCKET_DEPTHS,
  MAX_CHUBBY,
  MAX_PLAYER_PART_NAME_LENGTH,
  MIN_CHUBBY,
  PART_DRAWING_RULES,
  PART_DRAWING_VIEWS,
  VOXEL_STEPS,
  VoxelAssemblySchema,
  fitDrawnPart,
  voxelizeDrawing,
  type DrawnPartFit,
  type DrawnSocketDepth,
  type PartDrawing,
  type PartDrawingRule,
  type PartDrawingView,
  type PlayerPartEntry,
  type VoxelAssembly,
  type VoxelStep,
} from "@living-diorama/content-schema";
import type { PartsStore } from "@living-diorama/desktop-integration";
import { createAssemblyView, type AssemblyView } from "@living-diorama/renderer";
import type { PartSummary } from "@living-diorama/simulation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { partDrawingRecipeLookup } from "../part-types";
import type { StudioParts } from "../studio-protocol";
import {
  MUCH_BIGGER,
  NEW_PART,
  defaultBase,
  defaultPartName,
  drawKey,
  drawingOf,
  partEntry,
  recordOf,
  sameSnapshot,
  savePart,
  sizeAgainst,
  type DrawFrame,
  type DrawLook,
  type DrawSetup,
  type DrawSnapshot,
  type DrawnPartRecord,
} from "./draw-entry";
import {
  NO_PLACED_POINTS,
  dropPoint,
  overridesFor,
  partnerOf,
  placedFrom,
  silhouette,
  toCanvas,
  type DraggedPoint,
} from "./drawn-points";
import {
  canRedo,
  canUndo,
  colourIndex,
  commit,
  compactDrawing,
  emptyGrid,
  floodFill,
  isBlank,
  lineCells,
  paint,
  redo,
  startHistory,
  undo,
  type Grid,
  type GridTool,
  type History,
} from "./grid-editor";
import type { DrawRequest, ModeProps } from "./modes";
import { partsKit, type PartsKit } from "./parts-kit";
import { keepTrying } from "./retry";
import { ToolButton } from "./ToolButton";

// The Studio's Draw mode (ADR 0025 §3–§9): a part drawn on a 32 × 32 grid, one cell a cube, from
// one view, given depth by a rule and the attach point and sockets of a base part of its type. It
// is seen in 3D beside the grid, saved to the player's parts, and handed to Build mode.

/** The grid's canvas: this many canvas pixels a cell. */
const CELL_PX = 16;
const CANVAS_PX = CELL_PX * DRAWING_GRID;

/** Said when the strip lists no part to draw from. */
export const NO_DRAW_PARTS = "There are no parts to draw from.";

/** Said when a part much bigger than its base part is drawn (`MUCH_BIGGER`). */
export const MUCH_BIGGER_HINT =
  "Much bigger than its base part: a creature built with it may be too big to release. A smaller cube size makes it smaller.";

/** Said while a reopened part's base part is gone and another of its type stands in. */
export const BASE_GONE =
  "This part's base part is no longer there, so its sockets are checked against another of its type.";

/** The colour a drawing starts with when the packs suggest none. */
const FIRST_COLOUR = "#7fae5a";

export const VIEW_LABELS: Readonly<Record<PartDrawingView, string>> = {
  side: "Side",
  front: "Front",
  top: "Top",
};

export const RULE_LABELS: Readonly<Record<PartDrawingRule, string>> = {
  puffy: "Puffy",
  tube: "Tube",
  flat: "Flat",
};

/** How deep a socket sits, in the player's words (ADR 0025 §3). */
export const DEPTH_LABELS: Readonly<Record<DrawnSocketDepth, string>> = {
  own: "deep: holds a part this size",
  finer: "half deep: holds a smaller part only",
  touching: "on the surface: too shallow for a part",
  loose: "off the part",
};

const TOOL_LABELS: Readonly<Record<GridTool, string>> = {
  pen: "Pen (P)",
  eraser: "Eraser (E)",
  fill: "Fill (F)",
};

const centimetres = (metres: number) => `${+(metres * 100).toFixed(2)} cm`;

/** Whether a key press is typing in a field, which the shortcuts leave alone. */
const typing = (event: KeyboardEvent) =>
  event.target instanceof HTMLElement &&
  (event.target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));

/** A centimetre ruler's labels along the grid: every `every` cm, at most about 8 of them. */
export function rulerMarks(step: VoxelStep): { cells: number; label: string }[] {
  const cellCm = step * 100;
  const total = cellCm * DRAWING_GRID;
  const every = [1, 2, 5, 10, 20, 50, 100].find((cm) => total / cm <= 8) ?? 100;
  const marks = [];
  for (let cm = 0; cm <= total + 1e-9; cm += every) {
    marks.push({ cells: cm / cellCm, label: `${cm}` });
  }
  return marks;
}

/** The pack part a drawing is drawn against, if the strip still lists it as a part of `type`. */
const packBase = (k: PartsKit, id: string, type: string): PartSummary | undefined => {
  const found = k.byId.get(id);
  return found?.part.type === type ? found : undefined;
};

/** Before the parts are here: no drawing yet. */
const NO_FRAME: DrawFrame = { partType: "", baseId: "", view: "side" };

/** A socket marker on the grid: one socket, or a mirror pair at the same place (side view). */
interface SocketMarker {
  u: number;
  v: number;
  /** How many markers before it share its place: it is drawn that much aside. */
  offset: number;
  ids: string[];
  depth: DrawnSocketDepth;
  shallow: boolean;
}

export interface PartDrawModeProps extends Pick<
  ModeProps,
  "active" | "keysEnabled" | "modeSwitch" | "onUnsaved"
> {
  /** The strip's parts: the part types, base parts and suggested colours. */
  client: { parts(): Promise<StudioParts> };
  /** The player's parts, where a drawn part is saved. */
  store: PartsStore;
  /** The latest drawing to open (`OpenDraw`); a new key opens it. */
  request: DrawRequest | undefined;
  /** "New part": the Studio opens a new drawing of a type, asking first if this one isn't saved. */
  onNew(partType: string): void;
  /** A part was saved, even one the player has since left. */
  onSaved(entry: PlayerPartEntry): void;
  /** "Use in Build": the part, saved, for Build mode to pick (ADR 0025 §9). */
  onUseInBuild(entry: PlayerPartEntry): void;
}

export function PartDrawMode({
  active,
  keysEnabled,
  modeSwitch,
  onUnsaved,
  client,
  store,
  request,
  onNew,
  onSaved,
  onUseInBuild,
}: PartDrawModeProps) {
  // The parts are asked for once Draw mode is shown, until the world answers.
  const [studioParts, setStudioParts] = useState<StudioParts>();
  useEffect(() => {
    if (!active || studioParts) return;
    let current = true;
    const stop = keepTrying(
      () =>
        client.parts().then((parts) => {
          if (current) setStudioParts(parts);
        }),
      (error: unknown) => console.warn("Could not get the parts to draw from", error),
    );
    return () => {
      current = false;
      stop();
    };
  }, [active, studioParts, client]);
  const kit = useMemo(() => studioParts && partsKit(studioParts), [studioParts]);
  const recipeOf = useMemo(
    () => partDrawingRecipeLookup(studioParts?.partTypes ?? []),
    [studioParts],
  );

  // Undo steps: the grid, the placed points and the frame (type, base part, view) together.
  const [history, setHistory] = useState<History<DrawSnapshot>>(() =>
    startHistory({ grid: emptyGrid(), placed: NO_PLACED_POINTS, frame: NO_FRAME }),
  );
  // How the drawing gets its depth and size; undefined until a drawing has begun.
  const [look, setLook] = useState<DrawLook>();
  const [palette, setPalette] = useState<readonly string[]>([]);
  const [tool, setTool] = useState<GridTool>("pen");
  // The colour picked to paint with; the packs' first suggested one until then.
  const [picked, setColor] = useState<string>();
  const color = picked ?? studioParts?.suggestedColors[0] ?? FIRST_COLOUR;
  const [name, setName] = useState("");
  const [record, setRecord] = useState<DrawnPartRecord>(NEW_PART);
  // The saved part being edited: its type stays, and it is what Use in Build hands on unchanged.
  const [editing, setEditing] = useState<PlayerPartEntry>();
  // The latest save, and what was drawn then; undefined for a drawing not saved yet.
  const [saved, setSaved] = useState<{ entry: PlayerPartEntry; key: string }>();
  // The key of what was opened: an edited part is unsaved only once it changes.
  const [openedKey, setOpenedKey] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // Said in the panel while a reopened part is drawn against another base than its own.
  const [baseNote, setBaseNote] = useState<string>();
  // The grid during a stroke, before it becomes an undo step.
  const [live, setLive] = useState<Grid>();
  // A point being dragged and where, in canvas pixels.
  const [dragging, setDragging] = useState<{ point: DraggedPoint; u: number; v: number }>();
  // One more for each drawing begun, so a save that finishes after another has begun leaves it be.
  const generation = useRef(0);

  const present = history.present;
  const { grid: presentGrid, placed, frame } = present;
  const setup = useMemo((): DrawSetup | undefined => look && { ...frame, ...look }, [frame, look]);
  /** A new undo step from the present one. */
  const change = (edit: (snapshot: DrawSnapshot) => DrawSnapshot) =>
    setHistory((known) => commit(known, edit(known.present), sameSnapshot));

  /** Starts a drawing: a new one of a type, or a saved part to edit (`DrawRequest`). */
  const begin = useCallback(
    (k: PartsKit, open: DrawRequest | undefined) => {
      generation.current += 1;
      setLive(undefined);
      setDragging(undefined);
      setMessage(undefined);
      setSaved(undefined);
      setSaving(false);
      const entry = open?.entry;
      if (entry) {
        const { drawing } = entry;
        const type = entry.part.type;
        // The base part it was drawn against, for its sockets' depths and its ghost; the saved
        // part gives only where its points are.
        const original = packBase(k, drawing.baseId, type);
        const base = original ?? defaultBase(k.parts, type, k.roots);
        setBaseNote(original ? undefined : BASE_GONE);
        const opening: DrawSetup = {
          partType: type,
          baseId: base?.id ?? drawing.baseId,
          view: drawing.view,
          step: drawing.step,
          rule: drawing.rule,
          chubby: drawing.chubby,
          flatThickness: drawing.flatThickness,
        };
        const grid = Uint8Array.from(drawing.pixels);
        const drawn = voxelizeDrawing(drawing);
        const points = drawn ? placedFrom(entry.part, drawn, drawing.view) : NO_PLACED_POINTS;
        const { partType, baseId, view, ...rest } = opening;
        setHistory(startHistory({ grid, placed: points, frame: { partType, baseId, view } }));
        setLook(rest);
        setPalette(drawing.palette);
        setName(entry.name);
        setRecord(recordOf(entry));
        setEditing(entry);
        // Keyed by the base it was saved with, so a stand-in base is a change to save.
        const asSaved = { ...opening, baseId: drawing.baseId };
        setOpenedKey(drawKey(entry.name, drawingOf(grid, drawing.palette, asSaved), points));
        return;
      }
      const sections = k.sections;
      const type =
        sections.find((section) => section.type === open?.partType)?.type ?? sections[0]?.type;
      const base = type === undefined ? undefined : defaultBase(k.parts, type, k.roots);
      if (type === undefined || !base) return;
      const { view, rule } = recipeOf(type);
      setHistory(
        startHistory({
          grid: emptyGrid(),
          placed: NO_PLACED_POINTS,
          frame: { partType: type, baseId: base.id, view },
        }),
      );
      setLook({ step: base.part.step, rule, chubby: 1, flatThickness: 1 });
      setPalette([]);
      setName(defaultPartName(sections.find((s) => s.type === type)?.name ?? "part"));
      setRecord(NEW_PART);
      setEditing(undefined);
      setOpenedKey(undefined);
      setBaseNote(undefined);
    },
    [recipeOf],
  );

  // A new drawing once the parts are here (key 0), then each request (keys from 1).
  const opened = useRef<number>(undefined);
  useEffect(() => {
    const wantedKey = request?.key ?? 0;
    if (!kit || opened.current === wantedKey) return;
    opened.current = wantedKey;
    begin(kit, request);
  }, [kit, request, begin]);

  const typeName = (type: string) =>
    kit?.sections.find((section) => section.type === type)?.name ?? type;

  // The base parts to pick: the pack parts of the type, as the tray lists them.
  const bases = useMemo(
    () => (kit && setup ? kit.parts.filter(({ part }) => part.type === setup.partType) : []),
    [kit, setup],
  );
  const base = bases.find((choice) => choice.id === setup?.baseId) ?? bases[0];

  const drawing = useMemo(
    (): PartDrawing | undefined => setup && drawingOf(presentGrid, palette, setup),
    [presentGrid, palette, setup],
  );
  // Voxelized and fitted once per stroke, not while it is drawn (a fit takes up to ~12 ms).
  const drawn = useMemo(() => drawing && voxelizeDrawing(drawing), [drawing]);
  const view = frame.view;
  const fit = useMemo((): DrawnPartFit | undefined => {
    if (!drawn || !base) return undefined;
    try {
      return fitDrawnPart(drawn, base.part, overridesFor(placed, drawn, view));
    } catch (error) {
      console.warn("Could not fit the drawn part", error);
      return undefined;
    }
  }, [drawn, base, placed, view]);

  // What decides the saved part, for whether there is anything to save.
  const key = useMemo(() => drawing && drawKey(name, drawing, placed), [name, drawing, placed]);
  const baselineKey = saved?.key ?? openedKey;
  const unsaved =
    baselineKey === undefined ? !isBlank(presentGrid) : key !== undefined && key !== baselineKey;
  useEffect(() => {
    onUnsaved(unsaved);
  }, [onUnsaved, unsaved]);

  // The 3D preview: the part alone. Its WebGL context is made only while Draw mode is shown and
  // freed on leaving it (#240), and it gets the same assembly object until the part changes (#247).
  const previewBox = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<AssemblyView>();
  const hasKit = kit !== undefined;
  useEffect(() => {
    const element = previewBox.current;
    if (!active || !hasKit || !element) return;
    let created: AssemblyView;
    try {
      created = createAssemblyView(element);
    } catch (error) {
      console.warn("The part preview could not start", error);
      return;
    }
    setPreview(created);
    return () => {
      created.dispose();
      setPreview(undefined);
    };
  }, [active, hasKit]);
  const assembly = useMemo((): VoxelAssembly | undefined => {
    if (!fit) return undefined;
    const parsed = VoxelAssemblySchema.safeParse({
      parts: { drawn: fit.part },
      instances: [{ id: "drawn", part: "drawn" }],
    });
    return parsed.success ? parsed.data : undefined;
  }, [fit]);
  useEffect(() => preview?.setAssembly(assembly), [preview, assembly]);
  useEffect(
    () =>
      preview?.setHighlightedSockets(
        assembly?.parts.drawn?.sockets.map((socket) => ({
          instance: "drawn",
          socket: socket.id,
        })) ?? [],
      ),
    [preview, assembly],
  );

  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  /** A new type, base part or view: an undo step, with the points back where the base has them. */
  const changeFrame = (next: Partial<DrawFrame>) => {
    change((snapshot) => ({
      ...snapshot,
      frame: { ...snapshot.frame, ...next },
      placed: NO_PLACED_POINTS,
    }));
    setMessage(undefined);
  };
  const changeLook = (next: Partial<DrawLook>) => {
    setLook((known) => known && { ...known, ...next });
    setMessage(undefined);
  };

  const pickType = (type: string) => {
    if (!kit || !setup || editing || type === setup.partType) return;
    const next = defaultBase(kit.parts, type, kit.roots);
    if (!next) return;
    // A name still the old type's default follows the type.
    if (name === defaultPartName(typeName(setup.partType))) {
      setName(defaultPartName(typeName(type)));
    }
    const { view: recipeView, rule } = recipeOf(type);
    changeFrame({ partType: type, baseId: next.id, view: recipeView });
    changeLook({ step: next.part.step, rule });
  };

  const pickBase = (id: string) => {
    const next = bases.find((choice) => choice.id === id);
    if (!next) return;
    changeFrame({ baseId: id });
    changeLook({ step: next.part.step });
  };

  /** The palette index to paint with, adding the colour; undefined (and says so) when full. */
  const paintIndex = (): number | undefined => {
    const found = colourIndex(palette, color);
    if (!found) {
      setNotice("A part has at most 255 colours.");
      return undefined;
    }
    if (found.palette !== palette) setPalette(found.palette);
    return found.index;
  };

  // Strokes: the pen and the eraser paint every cell the pointer crosses, one undo step a stroke.
  const canvas = useRef<HTMLCanvasElement>(null);
  const stroke = useRef<{ grid: Grid; last: [number, number] }>(undefined);
  const strokeValue = useRef(0);
  const cellAt = (event: { clientX: number; clientY: number }): [number, number] | undefined => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box || box.width === 0) return undefined;
    const x = Math.floor(((event.clientX - box.left) / box.width) * DRAWING_GRID);
    const y = Math.floor(((event.clientY - box.top) / box.height) * DRAWING_GRID);
    return x >= 0 && y >= 0 && x < DRAWING_GRID && y < DRAWING_GRID ? [x, y] : undefined;
  };
  const endStroke = (keep: boolean) => {
    const done = stroke.current;
    stroke.current = undefined;
    setLive(undefined);
    if (done && keep) change((snapshot) => ({ ...snapshot, grid: done.grid }));
  };
  const onCanvasDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !setup) return;
    const cell = cellAt(event);
    if (!cell) return;
    const value = tool === "eraser" ? 0 : paintIndex();
    if (value === undefined) return;
    setMessage(undefined);
    if (tool === "fill") {
      change((snapshot) => ({
        ...snapshot,
        grid: floodFill(snapshot.grid, cell[0], cell[1], value),
      }));
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    strokeValue.current = value;
    const grid = paint(presentGrid, [cell], value);
    stroke.current = { grid, last: cell };
    setLive(grid);
  };
  const onCanvasMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const current = stroke.current;
    if (!current) return;
    const cell = cellAt(event);
    if (!cell) return;
    const grid = paint(
      current.grid,
      lineCells(current.last[0], current.last[1], cell[0], cell[1]),
      strokeValue.current,
    );
    stroke.current = { grid, last: cell };
    if (grid !== current.grid) setLive(grid);
  };

  // Points: dragged on the grid, fitted again when dropped.
  const pointAt = (event: { clientX: number; clientY: number }) => {
    const box = canvas.current?.getBoundingClientRect();
    if (!box || box.width === 0) return undefined;
    const snap = (value: number) =>
      Math.min(DRAWING_GRID, Math.max(0, Math.round(2 * value * DRAWING_GRID) / 2));
    return {
      u: snap((event.clientX - box.left) / box.width),
      v: snap((event.clientY - box.top) / box.height),
    };
  };
  const onPointDown = (point: DraggedPoint, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || stroke.current) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const at = pointAt(event);
    if (at) setDragging({ point, ...at });
  };
  const onPointMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragging) return;
    const at = pointAt(event);
    if (at && (at.u !== dragging.u || at.v !== dragging.v)) setDragging({ ...dragging, ...at });
  };
  const onPointUp = () => {
    const drop = dragging;
    setDragging(undefined);
    if (!drop || !drawn || !base || !fit) return;
    const next = dropPoint({
      drawn,
      base: base.part,
      view,
      placed,
      fit,
      dragged: drop.point,
      u: drop.u,
      v: drop.v,
    });
    change((snapshot) => ({ ...snapshot, placed: next }));
  };
  /** A drag cancelled (Escape, or the pointer lost): the point goes back where it was. */
  const cancelDrag = () => setDragging(undefined);

  // Strokes and drags in progress hold undo and redo off, so neither lands mid-edit.
  const busy = live !== undefined || dragging !== undefined;
  const step = (move: typeof undo) => {
    if (stroke.current) return;
    setHistory(move);
  };

  // Ctrl+Z and Ctrl+Y as in Build mode; P, E and F pick the tools; Escape drops a stroke or a drag.
  useEffect(() => {
    if (!keysEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (typing(event)) return;
      const keyName = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (!event.ctrlKey && !event.metaKey) return;
        const undoing = keyName === "z" && !event.shiftKey;
        const redoing = keyName === "y" || (keyName === "z" && event.shiftKey);
        if (!undoing && !redoing) return;
        if (!stroke.current && !dragging) setHistory(undoing ? undo : redo);
      } else if (keyName === "p") setTool("pen");
      else if (keyName === "e") setTool("eraser");
      else if (keyName === "f") setTool("fill");
      else if (keyName === "escape") {
        stroke.current = undefined;
        setLive(undefined);
        setDragging(undefined);
      } else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysEnabled, dragging]);

  // The grid, drawn: the base part's ghost under the pixels, the pixels, the cell lines, and the
  // ghost's outline over them, so it guides a trace and shows the scale while drawing.
  const shown = live ?? presentGrid;
  const ghost = useMemo(() => base && silhouette(base.part, view), [base, view]);
  const ghostScale = base && setup ? base.part.step / setup.step : 1;
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    context.fillStyle = "#f3f1ea";
    context.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
    const left = ghost ? (DRAWING_GRID - ghost.width * ghostScale) / 2 : 0;
    const top = ghost ? (DRAWING_GRID - ghost.height * ghostScale) / 2 : 0;
    const ghostAt = (x: number, y: number) =>
      !!ghost &&
      x >= 0 &&
      y >= 0 &&
      x < ghost.width &&
      y < ghost.height &&
      ghost.cells[x + ghost.width * y] === 1;
    const px = (cells: number) => cells * CELL_PX;
    if (ghost) {
      context.fillStyle = "rgb(40 70 110 / 22%)";
      for (let y = 0; y < ghost.height; y++) {
        for (let x = 0; x < ghost.width; x++) {
          if (!ghostAt(x, y)) continue;
          context.fillRect(
            px(left + x * ghostScale),
            px(top + y * ghostScale),
            px(ghostScale),
            px(ghostScale),
          );
        }
      }
    }
    for (let y = 0; y < DRAWING_GRID; y++) {
      for (let x = 0; x < DRAWING_GRID; x++) {
        const value = shown[x + DRAWING_GRID * y] ?? 0;
        if (value === 0) continue;
        context.fillStyle = palette[value - 1] ?? "#000000";
        context.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
      }
    }
    for (let i = 0; i <= DRAWING_GRID; i++) {
      context.fillStyle = i % 8 === 0 ? "rgb(0 0 0 / 22%)" : "rgb(0 0 0 / 8%)";
      // Two canvas pixels wide, so a line survives the canvas being shown smaller.
      const at = Math.min(Math.max(i * CELL_PX - 1, 0), CANVAS_PX - 2);
      context.fillRect(at, 0, 2, CANVAS_PX);
      context.fillRect(0, at, CANVAS_PX, 2);
    }
    if (ghost) {
      // The outline: every side of a ghost cell with no ghost cell beyond it, dashed, light under
      // dark so it shows on any colour.
      context.beginPath();
      for (let y = 0; y < ghost.height; y++) {
        for (let x = 0; x < ghost.width; x++) {
          if (!ghostAt(x, y)) continue;
          const [x0, y0] = [px(left + x * ghostScale), px(top + y * ghostScale)];
          const [x1, y1] = [px(left + (x + 1) * ghostScale), px(top + (y + 1) * ghostScale)];
          if (!ghostAt(x, y - 1)) context.rect(x0, y0, x1 - x0, 0);
          if (!ghostAt(x, y + 1)) context.rect(x0, y1, x1 - x0, 0);
          if (!ghostAt(x - 1, y)) context.rect(x0, y0, 0, y1 - y0);
          if (!ghostAt(x + 1, y)) context.rect(x1, y0, 0, y1 - y0);
        }
      }
      context.setLineDash([]);
      context.lineWidth = 5;
      context.strokeStyle = "rgb(255 255 255 / 70%)";
      context.stroke();
      context.setLineDash([8, 6]);
      context.lineWidth = 3;
      context.strokeStyle = "rgb(30 60 110 / 90%)";
      context.stroke();
    }
  }, [shown, palette, ghost, ghostScale]);

  // The sockets on the grid. A mirror pair at the same place, as seen from the side, shares one
  // marker; any other sockets at one place each get their own, a little aside.
  const markers = useMemo((): SocketMarker[] => {
    if (!fit || !drawn || !base) return [];
    const list: SocketMarker[] = [];
    const deeper = (a: DrawnSocketDepth, b: DrawnSocketDepth) =>
      DRAWN_SOCKET_DEPTHS.indexOf(b) > DRAWN_SOCKET_DEPTHS.indexOf(a) ? b : a;
    for (const socket of fit.part.sockets) {
      const { u, v } = toCanvas(socket.position, drawn, view);
      const sits = fit.sockets[socket.id];
      const depth = sits?.depth ?? "loose";
      const shallow = sits?.shallow ?? false;
      const partner = partnerOf(base.part, socket.id);
      const pair = list.find(
        (marker) =>
          marker.u === u && marker.v === v && partner !== undefined && marker.ids.includes(partner),
      );
      if (pair) {
        pair.ids.push(socket.id);
        pair.depth = deeper(pair.depth, depth);
        pair.shallow ||= shallow;
        continue;
      }
      const offset = list.filter((marker) => marker.u === u && marker.v === v).length;
      list.push({ u, v, offset, ids: [socket.id], depth, shallow });
    }
    return list;
  }, [fit, drawn, base, view]);
  const attachAt = fit && drawn ? toCanvas(fit.part.attach, drawn, view) : undefined;
  const shallowCount = fit ? Object.values(fit.sockets).filter((s) => s.shallow).length : 0;
  const hasSockets = (fit?.part.sockets.length ?? 0) > 0;

  const placeAt = (point: DraggedPoint, u: number, v: number) =>
    dragging &&
    dragging.point.kind === point.kind &&
    (point.kind === "attach" ||
      (dragging.point.kind === "socket" && dragging.point.id === point.id))
      ? { u: dragging.u, v: dragging.v }
      : { u, v };

  const nameOk = name.trim() !== "";
  const canSave = !!fit && !!drawing && nameOk && !saving;
  // A saved part with nothing changed since: there is nothing to save.
  const upToDate = record.uuid !== undefined && !unsaved;

  /**
   * Saves the part if it changed since its last save: the saved entry, or undefined if it failed
   * or another drawing began while it was saved (which the save then leaves as it is).
   */
  const save = async (): Promise<PlayerPartEntry | undefined> => {
    if (!fit || !drawing || !key || !canSave) return undefined;
    if (upToDate) return saved?.entry ?? editing;
    const started = generation.current;
    setSaving(true);
    setMessage(undefined);
    try {
      const entry = partEntry({
        record,
        name,
        part: fit.part,
        drawing,
        now: new Date().toISOString(),
        newUuid: () => crypto.randomUUID(),
      });
      await savePart(store, entry);
      onSaved(entry);
      if (started !== generation.current) return undefined;
      setRecord(recordOf(entry));
      setSaved({ entry, key });
      return entry;
    } catch (error) {
      if (started === generation.current) {
        setMessage(`Your part couldn't be saved: ${String(error)}`);
      }
      return undefined;
    } finally {
      if (started === generation.current) setSaving(false);
    }
  };

  const sendToBuild = async () => {
    const started = generation.current;
    const entry = await save();
    if (entry && started === generation.current) onUseInBuild(entry);
  };

  const marks = setup ? rulerMarks(setup.step) : [];
  // The colours on the grid now, in the palette's order.
  const used = useMemo(() => compactDrawing(presentGrid, palette).palette, [presentGrid, palette]);
  const ready = kit && setup && base;
  const sizeText =
    fit && setup
      ? `${centimetres(fit.part.size.x * setup.step)} × ${centimetres(fit.part.size.y * setup.step)} × ${centimetres(fit.part.size.z * setup.step)}`
      : undefined;
  const against = fit && base ? sizeAgainst(fit.part, base.part) : undefined;
  const isDragging = dragging !== undefined;

  return (
    <div
      className={isDragging ? "studio-mode draw-mode dragging" : "studio-mode draw-mode"}
      hidden={!active}
    >
      <div className="toolbar" role="toolbar" aria-label="Drawing tools">
        {modeSwitch}
        <div className="tool-groups" inert={!ready}>
          <div className="tool-group" role="group" aria-label="Tools">
            <ToolButton
              label={TOOL_LABELS.pen}
              pressed={tool === "pen"}
              onClick={() => setTool("pen")}
            >
              <path className="stroke" d="M3 13l1-3.5 7-7 2.5 2.5-7 7zM9.5 4l2.5 2.5" />
            </ToolButton>
            <ToolButton
              label={TOOL_LABELS.eraser}
              pressed={tool === "eraser"}
              onClick={() => setTool("eraser")}
            >
              <path className="stroke" d="M6 13.5h7.5M2.5 10l6-6.5 5 5-5 5.5H6z" />
            </ToolButton>
            <ToolButton
              label={TOOL_LABELS.fill}
              pressed={tool === "fill"}
              onClick={() => setTool("fill")}
            >
              <path className="stroke" d="M2.5 6.5h8l-1 7h-6zM3.5 6.5a3 3.5 0 0 1 6 0" />
              <path d="M13.5 11.2a1.3 1.3 0 0 1-2.6 0c0-1 1.3-2.7 1.3-2.7s1.3 1.7 1.3 2.7z" />
            </ToolButton>
          </div>
          <div className="tool-group">
            <ToolButton
              label="Undo (Ctrl+Z)"
              disabled={busy || !canUndo(history)}
              onClick={() => step(undo)}
            >
              <path className="stroke" d="M5.5 3L2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8h-3" />
            </ToolButton>
            <ToolButton
              label="Redo (Ctrl+Y)"
              disabled={busy || !canRedo(history)}
              onClick={() => step(redo)}
            >
              <path className="stroke" d="M10.5 3l3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8h3" />
            </ToolButton>
            <ToolButton
              label="Clear the grid"
              disabled={isBlank(presentGrid)}
              onClick={() => change((snapshot) => ({ ...snapshot, grid: emptyGrid() }))}
            >
              <path className="stroke" d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
            </ToolButton>
          </div>
          <div className="tool-group">
            <button
              type="button"
              className="text-button"
              title="Start a new part of this type"
              disabled={!setup}
              onClick={() => setup && onNew(setup.partType)}
            >
              New part
            </button>
          </div>
        </div>
      </div>
      <div className="workspace">
        <aside className="draw-colours" aria-label="Colours" inert={!ready}>
          <h3>Colours</h3>
          <div className="palette" role="group" aria-label="Suggested colours">
            {(kit?.suggestedColors ?? []).map((swatch) => (
              <Swatch
                key={swatch}
                color={swatch}
                pressed={tool !== "eraser" && color === swatch}
                onPick={() => {
                  setColor(swatch);
                  if (tool === "eraser") setTool("pen");
                }}
              />
            ))}
          </div>
          {used.length > 0 && (
            <>
              <h3>In this part</h3>
              <div className="palette" role="group" aria-label="Colours in this part">
                {used.map((swatch) => (
                  <Swatch
                    key={swatch}
                    color={swatch}
                    pressed={tool !== "eraser" && color === swatch}
                    onPick={() => {
                      setColor(swatch);
                      if (tool === "eraser") setTool("pen");
                    }}
                  />
                ))}
              </div>
            </>
          )}
          <label className="colour-picker">
            <input
              type="color"
              value={color}
              onChange={(event) => {
                setColor(event.target.value.toLowerCase());
                if (tool === "eraser") setTool("pen");
              }}
            />
            <span>Any colour…</span>
          </label>
        </aside>
        <div className="grid-area">
          {ready ? (
            <div className="grid-sheet">
              <canvas
                ref={canvas}
                className={tool === "fill" ? "draw-grid filling" : "draw-grid"}
                width={CANVAS_PX}
                height={CANVAS_PX}
                role="img"
                aria-label={`Drawing grid, ${DRAWING_GRID} by ${DRAWING_GRID} cubes of ${centimetres(setup.step)}`}
                onPointerDown={onCanvasDown}
                onPointerMove={onCanvasMove}
                onPointerUp={() => endStroke(true)}
                onPointerCancel={() => endStroke(false)}
                onLostPointerCapture={() => endStroke(true)}
              />
              <div className="ruler ruler-top" aria-hidden="true">
                {marks.map(({ cells, label }) => (
                  <span key={label} style={{ left: `${(cells / DRAWING_GRID) * 100}%` }}>
                    {label}
                  </span>
                ))}
              </div>
              <div className="ruler ruler-left" aria-hidden="true">
                {marks.map(({ cells, label }) => (
                  <span key={label} style={{ top: `${(cells / DRAWING_GRID) * 100}%` }}>
                    {label}
                  </span>
                ))}
              </div>
              <span className="ruler-unit" aria-hidden="true">
                cm
              </span>
              {markers.map((marker) => {
                const first = marker.ids[0] ?? "";
                const point: DraggedPoint = { kind: "socket", id: first };
                return (
                  <PointMarker
                    key={marker.ids.join(" ")}
                    className={`point socket depth-${marker.depth}${marker.shallow ? " shallow" : ""}`}
                    {...placeAt(point, marker.u, marker.v)}
                    offset={marker.offset}
                    label={`Socket ${marker.ids.join(" and ")}: ${DEPTH_LABELS[marker.depth]}${marker.shallow ? ", shallower than on its base part" : ""}. Drag to move`}
                    onPointerDown={(event) => onPointDown(point, event)}
                    onPointerMove={onPointMove}
                    onPointerUp={onPointUp}
                    onCancel={cancelDrag}
                  />
                );
              })}
              {attachAt && (
                <PointMarker
                  className={fit?.attachOnCubes ? "point attach" : "point attach loose"}
                  {...placeAt({ kind: "attach" }, attachAt.u, attachAt.v)}
                  offset={0}
                  label={`Attach point${fit?.attachOnCubes ? "" : ", off the part"}: drag to move`}
                  onPointerDown={(event) => onPointDown({ kind: "attach" }, event)}
                  onPointerMove={onPointMove}
                  onPointerUp={onPointUp}
                  onCancel={cancelDrag}
                />
              )}
            </div>
          ) : (
            <p className="stage-message" role="status">
              {studioParts && !kit ? NO_DRAW_PARTS : "Getting the parts…"}
            </p>
          )}
          {ready && (
            <p className="stage-hint" aria-live="polite">
              {isBlank(presentGrid)
                ? "Draw your part on the grid. The dashed outline is its base part, to trace."
                : hasSockets
                  ? "Drag the diamond (where it attaches) and the dots (where parts go)."
                  : "Drag the diamond to move where it attaches."}
            </p>
          )}
          {notice && (
            <p key={notice} className="stage-notice" role="status">
              {notice}
            </p>
          )}
        </div>
        <aside className="side-panel draw-panel">
          <div ref={previewBox} className="part-preview" role="img" aria-label="Your part in 3D">
            {!fit && <span className="preview-empty">Your part shows here.</span>}
          </div>
          <div className="draw-details">
            {setup && kit && (
              <>
                <label className="field">
                  <span>Name</span>
                  <input
                    type="text"
                    value={name}
                    placeholder="Part"
                    maxLength={MAX_PLAYER_PART_NAME_LENGTH}
                    spellCheck={false}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Part type</span>
                  <select
                    value={setup.partType}
                    disabled={editing !== undefined}
                    title={editing ? "A saved part keeps its type" : undefined}
                    onChange={(event) => pickType(event.target.value)}
                  >
                    {kit.sections.map((section) => (
                      <option key={section.type} value={section.type}>
                        {section.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Base part (its joints and outline)</span>
                  <select value={base?.id} onChange={(event) => pickBase(event.target.value)}>
                    {bases.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="field-row">
                  <label className="field">
                    <span>Cube size</span>
                    <select
                      value={setup.step}
                      onChange={(event) =>
                        changeLook({ step: Number(event.target.value) as VoxelStep })
                      }
                    >
                      {VOXEL_STEPS.map((option) => (
                        <option key={option} value={option}>
                          {centimetres(option)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Drawn from</span>
                    <select
                      value={setup.view}
                      onChange={(event) =>
                        changeFrame({ view: event.target.value as PartDrawingView })
                      }
                    >
                      {PART_DRAWING_VIEWS.map((option) => (
                        <option key={option} value={option}>
                          {VIEW_LABELS[option]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <fieldset className="field">
                  <legend>Depth</legend>
                  <Segmented
                    label="Depth rule"
                    options={PART_DRAWING_RULES}
                    value={setup.rule}
                    labelOf={(rule) => RULE_LABELS[rule]}
                    onChange={(rule) => changeLook({ rule })}
                  />
                  {setup.rule === "flat" ? (
                    <Segmented
                      label="Thickness"
                      options={[1, 2] as const}
                      value={setup.flatThickness}
                      labelOf={(cubes) => (cubes === 1 ? "1 cube" : "2 cubes")}
                      onChange={(flatThickness) => changeLook({ flatThickness })}
                    />
                  ) : (
                    <label className="chubby">
                      <span>Chubby</span>
                      <input
                        type="range"
                        min={MIN_CHUBBY}
                        max={MAX_CHUBBY}
                        step={0.05}
                        value={setup.chubby}
                        onChange={(event) => changeLook({ chubby: Number(event.target.value) })}
                      />
                      <output>{setup.chubby.toFixed(2)}×</output>
                    </label>
                  )}
                </fieldset>
                {baseNote && (
                  <p className="release-hint" role="status">
                    {baseNote}
                  </p>
                )}
                {sizeText && against !== undefined && (
                  <p className="size-readout">
                    {sizeText}
                    <br />
                    <span className="measured">About {against.toFixed(1)}× its base part</span>
                  </p>
                )}
                {against !== undefined && against > MUCH_BIGGER && (
                  <p className="release-hint" role="status">
                    {MUCH_BIGGER_HINT}
                  </p>
                )}
                {fit && (hasSockets || !fit.attachOnCubes) && (
                  <div className="points-key">
                    {hasSockets && (
                      <p>
                        <span className="key-dot depth-own" /> deep enough
                        <span className="key-dot depth-finer" /> smaller parts only
                        <span className="key-dot depth-touching" /> too shallow
                      </p>
                    )}
                    {shallowCount > 0 && (
                      <p className="release-hint blocking" role="status">
                        {shallowCount === 1 ? "A socket sits" : `${shallowCount} sockets sit`} less
                        deep than on the base part: drag {shallowCount === 1 ? "it" : "them"} into a
                        thicker place or make the part deeper. Build will say which parts don&apos;t
                        fit.
                      </p>
                    )}
                    <button
                      type="button"
                      className="text-link"
                      disabled={!placed.attach && Object.keys(placed.sockets).length === 0}
                      onClick={() =>
                        change((snapshot) => ({ ...snapshot, placed: NO_PLACED_POINTS }))
                      }
                    >
                      Put the points back where the base part has them
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="release-slot">
            {message && (
              <p className="release-error" role="alert">
                {message}
              </p>
            )}
            {ready && !fit && (
              <p className="release-hint" role="status">
                Draw your part first.
              </p>
            )}
            {ready && fit && !nameOk && (
              <p className="release-hint" role="status">
                Give your part a name.
              </p>
            )}
            <div className="step-buttons">
              <button
                type="button"
                className="back save"
                disabled={!canSave || upToDate}
                aria-busy={saving}
                onClick={() => void save()}
              >
                {saving ? "Saving…" : upToDate ? "Saved" : "Save"}
              </button>
              <button
                type="button"
                className="release"
                disabled={!canSave}
                onClick={() => void sendToBuild()}
              >
                Use in Build →
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** A colour to paint with. */
function Swatch(props: { color: string; pressed: boolean; onPick(): void }) {
  return (
    <button
      type="button"
      className="swatch"
      title={props.color}
      aria-label={`Paint with ${props.color}`}
      aria-pressed={props.pressed}
      style={{ background: props.color }}
      onClick={props.onPick}
    />
  );
}

/**
 * A row of radio buttons. Only the checked one is in the tab order, and the arrow keys move the
 * choice along the row, as a radio group's do.
 */
function Segmented<T extends string | number>(props: {
  label: string;
  options: readonly T[];
  value: T;
  labelOf(option: T): string;
  onChange(option: T): void;
}) {
  const { options, value, onChange } = props;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const by = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (by === undefined) return;
    event.preventDefault();
    const at = (options.indexOf(value) + by + options.length) % options.length;
    const next = options[at];
    if (next === undefined) return;
    onChange(next);
    (event.currentTarget.parentElement?.children[at] as HTMLElement | undefined)?.focus();
  };
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          tabIndex={value === option ? 0 : -1}
          onClick={() => onChange(option)}
          onKeyDown={onKeyDown}
        >
          {props.labelOf(option)}
        </button>
      ))}
    </div>
  );
}

/** A draggable point on the grid, placed in canvas pixels. */
function PointMarker(props: {
  className: string;
  u: number;
  v: number;
  /** Markers before it at the same place: it is drawn this many steps aside. */
  offset: number;
  label: string;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(): void;
  /** The drag was cancelled or the pointer lost: the point goes back. */
  onCancel(): void;
}) {
  return (
    <span
      className={props.className}
      style={{
        left: `${(props.u / DRAWING_GRID) * 100}%`,
        top: `${(props.v / DRAWING_GRID) * 100}%`,
        marginLeft: `${props.offset * 9}px`,
        marginTop: `${props.offset * 9}px`,
      }}
      title={props.label}
      aria-label={props.label}
      role="img"
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onCancel}
      onLostPointerCapture={props.onCancel}
    />
  );
}
