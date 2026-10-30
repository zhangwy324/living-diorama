import {
  formatDiagnostic,
  type Diagnostic,
  type Transform,
  type WorldEditInput,
  type WorldEditOpInput,
  type WorldEditResult,
} from "@living-diorama/content-schema";
import type { DioramaView, PropPreview, ViewPointer } from "@living-diorama/renderer";
import type { PropSummary, SceneProp } from "@living-diorama/simulation";
import type { EditHistory } from "./edit-history";

// The prop editor (ADR 0021 §12), in the normal window only: what a click, a drag, the wheel or a key does to the
// world's props in Edit mode. The renderer only picks and previews; every change is one edit sent
// to the worker, committed when a gesture ends, never on every pointer move, since each edit
// rebuilds the world. The world keeps running meanwhile (§3).

/** What the editor needs of the view: picking and drawing the selection and the preview. */
export type EditorView = Pick<
  DioramaView,
  "pickProp" | "pickGround" | "selectProp" | "previewProp" | "hideProp"
>;

/** A short message about the last edit: why it was refused, or what it warned about. */
export interface EditorNotice {
  kind: "error" | "warning";
  text: string;
}

export interface EditorState {
  active: boolean;
  /** The selected placement's ID. */
  selected: string | undefined;
  /** The prop type being placed, chosen in the prop drawer. */
  placing: string | undefined;
  /** The type being placed is dragged from the drawer: it is placed where the pointer is released. */
  placingDrag: boolean;
  /** The prop drawer shows (in Edit mode only). */
  drawerOpen: boolean;
  canUndo: boolean;
  canRedo: boolean;
  notice: EditorNotice | undefined;
}

/** One press of R (or a rotate button) turns the prop this much, in radians: 15°. */
export const ROTATE_STEP = Math.PI / 12;
/** One wheel notch (100 units of `deltaY`) scales the prop by this factor. */
export const SCALE_STEP = 1.1;
/** A turn or scale is committed this long after the last wheel notch or key press. */
export const COMMIT_DELAY_MS = 300;
/** How long a notice shows. */
export const NOTICE_MS = 4000;
/** A press that moves further than this, in CSS pixels, is a drag, not a click. */
export const DRAG_THRESHOLD_PX = 4;

export interface EditorTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const windowTimers: EditorTimers = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PropEditorOptions {
  view: EditorView;
  history: EditHistory;
  /** The registered prop types, by ID, for the drawer. */
  propTypes: Record<string, PropSummary>;
  /** The props drawn now. */
  props: readonly SceneProp[];
  onChange(state: EditorState): void;
  timers?: EditorTimers;
}

/** The keys of a keyboard event the editor reads. */
export type EditorKey = Pick<
  KeyboardEvent,
  "key" | "repeat" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey"
>;

/** A turn or scale of a placement waiting to be committed, as absolute values. */
interface Pending {
  id: string;
  rotationY?: number;
  scale?: number;
  timer?: unknown;
}

/** An edit the editor sent, until it is drawn or refused. */
interface Commit {
  seq: number;
  /** The placement it changes, if it existed before the edit. */
  id: string | undefined;
  /** What it sets on that placement, so a gesture before the redraw starts from it. */
  values: Partial<Transform>;
  /** It shows as the preview until it is drawn. */
  ghosted: boolean;
  /** The worker applied it; it is drawn by the next `world_changed`. */
  applied: boolean;
}

/** A pointer pressed in the view, until it is released. */
interface Press {
  start: ViewPointer;
  /** On the selected prop: it may become a drag. */
  onSelected: boolean;
  /** The prop under the press, if not the selected one: a click selects it. */
  picked: string | undefined;
  /**
   * From the point grabbed to the prop's centre, across the ground, so the prop doesn't jump by
   * that much when the drag starts. Not from the ground under the pointer: behind a tall prop's
   * crown, that can be far away.
   */
  offset: { x: number; z: number };
  dragging: boolean;
  /** Where the drag last met the ground; the prop stays there while the pointer is off it. */
  to?: { x: number; y: number; z: number };
}

