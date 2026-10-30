import {
  attachPart,
  compatibleSockets,
  measureAssembly,
  mirrorImage,
  recordEdit,
  redoEdit,
  removePart,
  replacePart,
  startHistory,
  undoEdit,
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
  /** The global Mirror toggle (ADR 0023 §6). */
  mirror: boolean;
  /** The tray part picked to place, by part ID. */
  picked?: string | undefined;
  /** The selected part instance; its mirror image is selected with it while mirroring. */
  selected?: string | undefined;
  /** Why the latest edit was refused or couldn't be made, shown briefly. */
  notice?: string | undefined;
}

/** A fresh creature: the kit's default torso alone, Mirror on. */
export const startBuild = (kit: PartsKit): BuildState => ({
  history: startHistory(kit.start),
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

/** A refused edit in the player's words. Codes the Studio's own checks rule out get a general line. */
export function refusalText(code: string): string {
  switch (code) {
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
      return "That part doesn't fit there: it would stick out of the joint or off the grid.";
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
  if (kit.roots.has(library.part.type)) {
    const root = assembly.instances.find((instance) => !instance.parent);
    if (!root || assembly.parts[root.part]?.source === partId) return cleared;
    return settle(
      cleared,
      replacePart(assembly, root.id, library, kit.lookup, { mirror: state.mirror }),
      library.name,
    );
  }
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

/** Whether the placement `result` filled every one of `sockets`. */
function covers(result: AssemblyEditResult & { ok: true }, sockets: readonly SocketRef[]): boolean {
  const placed = new Set(
    result.assembly.instances
      .filter((instance) => result.instances.includes(instance.id) && instance.parent)
      .map(({ parent }) => `${parent?.instance}/${parent?.socket}`),
  );
  return sockets.every(({ instance, socket }) => placed.has(`${instance}/${socket}`));
}

/** Puts the picked part on a marked socket: placed on a free one, replacing on a taken one. */
export function placeAt(state: BuildState, kit: PartsKit, at: SocketRef): BuildState {
  const { picked } = state;
  if (picked === undefined) return state;
  const replacing = holderOf(state.history.present, at) !== undefined;
  return settle(
    state,
    editAt(kit, state.history.present, picked, at, state.mirror),
    replacing ? kit.byId.get(picked)?.name : undefined,
  );
}

/**
 * The picked part see-through where a click on `at` would put it, with its mirror image while
 * mirroring: the sockets the edit would fill. Undefined when it can't go there.
 */
export function ghostAt(
  state: BuildState,
  kit: PartsKit,
  at: SocketRef,
): AssemblyGhost | undefined {
  const { picked } = state;
  const library = picked === undefined ? undefined : kit.byId.get(picked);
  if (!library || picked === undefined) return undefined;
  const result = editAt(kit, state.history.present, picked, at, state.mirror);
  if (!result?.ok) return undefined;
  const sockets = result.assembly.instances
    .filter((instance) => result.instances.includes(instance.id))
    .flatMap(({ parent }) => (parent ? [{ ...parent }] : []));
  return { part: library.part, sockets };
}

/** Selects a part instance, or nothing; drops the tray pick. */
export const selectInstance = (state: BuildState, id: string | undefined): BuildState => ({
  ...state,
  picked: undefined,
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

/**
 * Whether `assembly` is the default start, so closing the Studio loses nothing (ADR 0023 §21).
 * Compared by content, so a part placed and removed again leaves it the start.
 */
export function isStart(assembly: VoxelAssembly, kit: PartsKit): boolean {
  if (assembly === kit.start) return true;
  // Cheap checks first: most edited creatures differ in their parts' count or root.
  const [root] = assembly.instances;
  const [startRoot] = kit.start.instances;
  if (assembly.instances.length !== kit.start.instances.length || !root || !startRoot) {
    return false;
  }
  if (assembly.parts[root.part]?.source !== kit.start.parts[startRoot.part]?.source) return false;
  return JSON.stringify(assembly) === JSON.stringify(kit.start);
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
