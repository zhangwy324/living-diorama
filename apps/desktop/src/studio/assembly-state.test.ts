import {
  startHistory,
  VoxelAssemblySchema,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import {
  canRedo,
  canRemove,
  canUndo,
  clearNotice,
  droppedText,
  ghostAt,
  isStart,
  measureOf,
  pickPart,
  placeAt,
  redo,
  refusalText,
  releaseBlock,
  removeSelected,
  selectInstance,
  selectionOf,
  startBuild,
  targetsFor,
  toggleMirror,
  TOO_BIG_HINT,
  undo,
  type BuildState,
} from "./assembly-state";
import { builtInParts } from "./fixtures/built-in-parts";
import { assemblyOf, partsKit } from "./parts-kit";

const made = partsKit(builtInParts());
if (!made) throw new Error("No kit");
const kit = made;
const fourLegged = kit.byId.get("hollow:four-legged-torso");
if (!fourLegged) throw new Error("No four-legged torso");
/** Most checks build on the four-legged torso, which has the most sockets. */
const LEGGED = assemblyOf(fourLegged, kit.lookup);
const legged = (): BuildState => ({ ...startBuild(kit), history: startHistory(LEGGED) });
const ROOT = LEGGED.instances[0]?.id ?? "";

const present = (state: BuildState) => state.history.present;
/** Each instance as `id:part source@socket`, the root as `id:part source`. */
const layout = (assembly: VoxelAssembly) =>
  assembly.instances.map(
    (i) => `${i.id}:${assembly.parts[i.part]?.source}${i.parent ? `@${i.parent.socket}` : ""}`,
  );
const at = (socket: string, instance = ROOT) => ({ instance, socket });
const valid = (state: BuildState) =>
  expect(VoxelAssemblySchema.safeParse(present(state)).success).toBe(true);

/** The start with paw legs on the back hips, placed with Mirror on. */
function withBackLegs(): BuildState {
  const picked = pickPart(legged(), kit, "hollow:paw-leg");
  return placeAt(picked, kit, at("back-left"));
}

describe("Build mode's editor state", () => {
  it("starts from the default torso alone, the first of a root type, Mirror on, nothing to undo", () => {
    const state = startBuild(kit);
    expect(layout(present(state))).toEqual(["fish-torso:hollow:fish-torso"]);
    expect(state.mirror).toBe(true);
    expect(canUndo(state) || canRedo(state)).toBe(false);
    expect(isStart(present(state), kit)).toBe(true);
  });

  it("keeps a part picked while it has more than one place, marking its sockets", () => {
    const state = pickPart(legged(), kit, "hollow:paw-leg");
    expect(state.picked).toBe("hollow:paw-leg");
    expect(present(state)).toBe(LEGGED);
    const targets = targetsFor(kit, present(state), "hollow:paw-leg", true);
    expect(targets.free.map((s) => s.socket)).toEqual([
      "front-left",
      "front-right",
      "back-left",
      "back-right",
    ]);
    expect(targets.occupied).toEqual([]);
    // Cached by assembly, part and Mirror.
    expect(targetsFor(kit, present(state), "hollow:paw-leg", true)).toBe(targets);
    expect(targetsFor(kit, present(state), "hollow:paw-leg", false)).not.toBe(targets);
  });

  it("picking the picked part again drops the pick", () => {
    const state = pickPart(legged(), kit, "hollow:paw-leg");
    expect(pickPart(state, kit, "hollow:paw-leg").picked).toBeUndefined();
    expect(pickPart(state, kit, undefined).picked).toBeUndefined();
  });

  it("places a part on a clicked socket with its mirror image, and selects both", () => {
    const state = withBackLegs();
    expect(layout(present(state)).slice(1)).toEqual([
      "back-left:hollow:paw-leg@back-left",
      "back-right:hollow:paw-leg@back-right",
    ]);
    expect(state.picked).toBeUndefined();
    expect(state.selected).toBe("back-left");
    expect(selectionOf(state)).toEqual(["back-left", "back-right"]);
    expect(canUndo(state)).toBe(true);
    expect(isStart(present(state), kit)).toBe(false);
    valid(state);
  });

  it("places a part at once when it has one place: a socket, or a pair with Mirror on", () => {
    const head = pickPart(legged(), kit, "hollow:round-head");
    expect(head.picked).toBeUndefined();
    expect(layout(present(head)).slice(1)).toEqual(["neck:hollow:round-head@neck"]);
    const eyes = pickPart(head, kit, "hollow:bead-eye");
    expect(layout(present(eyes)).slice(2)).toEqual([
      "left-eye:hollow:bead-eye@left-eye",
      "right-eye:hollow:bead-eye@right-eye",
    ]);
    // With Mirror off, a pair is two places.
    const oneEye = pickPart(toggleMirror(head), kit, "hollow:bead-eye");
    expect(oneEye.picked).toBe("hollow:bead-eye");
    expect(present(oneEye)).toBe(present(head));
  });

  it("says so when a part has nowhere to go, and doesn't pick it", () => {
    const state = pickPart(legged(), kit, "hollow:bead-eye");
    expect(state.picked).toBeUndefined();
    expect(state.notice).toBe("No free place for the bead eye.");
    expect(clearNotice(state).notice).toBeUndefined();
  });

  it("places one side only with Mirror off", () => {
    const picked = pickPart(toggleMirror(legged()), kit, "hollow:paw-leg");
    const state = placeAt(picked, kit, at("front-left"));
    expect(layout(present(state)).slice(1)).toEqual(["front-left:hollow:paw-leg@front-left"]);
    expect(selectionOf(state)).toEqual(["front-left"]);
  });

  it("marks taken sockets a part can replace, and replaces the part there with its image", () => {
    const legs = withBackLegs();
    const picked = pickPart(legs, kit, "hollow:stout-leg");
    const targets = targetsFor(kit, present(picked), "hollow:stout-leg", true);
    expect(targets.occupied.map((s) => s.socket)).toEqual(["back-left", "back-right"]);
    // Not offered where the same part is already.
    expect(targetsFor(kit, present(legs), "hollow:paw-leg", true).occupied).toEqual([]);
    // Shown see-through on both, where the click would put it.
    expect(ghostAt(picked, kit, at("back-left"))?.sockets).toEqual([
      at("back-left"),
      at("back-right"),
    ]);
    const replaced = placeAt(picked, kit, at("back-left"));
    expect(layout(present(replaced)).slice(1)).toEqual([
      "back-left:hollow:stout-leg@back-left",
      "back-right:hollow:stout-leg@back-right",
    ]);
    expect(replaced.selected).toBe("back-left");
    // One undo step back to the paw legs.
    expect(present(undo(replaced))).toBe(present(legs));
    valid(replaced);
  });

  it("shows a free socket's ghost on the socket and its pair", () => {
    const picked = pickPart(legged(), kit, "hollow:paw-leg");
    expect(ghostAt(picked, kit, at("front-right"))?.sockets).toEqual([
      at("front-right"),
      at("front-left"),
    ]);
    expect(ghostAt(legged(), kit, at("front-right"))).toBeUndefined();
  });

  it("swaps the torso at once when a torso is picked, keeping what still fits", () => {
    const head = pickPart(legged(), kit, "hollow:round-head");
    const swapped = pickPart(head, kit, "hollow:mossling-torso");
    expect(layout(present(swapped))).toEqual([
      `${ROOT}:hollow:mossling-torso`,
      "neck:hollow:round-head@neck",
    ]);
    expect(swapped.picked).toBeUndefined();
    // Nothing was dropped, so nothing is said.
    expect(swapped.notice).toBeUndefined();
    // The same torso again changes nothing.
    expect(pickPart(swapped, kit, "hollow:mossling-torso").history).toBe(swapped.history);
    valid(swapped);
  });

  it("says how many parts a replacement dropped", () => {
    const legs = withBackLegs();
    const swapped = pickPart(legs, kit, "hollow:mossling-torso");
    // The mossling torso has no back-left or back-right socket.
    expect(layout(present(swapped))).toEqual([`${ROOT}:hollow:mossling-torso`]);
    expect(swapped.notice).toBe("2 parts didn't fit the new mossling torso.");
    expect(droppedText(1, "Round head")).toBe("1 part didn't fit the new round head.");
    // A replacement that keeps everything says nothing.
    const replaced = placeAt(pickPart(legs, kit, "hollow:stout-leg"), kit, at("back-left"));
    expect(replaced.notice).toBeUndefined();
  });

  it("removes the selected part with its image while mirroring, never the torso", () => {
    const legs = withBackLegs();
    expect(canRemove(legs)).toBe(true);
    const removed = removeSelected(legs);
    expect(layout(present(removed))).toEqual([`${ROOT}:hollow:four-legged-torso`]);
    expect(removed.selected).toBeUndefined();
    expect(JSON.stringify(present(removed))).toBe(JSON.stringify(LEGGED));

    const oneSide = removeSelected(toggleMirror(legs));
    expect(layout(present(oneSide)).slice(1)).toEqual(["back-right:hollow:paw-leg@back-right"]);

    const root = selectInstance(legs, ROOT);
    expect(canRemove(root)).toBe(false);
    expect(removeSelected(root).notice).toBe(refusalText("root"));
    expect(present(removeSelected(root))).toBe(present(legs));
  });

  it("is back at the start by content after a part is placed and removed", () => {
    const fins = pickPart(startBuild(kit), kit, "hollow:side-fin");
    expect(layout(present(fins)).slice(1)).toEqual([
      "left-fin:hollow:side-fin@left-fin",
      "right-fin:hollow:side-fin@right-fin",
    ]);
    expect(isStart(present(fins), kit)).toBe(false);
    // So closing then loses nothing.
    expect(isStart(present(removeSelected(fins)), kit)).toBe(true);
  });

  it("selecting drops the pick, and the image is selected only while mirroring", () => {
    const picked = pickPart(withBackLegs(), kit, "hollow:round-head");
    const selected = selectInstance(
      pickPart(withBackLegs(), kit, "hollow:stout-leg"),
      "back-right",
    );
    expect(selected.picked).toBeUndefined();
    expect(selectionOf(selected)).toEqual(["back-right", "back-left"]);
    expect(selectionOf(toggleMirror(selected))).toEqual(["back-right"]);
    expect(selectionOf(selectInstance(picked, undefined))).toEqual([]);
  });

  it("undoes and redoes whole snapshots, dropping a selection that is gone", () => {
    const legs = withBackLegs();
    const undone = undo(legs);
    expect(present(undone)).toBe(LEGGED);
    expect(undone.selected).toBeUndefined();
    expect(canRedo(undone)).toBe(true);
    const redone = redo(undone);
    expect(present(redone)).toBe(present(legs));
    expect(canRedo(redone)).toBe(false);
    // Nothing to undo or redo: the same state.
    expect(undo(undone)).toBe(undone);
    expect(redo(redone)).toBe(redone);
    // A new edit forgets the redo steps.
    const edited = pickPart(undone, kit, "hollow:round-head");
    expect(canRedo(edited)).toBe(false);
  });

  it("keeps a selection that survives an undo", () => {
    const legs = withBackLegs();
    const head = selectInstance(pickPart(legs, kit, "hollow:round-head"), "back-left");
    expect(undo(head).selected).toBe("back-left");
  });

  it("measures the size class live", () => {
    expect(measureOf(kit.start, kit).sizeClass).toBeDefined();
    expect(measureOf(kit.start, kit)).toBe(measureOf(kit.start, kit));
  });
});

describe("release blocking", () => {
  it("blocks a creature larger than large, and limit errors; other hints never block", () => {
    expect(releaseBlock({ tooBig: true, limitErrors: [] })).toEqual([TOO_BIG_HINT]);
    expect(releaseBlock({ tooBig: true, limitErrors: ["Nowhere to appear."] })).toEqual([
      TOO_BIG_HINT,
    ]);
    // Every limit error, not just the first.
    expect(releaseBlock({ tooBig: false, limitErrors: ["Nowhere.", "Stuck."] })).toEqual([
      "Nowhere.",
      "Stuck.",
    ]);
    expect(releaseBlock({ tooBig: false, limitErrors: [] })).toEqual([]);
  });
});