const moved = (a: ViewPointer, b: ViewPointer) =>
  Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) > DRAG_THRESHOLD_PX;

/** An angle in [0, 2π), so turning a prop round and round keeps its numbers small. */
const normalizeAngle = (angle: number) => {
  const turn = 2 * Math.PI;
  const rest = angle % turn;
  return rest < 0 ? rest + turn : rest;
};

/** The first message, and how many more there are. */
const summarize = (messages: readonly string[]) =>
  messages.length > 1 ? `${messages[0]} (+${messages.length - 1} more)` : (messages[0] ?? "");

export class PropEditor {
  readonly #view: EditorView;
  readonly #history: EditHistory;
  readonly #types: Record<string, PropSummary>;
  readonly #onChange: (state: EditorState) => void;
  readonly #timers: EditorTimers;
  #props = new Map<string, SceneProp>();
  #active = false;
  #selected: string | undefined;
  #placing: string | undefined;
  #placingRotation = 0;
  #placingDrag = false;
  /** Where the placement's preview last followed the pointer, so a turn shows at once. */
  #placingAt: ViewPointer | undefined;
  #drawerOpen = true;
  #press: Press | undefined;
  #pending: Pending | undefined;
  /** Edits sent and not drawn yet, oldest first. */
  #commits: Commit[] = [];
  #nextSeq = 1;
  /** Goes up on every `clear`, so answers to edits sent before it change nothing here. */
  #generation = 0;
  #disposed = false;
  /** The preview shows, and the placement this hides, if any. */
  #ghost: { hidden: string | undefined } | undefined;
  /** The preview stays until the edit it shows is drawn, so the prop never jumps back. */
  #ghostHeld = false;
  #notice: EditorNotice | undefined;
  #noticeTimer: unknown;

  constructor({ view, history, propTypes, props, onChange, timers }: PropEditorOptions) {
    this.#view = view;
    this.#history = history;
    this.#types = propTypes;
    this.#onChange = onChange;
    this.#timers = timers ?? windowTimers;
    this.#props = new Map(props.map((prop) => [prop.id, prop]));
  }

  get state(): EditorState {
    return {
      active: this.#active,
      selected: this.#selected,
      placing: this.#placing,
      placingDrag: this.#placingDrag,
      drawerOpen: this.#drawerOpen,
      canUndo: this.#history.canUndo,
      canRedo: this.#history.canRedo,
      notice: this.#notice,
    };
  }

