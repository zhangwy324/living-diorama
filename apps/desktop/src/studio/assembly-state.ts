import {
  assembleParts,
  attachPart,
  compatibleSockets,
  measureAssembly,
  mirrorImage,
  recolorPart,
  recordEdit,
  redoEdit,
  removePart,
  replacePart,
  rotatePart,
  startHistory,
  stepAssembly,
  stepPart,
  undoEdit,
  VOXEL_STEPS,
  type AssemblyEditResult,
  type AssemblyHistory,
  type AssemblyMeasure,
  type SocketRef,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import type { AssemblyGhost } from "@living-diorama/renderer";
import type { PartsKit } from "./parts-kit";

// Build mode's editor state (ADR 0023 §4–§6, §15, §16): the assembly's undo history, the Mirror
// toggle, the tray part picked to place and the selected part. Every function here is pure and
// returns a new state; the assembly changes only through PR 1's edit operations, so it is always
// valid.

export interface BuildState {
  history: AssemblyHistory;
  /**
   * What Reset goes back to, and what closing compares against (ADR 0023 §21): the default torso,
   * or an assembly loaded to edit a copy of.
   */
  baseline: VoxelAssembly;
  /**
   * A run of live recolours from the colour picker: they make one undo step while the history is
   * still the one the run left and the same colour slot is being changed.
   */
  recolorRun?: { history: AssemblyHistory; key: string } | undefined;
  /** The global Mirror toggle (ADR 0023 §6). */
  mirror: boolean;
  /** The tray part picked to place, by part ID. */
  picked?: string | undefined;
  /** The selected part instance; its mirror image is selected with it while mirroring. */
  selected?: string | undefined;
  /** Why the latest edit was refused or couldn't be made, shown briefly. */
  notice?: string | undefined;
}

/**
 * A fresh creature, Mirror on: the kit's default torso alone, or `baseline`, e.g. a released
 * creature's assembly loaded to edit a copy of (ADR 0023 §3), with nothing to undo.
 */
export const startBuild = (kit: PartsKit, baseline: VoxelAssembly = kit.start): BuildState => ({
  history: startHistory(baseline),
  baseline,
  mirror: true,
});

/** Where a picked part can go: free sockets it fits, and occupied ones it can replace the part on. */
export interface PartTargets {
  free: readonly SocketRef[];
  occupied: readonly SocketRef[];
}

const NO_TARGETS: PartTargets = { free: [], occupied: [] };

// By assembly, then part and Mirror: the targets don't change while the assembly doesn't, and an
// assembly is never changed in place.
const targetCache = new WeakMap<VoxelAssembly, Map<string, PartTargets>>();

const holderOf = (assembly: VoxelAssembly, { instance, socket }: SocketRef) =>
  assembly.instances.find(
    ({ parent }) => parent?.instance === instance && parent.socket === socket,
  );

/**
 * The sockets the picked part `partId` can go on in `assembly`: the free ones `attachPart` takes
 * it on, and the occupied ones `replacePart` can put it on instead of what is there (ADR 0023 §5),
 * leaving out those holding the same library part already. Cached by assembly, part and Mirror.
 */
export function targetsFor(
  kit: PartsKit,
  assembly: VoxelAssembly,
  partId: string,
  mirror: boolean,
): PartTargets {
  const library = kit.byId.get(partId);
  if (!library) return NO_TARGETS;
  let byPart = targetCache.get(assembly);
  if (!byPart) {
    byPart = new Map();
    targetCache.set(assembly, byPart);
  }
  const key = `${partId}|${mirror}`;
  const cached = byPart.get(key);
  if (cached) return cached;
  const fits = kit.lookup.fitsOf(library.part.type) ?? [];
  const occupied: SocketRef[] = [];
  for (const instance of assembly.instances) {
    if (!instance.parent) continue;
    const holder = assembly.instances.find((i) => i.id === instance.parent?.instance);
    const socket =
      holder && assembly.parts[holder.part]?.sockets.find((s) => s.id === instance.parent?.socket);
    if (!socket || !fits.includes(socket.type)) continue;
    if (assembly.parts[instance.part]?.source === partId) continue;
    if (replacePart(assembly, instance.id, library, kit.lookup, { mirror }).ok) {
      occupied.push({ ...instance.parent });
    }
  }
  const targets = {
    free: compatibleSockets(assembly, library, kit.lookup, { mirror }),
    occupied,
  };
  byPart.set(key, targets);
  return targets;
}

/** The edit putting the picked part on `at`: a placement on a free socket, a replacement on a taken one. */
function editAt(
  kit: PartsKit,
  assembly: VoxelAssembly,
  partId: string,
  at: SocketRef,
  mirror: boolean,
): AssemblyEditResult | undefined {
  const library = kit.byId.get(partId);
  if (!library) return undefined;
  const holder = holderOf(assembly, at);
  return holder
    ? replacePart(assembly, holder.id, library, kit.lookup, { mirror })
    : attachPart(assembly, at, library, kit.lookup, { mirror });
}

/**
 * `state` after an edit: recorded and the edited part selected, or the refusal shown. A
 * replacement says how many parts hanging from it were dropped, since that isn't plain to see.
 */
function settle(
  state: BuildState,
  result: AssemblyEditResult | undefined,
  replacedWith?: string,
): BuildState {
  if (!result) return state;
  if (!result.ok) return { ...state, notice: refusalText(result.refusal.code) };
  const dropped = state.history.present.instances.length - result.assembly.instances.length;
  return {
    ...state,
    history: recordEdit(state.history, result.assembly),
    picked: undefined,
    selected: result.instances[0],
    notice:
      replacedWith !== undefined && dropped > 0 ? droppedText(dropped, replacedWith) : undefined,
  };
}

/** Said when a replacement dropped parts that didn't fit the new part. */
export const droppedText = (count: number, partName: string) =>
  `${count} ${count === 1 ? "part" : "parts"} didn't fit the new ${partName.toLowerCase()}.`;

/**
 * A refused edit in the player's words. Codes the Studio's own checks rule out get a general line.
 * `edit` says what was tried, where the same code means something else: growing or shrinking a
 * part's cubes (`grow`, `shrink`), the whole creature's (`grow-all`, `shrink-all`), or turning.
 */
export function refusalText(
  code: string,
  edit?: "grow" | "shrink" | "grow-all" | "shrink-all" | "turn",
): string {
  if (code === "ladder_end") {
    const all = edit === "grow-all" || edit === "shrink-all";
    const bigger = edit === "grow" || edit === "grow-all";
    return all
      ? `A part's cubes are as ${bigger ? "big" : "small"} as they go, so the creature can't ${bigger ? "grow" : "shrink"} any more.`
      : `Its cubes are as ${bigger ? "big" : "small"} as they go.`;
  }
  if (code === "root" && edit === "turn") return "The torso can't turn: everything hangs from it.";
  if (code === "invalid" && edit !== undefined) {
    return edit === "turn"
      ? "It can't turn there: it would stick out of its joint."
      : `It can't ${edit.startsWith("grow") ? "grow" : "shrink"}: a part would come out of its joint.`;
  }
  switch (code) {
    case "no_turn":
      return "No other way round fits there.";
    case "too_many_parts":
      return "That's as many parts as a creature can have.";
    case "not_root":
      return "Only a part a creature is built on can go there.";
    case "root":
      return "Everything hangs from this part, so it stays. Pick another of its kind in the tray to swap it.";
    case "does_not_fit":
    case "socket_taken":
      return "That part doesn't fit there.";
    case "invalid":
      return "That part doesn't fit there: it would stick out of the joint.";
    default:
      return "That didn't work.";
  }
}

/**
 * Picks a tray part, or drops the pick with undefined (ADR 0023 §4). A part of a root type
 * replaces the torso at once, the only place it can go. Another part is placed at once when there
 * is exactly one place for it (with Mirror, a socket and its pair are one place) and nothing to
 * replace; otherwise it stays picked and its sockets are marked. With nowhere to go it says so.
 */
export function pickPart(state: BuildState, kit: PartsKit, partId: string | undefined): BuildState {
  const cleared = { ...state, picked: undefined, notice: undefined };
  if (partId === undefined || partId === state.picked) return cleared;
  const library = kit.byId.get(partId);
  if (!library) return cleared;
  const assembly = state.history.present;
  if (kit.roots.has(library.part.type)) return replaceRoot(cleared, kit, partId);
  const { free, occupied } = targetsFor(kit, assembly, partId, state.mirror);
  const [first] = free;
  if (first && occupied.length === 0) {
    const placed = editAt(kit, assembly, partId, first, state.mirror);
    if (placed?.ok && covers(placed, free)) return settle(cleared, placed);
  }
  if (free.length === 0 && occupied.length === 0) {
    return {
      ...cleared,
      selected: undefined,
      notice: `No free place for the ${library.name.toLowerCase()}.`,
    };
  }
  return { ...cleared, picked: partId, selected: undefined };
}

/**
 * Swaps the torso for the root-type part `partId`, keeping what still fits; the same torso again
 * changes nothing. The pick and the notice are dropped.
 */
export function replaceRoot(state: BuildState, kit: PartsKit, partId: string): BuildState {
  const cleared = { ...state, picked: undefined, notice: undefined };
  const library = kit.byId.get(partId);
  const assembly = state.history.present;
  const root = assembly.instances.find((instance) => !instance.parent);
  if (!library || !root || assembly.parts[root.part]?.source === partId) return cleared;
  return settle(
    cleared,
    replacePart(assembly, root.id, library, kit.lookup, { mirror: state.mirror }),
    library.name,
  );
}

/** Whether `partId` is of a type a creature is built on, which goes in the torso's place. */
export const isRootPart = (kit: PartsKit, partId: string): boolean => {
  const type = kit.byId.get(partId)?.part.type;
  return type !== undefined && kit.roots.has(type);
};

/** Whether the placement `result` filled every one of `sockets`. */
function covers(result: AssemblyEditResult & { ok: true }, sockets: readonly SocketRef[]): boolean {
  const placed = new Set(
    result.assembly.instances
      .filter((instance) => result.instances.includes(instance.id) && instance.parent)
      .map(({ parent }) => `${parent?.instance}/${parent?.socket}`),
  );
  return sockets.every(({ instance, socket }) => placed.has(`${instance}/${socket}`));
}

/**
 * Puts the picked part, or `partId` (a part dragged from the tray), on a marked socket: placed on
 * a free one, replacing on a taken one.
 */
export function placeAt(
  state: BuildState,
  kit: PartsKit,
  at: SocketRef,
  partId: string | undefined = state.picked,
): BuildState {
  const picked = partId;
  if (picked === undefined) return state;
  const replacing = holderOf(state.history.present, at) !== undefined;
  return settle(
    state,
    editAt(kit, state.history.present, picked, at, state.mirror),
    replacing ? kit.byId.get(picked)?.name : undefined,
  );
}

/**
 * The picked part, or `partId`, see-through where a click or drop on `at` would put it, with its
 * mirror image while mirroring: the sockets the edit would fill. Undefined when it can't go there.
 */
export function ghostAt(
  state: BuildState,
  kit: PartsKit,
  at: SocketRef,
  partId: string | undefined = state.picked,
): AssemblyGhost | undefined {
  const picked = partId;
  const library = picked === undefined ? undefined : kit.byId.get(picked);
  if (!library || picked === undefined) return undefined;
  const result = editAt(kit, state.history.present, picked, at, state.mirror);
  if (!result?.ok) return undefined;
  const sockets = result.assembly.instances
    .filter((instance) => result.instances.includes(instance.id))
    .flatMap(({ parent }) => (parent ? [{ ...parent }] : []));
  return { part: library.part, sockets };
}

/** Selects a part instance, or nothing; drops the tray pick and ends a run of live recolours. */
export const selectInstance = (state: BuildState, id: string | undefined): BuildState => ({
  ...state,
  picked: undefined,
  recolorRun: undefined,
  selected: id,
  notice: undefined,
});

/** The selected instances: the selected one, and its mirror image while mirroring. */
export function selectionOf(state: BuildState): string[] {
  const { selected } = state;
  if (selected === undefined) return [];
  const image = state.mirror ? mirrorImage(state.history.present, selected) : undefined;
  return image ? [selected, image.id] : [selected];
}

/** Whether the selected part can be removed: anything but the torso. */
export function canRemove(state: BuildState): boolean {
  const { selected } = state;
  return (
    selected !== undefined &&
    state.history.present.instances.some((instance) => instance.id === selected && instance.parent)
  );
}

/** Removes the selected part and what hangs from it, with its mirror image while mirroring. */
export function removeSelected(state: BuildState): BuildState {
  if (state.selected === undefined) return state;
  const result = removePart(state.history.present, state.selected, { mirror: state.mirror });
  if (!result.ok) return { ...state, notice: refusalText(result.refusal.code) };
  return {
    ...state,
    history: recordEdit(state.history, result.assembly),
    selected: undefined,
    notice: undefined,
  };
}

export const toggleMirror = (state: BuildState): BuildState => ({
  ...state,
  mirror: !state.mirror,
});

/** `state` with `history`, its selection dropped when that part is gone. */
function withHistory(state: BuildState, history: AssemblyHistory): BuildState {
  if (history === state.history) return state;
  const kept = history.present.instances.some((instance) => instance.id === state.selected);
  return { ...state, history, selected: kept ? state.selected : undefined, notice: undefined };
}

export const undo = (state: BuildState) => withHistory(state, undoEdit(state.history));
export const redo = (state: BuildState) => withHistory(state, redoEdit(state.history));
export const canUndo = (state: BuildState) => state.history.past.length > 0;
export const canRedo = (state: BuildState) => state.history.future.length > 0;

/** Drops the notice; the same state when there is none. */
export const clearNotice = (state: BuildState): BuildState =>
  state.notice === undefined ? state : { ...state, notice: undefined };

/** Whether two assemblies are the same by content. */
export function sameAssembly(a: VoxelAssembly, b: VoxelAssembly): boolean {
  if (a === b) return true;
  // Cheap checks first: most edited creatures differ in their parts' count or root.
  const [root] = a.instances;
  const [otherRoot] = b.instances;
  if (a.instances.length !== b.instances.length || !root || !otherRoot) return false;
  if (a.parts[root.part]?.source !== b.parts[otherRoot.part]?.source) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether the creature is its baseline, the default start or the loaded assembly, so closing the
 * Studio loses nothing (ADR 0023 §21). Compared by content, so a part placed and removed again
 * leaves it the baseline.
 */
export const atBaseline = (state: BuildState): boolean =>
  sameAssembly(state.history.present, state.baseline);

/** `state` after an edit to the creature as a whole: recorded, pick and selection dropped. */
function settleWhole(state: BuildState, assembly: VoxelAssembly): BuildState {
  return {
    ...state,
    history: recordEdit(state.history, assembly),
    picked: undefined,
    selected: undefined,
    notice: undefined,
  };
}

/** Back to the baseline (ADR 0023, M21 PR 5b), as one undo step; nothing when it is there. */
export function reset(state: BuildState): BuildState {
  if (atBaseline(state)) return { ...state, picked: undefined, notice: undefined };
  return settleWhole(state, state.baseline);
}

/**
 * A new random creature (ADR 0023 §9): a root part picked by `seed` among the parts of a root type,
 * then every socket filled by `assembleParts` with `seed`. The same seed and parts give the same
 * creature; the Studio passes a fresh random seed each time. One undo step.
 */
export function randomize(state: BuildState, kit: PartsKit, seed: number): BuildState {
  const root = kit.rootParts[seed % kit.rootParts.length];
  if (!root) return state;
  return settleWhole(
    state,
    assembleParts({ start: root, parts: kit.parts, lookup: kit.lookup, seed }),
  );
}

/** Said when Fill empty has nothing to fill. */
export const NOTHING_TO_FILL = "Every place that can take a part has one.";

/**
 * Fills the creature's free sockets and keeps its parts (ADR 0023 §9), by `assembleParts` with
 * `seed`. One undo step; says so when no socket could take a part.
 */
export function fillEmpty(state: BuildState, kit: PartsKit, seed: number): BuildState {
  const assembly = state.history.present;
  const filled = assembleParts({ start: assembly, parts: kit.parts, lookup: kit.lookup, seed });
  if (filled.instances.length === assembly.instances.length) {
    return { ...state, picked: undefined, notice: NOTHING_TO_FILL };
  }
  return { ...settleWhole(state, filled), selected: state.selected };
}

/** A fresh seed for Randomize and Fill empty: random, unlike the edits, which stay seeded. */
export const randomSeed = (): number => crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;

/**
 * `state` after an edit of the selected part (or the whole creature): recorded, the selection
 * kept, or the refusal said as `edit` makes it.
 */
function settleSelected(
  state: BuildState,
  result: AssemblyEditResult,
  edit: Parameters<typeof refusalText>[1],
): BuildState {
  if (!result.ok) return { ...state, notice: refusalText(result.refusal.code, edit) };
  return {
    ...state,
    history: recordEdit(state.history, result.assembly),
    picked: undefined,
    notice: undefined,
  };
}

/** Whether the selected part can turn: anything but the torso, which hangs from no socket. */
export const canRotate = (state: BuildState): boolean => canRemove(state);

/** Turns the selected part a quarter turn about its socket's Y axis, with its image (ADR 0023 §7). */
export function rotateSelected(state: BuildState): BuildState {
  if (state.selected === undefined) return state;
  return settleSelected(
    state,
    rotatePart(state.history.present, state.selected, { mirror: state.mirror }),
    "turn",
  );
}

/**
 * Moves the selected part's cubes one rung up (+1, bigger) or down the step ladder, with its image
 * while mirroring (ADR 0023 §8).
 */
export function stepSelected(state: BuildState, direction: 1 | -1): BuildState {
  if (state.selected === undefined) return state;
  return settleSelected(
    state,
    stepPart(state.history.present, state.selected, direction, { mirror: state.mirror }),
    direction > 0 ? "grow" : "shrink",
  );
}

/** Moves every part's cubes one rung up or down together, keeping their ratios (ADR 0023 §8). */
export const stepCreature = (state: BuildState, direction: 1 | -1): BuildState =>
  settleSelected(
    state,
    stepAssembly(state.history.present, direction),
    direction > 0 ? "grow-all" : "shrink-all",
  );

/** The selected part's colours, one per colour slot, or undefined with nothing selected. */
export function colorsOf(state: BuildState): readonly string[] | undefined {
  const assembly = state.history.present;
  const instance = assembly.instances.find((i) => i.id === state.selected);
  return instance && assembly.parts[instance.part]?.colors;
}

/**
 * Sets colour slot `index` of the selected part to `color`, with its image's while mirroring,
 * copying the part first when it is shared beyond them (ADR 0023 §12). A `live` recolour, from
 * the colour picker as it moves, joins the run of live recolours of the same slot before it in one
 * undo step; `endRecolorRun` ends the run when the picker closes.
 */
export function recolorSelected(
  state: BuildState,
  index: number,
  color: string,
  { live = false }: { live?: boolean } = {},
): BuildState {
  if (state.selected === undefined) return state;
  const { history } = state;
  const result = recolorPart(history.present, state.selected, index, color.toLowerCase(), {
    mirror: state.mirror,
  });
  if (!result.ok) return { ...state, notice: refusalText(result.refusal.code) };
  if (result.assembly === history.present) return state;
  const key = `${state.selected}|${index}|${state.mirror}`;
  const run = state.recolorRun;
  const joins = live && run?.history === history && run.key === key;
  const next = joins
    ? { past: history.past, present: result.assembly, future: [] }
    : recordEdit(history, result.assembly);
  return {
    ...state,
    history: next,
    recolorRun: live ? { history: next, key } : undefined,
    picked: undefined,
    notice: undefined,
  };
}

/** Ends a run of live recolours, so the next makes an undo step of its own. */
export const endRecolorRun = (state: BuildState): BuildState =>
  state.recolorRun === undefined ? state : { ...state, recolorRun: undefined };

/** Said while a part's cubes are two or more steps from the torso's (ADR 0022 §2): a hint only. */
export const STEP_SPREAD_HINT =
  "Some parts' cubes are much bigger or smaller than the torso's, so they may look out of place.";

/**
 * Whether a part's step is two or more rungs of the ladder from the creature's main step, its
 * root's (ADR 0022 §2, ADR 0023 §14). A hint, never a block.
 */
export function stepSpread(assembly: VoxelAssembly): boolean {
  const root = assembly.instances.find((instance) => !instance.parent);
  const main = root && assembly.parts[root.part]?.step;
  if (main === undefined) return false;
  const rung = VOXEL_STEPS.indexOf(main);
  return assembly.instances.some((instance) => {
    const step = assembly.parts[instance.part]?.step;
    return step !== undefined && Math.abs(VOXEL_STEPS.indexOf(step) - rung) >= 2;
  });
}

const measures = new WeakMap<VoxelAssembly, AssemblyMeasure>();

/** `measureAssembly`, kept per assembly. */
export function measureOf(assembly: VoxelAssembly, kit: PartsKit): AssemblyMeasure {
  let measure = measures.get(assembly);
  if (!measure) {
    measure = measureAssembly(assembly, kit.lookup.roleOf);
    measures.set(assembly, measure);
  }
  return measure;
}

/** Said while the creature is larger than `large`, which blocks its release (ADR 0023 §14). */
export const TOO_BIG_HINT =
  "Too big to live in the world: remove a part or swap one for a smaller one to release it.";

/**
 * Why the creature can't be released as it is (ADR 0023 §14): too big for every size class, or
 * the limit errors for its size and ways of moving. Other hints never block. Empty when nothing
 * blocks.
 */
export function releaseBlock({
  tooBig,
  limitErrors,
}: {
  tooBig: boolean;
  limitErrors: readonly string[];
}): string[] {
  return tooBig ? [TOO_BIG_HINT] : [...limitErrors];
}
