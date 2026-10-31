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
  type VoxelPart,
  type VoxelStep,
} from "@living-diorama/content-schema";
import type { PartsStore } from "@living-diorama/desktop-integration";
import { createAssemblyView, type AssemblyView } from "@living-diorama/renderer";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { partDrawingRecipeLookup } from "../part-types";
import type { StudioParts } from "../studio-protocol";
import {
  NEW_PART,
  defaultBase,
  drawKey,
  drawingOf,
  defaultPartName,
  partEntry,
  recordOf,
  savePart,
  type DrawSetup,
  type DrawnPartRecord,
} from "./draw-entry";
import {
  NO_PLACED_POINTS,
  dropPoint,
  overridesFor,
  placedFrom,
  silhouette,
  toCanvas,
  type DraggedPoint,
  type PlacedPoints,
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
  type GridHistory,
  type GridTool,
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

/** A base part to pick. */
interface BaseChoice {
  id: string;
  name: string;
  part: VoxelPart;
}

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
  /** A part was saved. */
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

  const [setup, setSetup] = useState<DrawSetup>();
  const [history, setHistory] = useState<GridHistory>(() => startHistory());
  const [palette, setPalette] = useState<readonly string[]>([]);
  const [tool, setTool] = useState<GridTool>("pen");
  // The colour picked to paint with; the packs' first suggested one until then.
  const [picked, setColor] = useState<string>();
  const color = picked ?? studioParts?.suggestedColors[0] ?? FIRST_COLOUR;
  const [placed, setPlaced] = useState<PlacedPoints>(NO_PLACED_POINTS);
  const [name, setName] = useState("");
  const [record, setRecord] = useState<DrawnPartRecord>(NEW_PART);
  // The saved part being edited, offered as its own base so its points stay where they were.
  const [editing, setEditing] = useState<PlayerPartEntry>();
  // The latest save, and what was drawn then; undefined for a drawing not saved yet.
  const [saved, setSaved] = useState<{ entry: PlayerPartEntry; key: string }>();
  // The key of what was opened: an edited part is unsaved only once it changes.
  const [openedKey, setOpenedKey] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // The grid during a stroke, before it becomes an undo step.
  const [live, setLive] = useState<Grid>();
  // A point being dragged and where, in canvas pixels.
  const [dragging, setDragging] = useState<{ point: DraggedPoint; u: number; v: number }>();

  /** Starts a drawing: a new one of a type, or a saved part to edit (`DrawRequest`). */
  const begin = useCallback(
    (k: PartsKit, open: DrawRequest | undefined) => {
      setLive(undefined);
      setDragging(undefined);
      setMessage(undefined);
      setSaved(undefined);
      const entry = open?.entry;
      if (entry) {
        const { drawing } = entry;
        const drawn = voxelizeDrawing(drawing);
        const opening: DrawSetup = {
          partType: entry.part.type,
          baseId: entry.id,
          step: drawing.step,
          view: drawing.view,
          rule: drawing.rule,
          chubby: drawing.chubby,
          flatThickness: drawing.flatThickness,
        };
        const grid = Uint8Array.from(drawing.pixels);
        const points = drawn ? placedFrom(entry.part, drawn, drawing.view) : NO_PLACED_POINTS;
        setSetup(opening);
        setHistory(startHistory(grid));
        setPalette(drawing.palette);
        setPlaced(points);
        setName(entry.name);
        setRecord(recordOf(entry));
        setEditing(entry);
        setOpenedKey(
          drawKey(entry.name, drawingOf(grid, drawing.palette, opening), entry.id, points),
        );
        return;
      }
      const sections = k.sections;
      const type =
        sections.find((section) => section.type === open?.partType)?.type ?? sections[0]?.type;
      const base = type === undefined ? undefined : defaultBase(k.parts, type, k.roots);
      if (type === undefined || !base) return;
      setSetup({
        partType: type,
        baseId: base.id,
        step: base.part.step,
        ...recipeOf(type),
        chubby: 1,
        flatThickness: 1,
      });
      setHistory(startHistory());
      setPalette([]);
      setPlaced(NO_PLACED_POINTS);
      setName(defaultPartName(sections.find((s) => s.type === type)?.name ?? "part"));
      setRecord(NEW_PART);
      setEditing(undefined);
      setOpenedKey(undefined);
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

  const bases = useMemo((): BaseChoice[] => {
    if (!kit || !setup) return [];
    const own =
      editing && editing.part.type === setup.partType
        ? [{ id: editing.id, name: `${editing.name} (as saved)`, part: editing.part }]
        : [];
    const pack = kit.parts
      .filter(({ part }) => part.type === setup.partType)
      .map(({ id, name: partName, part }) => ({ id, name: partName, part }));
    return [...own, ...pack];
  }, [kit, setup, editing]);
  const base = bases.find((choice) => choice.id === setup?.baseId) ?? bases[0];

  const present = history.present;
  const drawing = useMemo(
    (): PartDrawing | undefined => setup && drawingOf(present, palette, setup),
    [present, palette, setup],
  );
  // Voxelized and fitted once per stroke, not while it is drawn (a fit takes up to ~12 ms).
  const drawn = useMemo(() => drawing && voxelizeDrawing(drawing), [drawing]);
  const view = setup?.view ?? "side";
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
  const key = useMemo(
    () => drawing && setup && drawKey(name, drawing, setup.baseId, placed),
    [name, drawing, setup, placed],
  );
  const baselineKey = saved?.key ?? openedKey;
  const unsaved =
    baselineKey === undefined ? !isBlank(present) : key !== undefined && key !== baselineKey;
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

  const changeSetup = (change: Partial<DrawSetup>, resetPoints = false) => {
    setSetup((known) => known && { ...known, ...change });
    if (resetPoints) setPlaced(NO_PLACED_POINTS);
    setMessage(undefined);
  };

  const pickType = (type: string) => {
    if (!kit || !setup || type === setup.partType) return;
    const next = defaultBase(kit.parts, type, kit.roots);
    if (!next) return;
    // A name still the old type's default follows the type.
    if (name === defaultPartName(typeName(setup.partType))) {
      setName(defaultPartName(typeName(type)));
    }
    changeSetup({ partType: type, baseId: next.id, step: next.part.step, ...recipeOf(type) }, true);
  };

  const pickBase = (id: string) => {
    const next = bases.find((choice) => choice.id === id);
    if (next) changeSetup({ baseId: id, step: next.part.step }, true);
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
    if (done && keep) setHistory((known) => commit(known, done.grid));
  };
  const onCanvasDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !setup) return;
    const cell = cellAt(event);
    if (!cell) return;
    const value = tool === "eraser" ? 0 : paintIndex();
    if (value === undefined) return;
    setMessage(undefined);
    if (tool === "fill") {
      setHistory((known) => commit(known, floodFill(known.present, cell[0], cell[1], value)));
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    strokeValue.current = value;
    const grid = paint(present, [cell], value);
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
    if (event.button !== 0) return;
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
    setPlaced(
      dropPoint({
        drawn,
        base: base.part,
        view,
        placed,
        fit,
        dragged: drop.point,
        u: drop.u,
        v: drop.v,
      }),
    );
  };

  // Ctrl+Z and Ctrl+Y as in Build mode; P, E and F pick the tools; Escape drops a stroke or a drag.
  useEffect(() => {
    if (!keysEnabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (typing(event)) return;
      const keyName = event.key.toLowerCase();
      if (event.ctrlKey || event.metaKey || event.altKey) {
        if (!event.ctrlKey && !event.metaKey) return;
        if (keyName === "z" && !event.shiftKey) setHistory(undo);
        else if (keyName === "y" || (keyName === "z" && event.shiftKey)) setHistory(redo);
        else return;
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
  }, [keysEnabled]);

  // The grid, drawn: the base part's ghost, the pixels, and lines every cell.
  const shown = live ?? present;
  // Not for the edited part as its own base: the drawing is that shape already.
  const ghost = useMemo(
    () => (base && base.id !== editing?.id ? silhouette(base.part, view) : undefined),
    [base, editing, view],
  );
  const ghostScale = base && setup ? base.part.step / setup.step : 1;
  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    context.fillStyle = "#f3f1ea";
    context.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
    if (ghost) {
      const left = (DRAWING_GRID - ghost.width * ghostScale) / 2;
      const top = (DRAWING_GRID - ghost.height * ghostScale) / 2;
      context.fillStyle = "rgb(60 80 60 / 16%)";
      const size = ghostScale * CELL_PX;
      for (let y = 0; y < ghost.height; y++) {
        for (let x = 0; x < ghost.width; x++) {
          if (!ghost.cells[x + ghost.width * y]) continue;
          context.fillRect(
            (left + x * ghostScale) * CELL_PX,
            (top + y * ghostScale) * CELL_PX,
            size,
            size,
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
  }, [shown, palette, ghost, ghostScale]);

  // The points on the grid. Points at the same place, such as a mirror pair seen from the side,
  // share one marker.
  const markers = useMemo(() => {
    if (!fit || !drawn) return [];
    const at = new Map<
      string,
      { u: number; v: number; ids: string[]; depths: DrawnSocketDepth[]; shallow: boolean }
    >();
    for (const socket of fit.part.sockets) {
      const { u, v } = toCanvas(socket.position, drawn, view);
      const where = `${u},${v}`;
      const known = at.get(where) ?? { u, v, ids: [], depths: [], shallow: false };
      const sits = fit.sockets[socket.id];
      known.ids.push(socket.id);
      if (sits) known.depths.push(sits.depth);
      known.shallow ||= sits?.shallow ?? false;
      at.set(where, known);
    }
    return [...at.values()];
  }, [fit, drawn, view]);
  const attachAt = fit && drawn ? toCanvas(fit.part.attach, drawn, view) : undefined;
  const shallowCount = fit ? Object.values(fit.sockets).filter((s) => s.shallow).length : 0;

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

  /** Saves the part if it changed since its last save; the saved entry, or undefined if it failed. */
  const save = async (): Promise<PlayerPartEntry | undefined> => {
    if (!fit || !drawing || !key || !canSave) return undefined;
    if (upToDate) return saved?.entry ?? editing;
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
      setRecord(recordOf(entry));
      setSaved({ entry, key });
      onSaved(entry);
      return entry;
    } catch (error) {
      setMessage(`Your part couldn't be saved: ${String(error)}`);
      return undefined;
    } finally {
      setSaving(false);
    }
  };

  const sendToBuild = async () => {
    const entry = await save();
    if (entry) onUseInBuild(entry);
  };

  const marks = setup ? rulerMarks(setup.step) : [];
  // The colours on the grid now, in the palette's order.
  const used = useMemo(() => compactDrawing(present, palette).palette, [present, palette]);
  const ready = kit && setup;
  const sizeText =
    fit && setup
      ? `${centimetres(fit.part.size.x * setup.step)} × ${centimetres(fit.part.size.y * setup.step)} × ${centimetres(fit.part.size.z * setup.step)}`
      : undefined;
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
              disabled={!canUndo(history)}
              onClick={() => setHistory(undo)}
            >
              <path className="stroke" d="M5.5 3L2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8h-3" />
            </ToolButton>
            <ToolButton
              label="Redo (Ctrl+Y)"
              disabled={!canRedo(history)}
              onClick={() => setHistory(redo)}
            >
              <path className="stroke" d="M10.5 3l3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8h3" />
            </ToolButton>
            <ToolButton
              label="Clear the grid"
              disabled={isBlank(present)}
              onClick={() => setHistory((known) => commit(known, emptyGrid()))}
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
              <button
                key={swatch}
                type="button"
                className="swatch"
                title={swatch}
                aria-label={`Paint with ${swatch}`}
                aria-pressed={tool !== "eraser" && color === swatch}
                style={{ background: swatch }}
                onClick={() => {
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
                  <button
                    key={swatch}
                    type="button"
                    className="swatch"
                    title={swatch}
                    aria-label={`Paint with ${swatch}`}
                    aria-pressed={tool !== "eraser" && color === swatch}
                    style={{ background: swatch }}
                    onClick={() => {
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
                <em>cm</em>
              </div>
              <div className="ruler ruler-left" aria-hidden="true">
                {marks.map(({ cells, label }) => (
                  <span key={label} style={{ top: `${(cells / DRAWING_GRID) * 100}%` }}>
                    {label}
                  </span>
                ))}
              </div>
              {attachAt && (
                <PointMarker
                  className={fit?.attachOnCubes ? "point attach" : "point attach loose"}
                  {...placeAt({ kind: "attach" }, attachAt.u, attachAt.v)}
                  label={`Attach point${fit?.attachOnCubes ? "" : ", off the part"}: drag to move`}
                  onPointerDown={(event) => onPointDown({ kind: "attach" }, event)}
                  onPointerMove={onPointMove}
                  onPointerUp={onPointUp}
                />
              )}
              {markers.map((marker) => {
                const first = marker.ids[0] ?? "";
                const point: DraggedPoint = { kind: "socket", id: first };
                const worst = marker.depths.reduce<DrawnSocketDepth>(
                  (a, b) =>
                    DRAWN_SOCKET_DEPTHS.indexOf(b) > DRAWN_SOCKET_DEPTHS.indexOf(a) ? b : a,
                  "own",
                );
                return (
                  <PointMarker
                    key={marker.ids.join(" ")}
                    className={`point socket depth-${worst}${marker.shallow ? " shallow" : ""}`}
                    {...placeAt(point, marker.u, marker.v)}
                    label={`Socket ${marker.ids.join(" and ")}: ${DEPTH_LABELS[worst]}${marker.shallow ? ", shallower than its base part's" : ""}. Drag to move`}
                    onPointerDown={(event) => onPointDown(point, event)}
                    onPointerMove={onPointMove}
                    onPointerUp={onPointUp}
                  />
                );
              })}
            </div>
          ) : (
            <p className="stage-message" role="status">
              {studioParts && !kit ? NO_DRAW_PARTS : "Getting the parts…"}
            </p>
          )}
          {ready && (
            <p className="stage-hint" aria-live="polite">
              {isBlank(present)
                ? "Draw your part on the grid. The faint shape is its base part, to trace."
                : "Drag the diamond (where it attaches) and the dots (where parts go)."}
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
          {setup && kit && (
            <div className="draw-details">
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
                <select value={setup.partType} onChange={(event) => pickType(event.target.value)}>
                  {kit.sections.map((section) => (
                    <option key={section.type} value={section.type}>
                      {section.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Base part (its joints and ghost)</span>
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
                      changeSetup({ step: Number(event.target.value) as VoxelStep })
                    }
                  >
                    {VOXEL_STEPS.map((step) => (
                      <option key={step} value={step}>
                        {centimetres(step)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Drawn from</span>
                  <select
                    value={setup.view}
                    onChange={(event) =>
                      changeSetup({ view: event.target.value as PartDrawingView }, true)
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
                <div className="segmented" role="radiogroup" aria-label="Depth rule">
                  {PART_DRAWING_RULES.map((rule) => (
                    <button
                      key={rule}
                      type="button"
                      role="radio"
                      aria-checked={setup.rule === rule}
                      onClick={() => changeSetup({ rule })}
                    >
                      {RULE_LABELS[rule]}
                    </button>
                  ))}
                </div>
                {setup.rule === "flat" ? (
                  <div className="segmented" role="radiogroup" aria-label="Thickness">
                    {([1, 2] as const).map((cubes) => (
                      <button
                        key={cubes}
                        type="button"
                        role="radio"
                        aria-checked={setup.flatThickness === cubes}
                        onClick={() => changeSetup({ flatThickness: cubes })}
                      >
                        {cubes === 1 ? "1 cube" : "2 cubes"}
                      </button>
                    ))}
                  </div>
                ) : (
                  <label className="chubby">
                    <span>Chubby</span>
                    <input
                      type="range"
                      min={MIN_CHUBBY}
                      max={MAX_CHUBBY}
                      step={0.05}
                      value={setup.chubby}
                      onChange={(event) => changeSetup({ chubby: Number(event.target.value) })}
                    />
                    <output>{setup.chubby.toFixed(2)}×</output>
                  </label>
                )}
              </fieldset>
              {sizeText && <p className="size-readout">{sizeText}</p>}
              {fit && (fit.part.sockets.length > 0 || !fit.attachOnCubes) && (
                <div className="points-key">
                  <p>
                    <span className="key-dot depth-own" /> deep enough
                    <span className="key-dot depth-finer" /> smaller parts only
                    <span className="key-dot depth-touching" /> too shallow
                  </p>
                  {shallowCount > 0 && (
                    <p className="release-hint blocking" role="status">
                      {shallowCount === 1 ? "A socket sits" : `${shallowCount} sockets sit`} less
                      deep than on the base part: drag {shallowCount === 1 ? "it" : "them"} into a
                      thicker place or make the part deeper. Build will say which parts don't fit.
                    </p>
                  )}
                  <button
                    type="button"
                    className="text-link"
                    disabled={!placed.attach && Object.keys(placed.sockets).length === 0}
                    onClick={() => setPlaced(NO_PLACED_POINTS)}
                  >
                    Put the points back where the base part has them
                  </button>
                </div>
              )}
            </div>
          )}
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

/** A draggable point on the grid, placed in canvas pixels. */
function PointMarker(props: {
  className: string;
  u: number;
  v: number;
  label: string;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(): void;
}) {
  return (
    <span
      className={props.className}
      style={{
        left: `${(props.u / DRAWING_GRID) * 100}%`,
        top: `${(props.v / DRAWING_GRID) * 100}%`,
      }}
      title={props.label}
      aria-label={props.label}
      role="img"
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerUp}
    />
  );
}