  /**
   * Turns Edit mode on or off. Turning it on opens the prop drawer. Turning it off commits a
   * pending turn or scale, drops a drag or a placement, and takes the preview away, showing the
   * hidden prop again.
   */
  setActive(active: boolean): void {
    if (active === this.#active || this.#disposed) return;
    if (active) {
      this.#drawerOpen = true;
    } else {
      this.#flush();
      this.#cancelPress();
      this.#cancelPlacing();
      this.#dropGhost();
      this.#setSelected(undefined);
      this.#setNotice(undefined);
    }
    this.#active = active;
    this.#emit();
  }

  /**
   * Opens or closes the prop drawer. Closing it ends a placement, dragged or not, and keeps the
   * rest: the selection, a pending turn or scale, and Edit mode itself.
   */
  setDrawerOpen(open: boolean): void {
    if (open === this.#drawerOpen || this.#disposed) return;
    if (!open) this.#cancelPlacing();
    this.#drawerOpen = open;
    this.#emit();
  }

  /**
   * A `world_changed` arrived: returns a token for `setProps` once its props are drawn. It counts
   * every edit applied so far, since the worker sends an edit's answer before its `world_changed`.
   */
  worldChanged(): number {
    return this.#commits.reduce((last, c) => (c.applied ? Math.max(last, c.seq) : last), 0);
  }

  /**
   * The props are drawn anew, after an edit or a restore; `drawn` is what `worldChanged` returned
   * when that change arrived (by default, every edit applied so far). The edits it includes are
   * done with: the preview stays only while a later edit of the same prop isn't drawn yet. A
   * selection whose placement is gone is dropped.
   */
  setProps(props: readonly SceneProp[], drawn = this.worldChanged()): void {
    if (this.#disposed) return;
    this.#props = new Map(props.map((prop) => [prop.id, prop]));
    this.#commits = this.#commits.filter((c) => !(c.applied && c.seq <= drawn));
    if (this.#ghostHeld) this.#releaseGhost();
    if (this.#pending && !this.#props.has(this.#pending.id)) this.#cancelPending();
    if (this.#selected !== undefined && !this.#props.has(this.#selected)) {
      this.#setSelected(undefined);
    }
    this.#emit();
  }

  /**
   * Forgets the undo and redo stacks, the selection and anything uncommitted, e.g. when a save
   * replaced the world (ADR 0021 §4) or the world was reset.
   */
  clear(): void {
    if (this.#disposed) return;
    this.#history.clear();
    this.#generation++;
    this.#cancelPending();
    this.#cancelPress();
    this.#commits = [];
    this.#dropGhost();
    this.#setSelected(undefined);
    this.#emit();
  }

  /**
   * Stops the editor with the view: a pending turn or scale is dropped, timers are cleared, and
   * answers still to come change nothing.
   */
  dispose(): void {
    this.#cancelPending();
    if (this.#noticeTimer !== undefined) this.#timers.clear(this.#noticeTimer);
    this.#noticeTimer = undefined;
    this.#press = undefined;
    this.#disposed = true;
  }

  /** Called when the history changes, so canUndo and canRedo reach the toolbar. */
  historyChanged(): void {
    this.#emit();
  }

  // ---- Pointer and keys ----------------------------------------------------------------------

  /**
   * A button went down over the view. Returns true when the editor takes the press: then the
   * camera must not see it. Only a press on the selected prop is taken, so a drag anywhere else
   * still orbits.
   */
  pointerDown(pointer: ViewPointer, button: number): boolean {
    if (!this.#active || button !== 0) return false;
    const press: Press = {
      start: pointer,
      onSelected: false,
      picked: undefined,
      offset: { x: 0, z: 0 },
      dragging: false,
    };
    this.#press = press;
    if (this.#placing !== undefined) return false;
    const pick = this.#view.pickProp(pointer);
    const picked = pick?.placementId;
    if (!pick || picked === undefined || picked !== this.#selected) {
      press.picked = picked;
      return false;
    }
    const at = this.#transformOf(picked)?.position;
    if (at) press.offset = { x: at.x - pick.point.x, z: at.z - pick.point.z };
    press.onSelected = true;
    return true;
  }

  /** The pointer moved over the view, pressed or not. Returns true while it drags a prop. */
  pointerMove(pointer: ViewPointer): boolean {
    if (!this.#active) return false;
    const press = this.#press;
    if (this.#placing !== undefined) {
      this.#previewPlacing(pointer);
      return false;
    }
    if (!press?.onSelected || this.#selected === undefined) return false;
    if (!press.dragging && !moved(press.start, pointer)) return false;
    press.dragging = true;
    const id = this.#selected;
    const ground = this.#view.pickGround(pointer);
    if (ground) {
      press.to = { x: ground.x + press.offset.x, y: ground.y, z: ground.z + press.offset.z };
    }
    // Pending turns and scales go with the move, as one edit, once the drag ends.
    if (this.#pending?.timer !== undefined) {
      this.#timers.clear(this.#pending.timer);
      this.#pending.timer = undefined;
    }
    const transform = this.#transformOf(id);
    if (transform && press.to) this.#showGhost(id, { ...transform, position: press.to });
    return true;
  }

  /** The button came up. Returns true when it ended a drag of a prop. */
  pointerUp(pointer: ViewPointer): boolean {
    const press = this.#press;
    this.#press = undefined;
    if (!this.#active || !press) return false;
    if (press.dragging) {
      this.#commitDrag(press);
      return true;
    }
    // A press that moved orbited the camera.
    if (moved(press.start, pointer)) return false;
    if (this.#placing !== undefined) this.#place(pointer);
    else if (!press.onSelected) this.select(press.picked);
    return false;
  }

  /** The press was lost, e.g. to another window: a drag is dropped, not committed. */
  pointerCancel(): void {
    this.#cancelPress();
  }

  /** The pointer left the view: a placement's preview goes until it is back over the ground. */
  pointerLeave(): void {
    if (!this.#active || this.#placing === undefined || this.#placingDrag) return;
    this.#placingAt = undefined;
    if (!this.#ghostHeld) this.#dropGhost();
  }

  // ---- Dragging a prop type from the drawer --------------------------------------------------

  /**
   * A tile of the drawer is being dragged: the type is placed where the pointer is released over
   * the ground (`endPlacingDrag`). Until then the preview follows the pointer over the world.
   */
  startPlacingDrag(propType: string): void {
    if (!this.#active || !this.#drawerOpen || !(propType in this.#types)) return;
    this.choosePlacing(propType);
    this.#placingDrag = true;
    this.#emit();
  }

  /** The dragged tile moved; `overWorld` says the pointer is over the world, not the drawer. */
  movePlacingDrag(pointer: ViewPointer, overWorld: boolean): void {
    if (!this.#placingDrag) return;
    if (overWorld) {
      this.#previewPlacing(pointer);
    } else {
      this.#placingAt = undefined;
      this.#dropGhost();
    }
  }

  /**
   * The dragged tile was released. Over the ground of the world, the type is placed there and
   * selected, as by a click; over the drawer, anywhere else, or off the ground, nothing is placed
   * and placing ends.
   */
  endPlacingDrag(pointer: ViewPointer, overWorld: boolean): void {
    if (!this.#placingDrag) return;
    this.#placingDrag = false;
    if (overWorld && this.#view.pickGround(pointer)) {
      this.#place(pointer);
    } else {
      this.#cancelPlacing();
      this.#emit();
    }
  }

  /** The dragged tile lost the pointer: nothing is placed, and placing ends. */
  cancelPlacingDrag(): void {
    if (!this.#placingDrag) return;
    this.#cancelPlacing();
    this.#emit();
  }

  /**
   * The wheel turned over the view. Returns true when it scaled the selected prop: then the
   * camera must not zoom. Without a selection the wheel zooms as usual.
   */
  wheel(deltaY: number): boolean {
    if (!this.#active || this.#selected === undefined || this.#placing !== undefined) return false;
    const transform = this.#transformOf(this.#selected);
    if (!transform || deltaY === 0) return true;
    this.#change(this.#selected, { scale: transform.scale * SCALE_STEP ** (-deltaY / 100) });
    return true;
  }

  /**
   * A key went down. Returns true when it was the editor's. Edit mode is only on in the normal
   * window, which takes focus (ADR 0016 §1), so its keys arrive.
   */
  key(event: EditorKey): boolean {
    if (!this.#active || event.altKey || event.metaKey) return false;
    const key = event.key.toLowerCase();
    if (event.ctrlKey) {
      if (key === "z" && !event.shiftKey) void this.undo();
      else if (key === "y" || (key === "z" && event.shiftKey)) void this.redo();
      else return false;
      return true;
    }
    switch (key) {
      case "escape":
        if (this.#placing !== undefined) {
          this.#cancelPlacing();
          this.#emit();
        } else if (this.#selected !== undefined) this.select(undefined);
        else return false;
        return true;
      case "delete":
      case "backspace":
        if (this.#selected === undefined || event.repeat) return false;
        this.deleteSelected();
        return true;
      case "r":
        if (this.#selected === undefined && this.#placing === undefined) return false;
        this.rotate(event.shiftKey ? -1 : 1);
        return true;
      default:
        return false;
    }
  }

  // ---- Commands (the toolbar's buttons and the keys) -----------------------------------------

  /** Selects a placement, or none. A turn or scale pending for another one is committed first. */
  select(placementId: string | undefined): void {
    if (this.#pending && this.#pending.id !== placementId) this.#flush();
    this.#setSelected(placementId);
    this.#emit();
  }

  /** Starts placing a prop type from the drawer, or stops. The next click on the ground places it. */
  choosePlacing(propType: string | undefined): void {
    this.#flush();
    this.#setSelected(undefined);
    this.#cancelPlacing();
    if (!this.#ghostHeld) this.#dropGhost();
    this.#placing = propType !== undefined && propType in this.#types ? propType : undefined;
    this.#emit();
  }

  /** Turns the selected prop, or the one being placed, by one step: +1 anticlockwise from above. */
  rotate(direction: 1 | -1): void {
    if (this.#placing !== undefined) {
      this.#placingRotation = normalizeAngle(this.#placingRotation + direction * ROTATE_STEP);
      if (this.#placingAt) this.#previewPlacing(this.#placingAt);
      return;
    }
    if (this.#selected === undefined) return;
    const transform = this.#transformOf(this.#selected);
    if (!transform) return;
    this.#change(this.#selected, {
      rotationY: normalizeAngle(transform.rotationY + direction * ROTATE_STEP),
    });
  }

  /** Removes the selected prop. */
  deleteSelected(): void {
    const id = this.#selected;
    if (id === undefined) return;
    if (this.#pending?.id === id) this.#cancelPending();
    if (this.#ghost?.hidden === id) this.#dropGhost();
    this.#setSelected(undefined);
    this.#emit();
    void this.#commit({ ops: [{ op: "prop.remove", id }] }, false);
  }

  /** Undoes the last edit, after committing a pending turn or scale. */
  async undo(): Promise<void> {
    this.#flush();
    const result = await this.#history.undo();
    if (!this.#disposed) this.#report(result);
  }

  /** Redoes the last undone edit. */
  async redo(): Promise<void> {
    this.#flush();
    const result = await this.#history.redo();
    if (!this.#disposed) this.#report(result);
  }

  // ---- Internals -----------------------------------------------------------------------------

  /** The placement's transform with what is committed but not drawn, and what is pending. */
  #transformOf(id: string): Transform | undefined {
    const prop = this.#props.get(id);
    if (!prop) return undefined;
    const pending = this.#pending?.id === id ? this.#pending : undefined;
    const committed = this.#commits
      .filter((c) => c.id === id)
      .reduce<Partial<Transform>>((values, c) => ({ ...values, ...c.values }), {});
    return {
      ...prop.transform,
      ...committed,
      ...(pending?.rotationY === undefined ? {} : { rotationY: pending.rotationY }),
      ...(pending?.scale === undefined ? {} : { scale: pending.scale }),
    };
  }

  /** Previews a turn or scale and commits it once no other follows for a moment. */
  #change(id: string, change: { rotationY?: number; scale?: number }) {
    if (this.#pending && this.#pending.id !== id) this.#flush();
    const pending: Pending = this.#pending ?? { id };
    if (pending.timer !== undefined) this.#timers.clear(pending.timer);
    Object.assign(pending, change);
    this.#pending = pending;
    const transform = this.#transformOf(id);
    if (transform) this.#showGhost(id, transform);
    // While a drag is on, the change goes with the move.
    if (!this.#press?.dragging) {
      pending.timer = this.#timers.set(() => this.#flush(), COMMIT_DELAY_MS);
    }
  }

  /** The pending turn and scale as ops, or none. */
  #pendingOps(position?: { x: number; z: number }): WorldEditOpInput[] {
    const pending = this.#pending;
    if (!pending) return [];
    const ops: WorldEditOpInput[] = [];
    if (pending.rotationY !== undefined || position) {
      ops.push({
        op: "prop.move",
        id: pending.id,
        ...(position ? { position } : {}),
        ...(pending.rotationY === undefined ? {} : { rotationY: pending.rotationY }),
      });
    }
    if (pending.scale !== undefined)
      ops.push({ op: "prop.scale", id: pending.id, scale: pending.scale });
    return ops;
  }

  /** Commits a pending turn or scale now. */
  #flush() {
    const pending = this.#pending;
    if (!pending) return;
    const ops = this.#pendingOps();
    this.#cancelPending();
    if (ops.length > 0) void this.#commit({ ops }, true, pending.id, valuesOf(pending));
  }

  #cancelPending() {
    if (this.#pending?.timer !== undefined) this.#timers.clear(this.#pending.timer);
    this.#pending = undefined;
  }

  #commitDrag(press: Press) {
    const id = this.#selected;
    if (id === undefined || !press.to) {
      // Never on the ground: nothing moves, but a pending turn or scale still commits.
      const pending = this.#pending;
      if (pending) this.#change(pending.id, {});
      else this.#dropGhost();
      return;
    }
    const position = { x: press.to.x, z: press.to.z };
    const pending = this.#pending?.id === id ? this.#pending : undefined;
    const ops = pending ? this.#pendingOps(position) : [{ op: "prop.move" as const, id, position }];
    this.#cancelPending();
    void this.#commit({ ops }, true, id, {
      ...(pending ? valuesOf(pending) : {}),
      position: press.to,
    });
  }

  /** Places the chosen prop type where the pointer meets the ground, and selects it. */
  #place(pointer: ViewPointer) {
    const prop = this.#placing;
    const ground = this.#view.pickGround(pointer);
    if (prop === undefined || !ground) return;
    const rotationY = this.#placingRotation;
    this.#placing = undefined;
    this.#placingDrag = false;
    this.#placingAt = undefined;
    this.#emit();
    const generation = this.#generation;
    void this.#commit(
      { ops: [{ op: "prop.add", prop, position: { x: ground.x, z: ground.z }, rotationY }] },
      true,
    ).then((result) => {
      // Not if the world was replaced, or Edit mode left, meanwhile.
      if (generation !== this.#generation || this.#disposed || !this.#active) return;
      const added = result.ok ? result.edit.ops.find((op) => op.op === "prop.add") : undefined;
      if (added?.op === "prop.add") this.select(added.id);
    });
  }

  #previewPlacing(pointer: ViewPointer) {
    const type = this.#placing === undefined ? undefined : this.#types[this.#placing];
    const ground = this.#view.pickGround(pointer);
    this.#placingAt = ground ? pointer : undefined;
    if (!type || !ground) {
      this.#dropGhost();
      return;
    }
    this.#ghost = { hidden: undefined };
    this.#ghostHeld = false;
    this.#view.hideProp(undefined);
    this.#view.previewProp({
      model: type.model,
      transform: { position: ground, rotationY: this.#placingRotation, scale: 1 },
      blockRadius: type.blockRadius,
    });
  }

  /** Shows the placement `id` at `transform` as a preview, its original hidden. */
  #showGhost(id: string, transform: Transform) {
    const prop = this.#props.get(id);
    if (!prop) return;
    // The scene's block radius is the type's times the drawn scale.
    const typeRadius = prop.transform.scale > 0 ? prop.blockRadius / prop.transform.scale : 0;
    const preview: PropPreview = {
      model: prop.model,
      transform,
      blockRadius: typeRadius * transform.scale,
    };
    if (this.#ghost?.hidden !== id) this.#view.hideProp(id);
    this.#ghost = { hidden: id };
    this.#ghostHeld = false;
    this.#view.previewProp(preview);
  }

  /**
   * A held preview stays while an edit it shows isn't drawn yet, at what is left of the prop's
   * committed values; otherwise it goes.
   */
  #releaseGhost() {
    const hidden = this.#ghost?.hidden;
    const waiting = this.#commits.some((c) => c.ghosted && c.id === hidden);
    const transform = hidden === undefined ? undefined : this.#transformOf(hidden);
    if (hidden === undefined || !waiting || !transform) {
      this.#dropGhost();
      return;
    }
    this.#showGhost(hidden, transform);
    this.#ghostHeld = true;
  }

  /**
   * Ends a placement, dragged or not, taking its preview away (unless the preview is held for an
   * edit not drawn yet).
   */
  #cancelPlacing() {
    const placing = this.#placing !== undefined;
    this.#placing = undefined;
    this.#placingDrag = false;
    this.#placingRotation = 0;
    this.#placingAt = undefined;
    if (placing && !this.#ghostHeld) this.#dropGhost();
  }

  #dropGhost() {
    this.#ghostHeld = false;
    if (!this.#ghost) return;
    this.#ghost = undefined;
    this.#view.previewProp(undefined);
    this.#view.hideProp(undefined);
  }

  #cancelPress() {
    const dragging = this.#press?.dragging;
    this.#press = undefined;
    if (dragging && !this.#ghostHeld) {
      // A pending turn or scale shows again without the move; otherwise the preview goes.
      const pending = this.#pending;
      const transform = pending ? this.#transformOf(pending.id) : undefined;
      if (pending && transform) this.#change(pending.id, {});
      else this.#dropGhost();
    }
  }

  /**
   * Sends an edit of `placementId` that sets `values`. With `ghosted`, the preview shows until
   * the edit is drawn. A refused edit is forgotten at once, and only it: the preview falls back to
   * what earlier edits not drawn yet set, or goes.
   */
  async #commit(
    edit: WorldEditInput,
    ghosted: boolean,
    placementId?: string,
    values: Partial<Transform> = {},
  ): Promise<WorldEditResult> {
    const commit: Commit = {
      seq: this.#nextSeq++,
      id: placementId,
      values,
      ghosted,
      applied: false,
    };
    this.#commits.push(commit);
    if (ghosted) this.#ghostHeld = true;
    const generation = this.#generation;
    const result = await this.#history.apply(edit);
    // After a clear the commit is already forgotten, and after dispose nothing is drawn.
    if (generation !== this.#generation || this.#disposed) return result;
    if (result.ok) {
      commit.applied = true;
    } else {
      this.#commits = this.#commits.filter((c) => c !== commit);
      if (ghosted && this.#ghostHeld) this.#releaseGhost();
    }
    this.#report(result);
    return result;
  }

  /** Shows why an edit was refused, or what it warned about. */
  #report(result: WorldEditResult | undefined) {
    if (!result) return;
    if (!result.ok) {
      console.warn(["Edit refused", ...result.diagnostics.map(formatDiagnostic)].join("\n  "));
      this.#setNotice({ kind: "error", text: summarize(messages(result.diagnostics)) });
      return;
    }
    const lines = [
      ...(result.relocated.length > 0
        ? [
            `Moved ${result.relocated.length} creature${result.relocated.length === 1 ? "" : "s"} out of the way`,
          ]
        : []),
      ...messages(result.warnings),
    ];
    if (result.warnings.length > 0) {
      console.warn(
        ["Edit applied with warnings", ...result.warnings.map(formatDiagnostic)].join("\n  "),
      );
    }
    if (lines.length > 0) this.#setNotice({ kind: "warning", text: summarize(lines) });
  }

  #setNotice(notice: EditorNotice | undefined) {
    if (this.#noticeTimer !== undefined) this.#timers.clear(this.#noticeTimer);
    this.#noticeTimer = undefined;
    this.#notice = notice;
    if (notice) {
      this.#noticeTimer = this.#timers.set(() => {
        this.#noticeTimer = undefined;
        this.#notice = undefined;
        this.#emit();
      }, NOTICE_MS);
    }
    this.#emit();
  }

  #setSelected(id: string | undefined) {
    if (id === this.#selected) return;
    this.#selected = id;
    this.#view.selectProp(id);
  }

  #emit() {
    if (this.#disposed) return;
    this.#onChange(this.state);
  }
}

/** The values a pending turn or scale sets. */
const valuesOf = ({ rotationY, scale }: Pending): Partial<Transform> => ({
  ...(rotationY === undefined ? {} : { rotationY }),
  ...(scale === undefined ? {} : { scale }),
});

const messages = (diagnostics: readonly Diagnostic[]) => diagnostics.map((d) => d.message);
