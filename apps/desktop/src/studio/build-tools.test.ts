import {
  assembleParts,
  scoreSockets,
  startHistory,
  VoxelAssemblySchema,
  type SocketProbe,
  type SocketRef,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import {
  atBaseline,
  canRotate,
  canUndo,
  colorsOf,
  endRecolorRun,
  fillEmpty,
  measureOf,
  NOTHING_TO_FILL,
  pickPart,
  placeAt,
  randomize,
  recolorSelected,
  refusalText,
  reset,
  rotateSelected,
  selectInstance,
  startBuild,
  stepCreature,
  stepSelected,
  stepSpread,
  toggleMirror,
  undo,
  type BuildState,
} from "./assembly-state";
import { angleBetween, dragTarget } from "./drag-to-socket";
import { builtInParts } from "./fixtures/built-in-parts";
import { assemblyOf, partsKit } from "./parts-kit";

// Build mode's tools beyond placing (ADR 0023 §7–§9, §12; M21 PR 5b): recolour, ladder steps,
// turning, Randomize, Fill empty, Reset, a loaded baseline and drag-to-socket's target.

const made = partsKit(builtInParts());
if (!made) throw new Error("No kit");
const kit = made;
const fourLegged = kit.byId.get("hollow:four-legged-torso");
if (!fourLegged) throw new Error("No four-legged torso");
const LEGGED = assemblyOf(fourLegged, kit.lookup);
const ROOT = LEGGED.instances[0]?.id ?? "";
const legged = (): BuildState => ({ ...startBuild(kit), history: startHistory(LEGGED) });
const present = (state: BuildState) => state.history.present;
const at = (socket: string, instance = ROOT): SocketRef => ({ instance, socket });
const valid = (assembly: VoxelAssembly) =>
  expect(VoxelAssemblySchema.safeParse(assembly).success).toBe(true);
const partOf = (state: BuildState, id: string) => {
  const assembly = present(state);
  const instance = assembly.instances.find((i) => i.id === id);
  return instance && { key: instance.part, part: assembly.parts[instance.part] };
};

/** Paw legs on all four hips, placed with Mirror on: one part copy shared by four instances. */
function fourLegs(): BuildState {
  const back = placeAt(pickPart(legged(), kit, "hollow:paw-leg"), kit, at("back-left"));
  return placeAt(pickPart(back, kit, "hollow:paw-leg"), kit, at("front-left"));
}

/** A round head with bead eyes, each placed at once. */
const withEyes = () =>
  pickPart(pickPart(legged(), kit, "hollow:round-head"), kit, "hollow:bead-eye");

describe("recolouring", () => {
  it("changes a colour slot of the selected part and its image, copying a shared copy", () => {
    const legs = selectInstance(fourLegs(), "back-left");
    expect(new Set(["back-left", "front-left"].map((id) => partOf(legs, id)?.key)).size).toBe(1);
    const before = colorsOf(legs);
    const recoloured = recolorSelected(legs, 0, "#123456");
    expect(colorsOf(recoloured)?.[0]).toBe("#123456");
    // The back pair got a copy of its own; the front pair keeps the colour it had.
    expect(partOf(recoloured, "back-right")?.part?.colors[0]).toBe("#123456");
    expect(partOf(recoloured, "back-right")?.key).toBe(partOf(recoloured, "back-left")?.key);
    expect(partOf(recoloured, "front-left")?.part?.colors).toEqual(before);
    expect(partOf(recoloured, "back-left")?.key).not.toBe(partOf(recoloured, "front-left")?.key);
    expect(recoloured.selected).toBe("back-left");
    valid(present(recoloured));
    // One undo step.
    expect(present(undo(recoloured))).toBe(present(legs));
  });

  it("changes one side only with Mirror off, and records nothing for the same colour", () => {
    const legs = toggleMirror(selectInstance(fourLegs(), "back-left"));
    const recoloured = recolorSelected(legs, 1, "#ABCDEF");
    // Stored lower-case, as the suggested colours are.
    expect(partOf(recoloured, "back-left")?.part?.colors[1]).toBe("#abcdef");
    expect(partOf(recoloured, "back-right")?.part?.colors[1]).not.toBe("#abcdef");
    expect(recolorSelected(recoloured, 1, "#abcdef")).toBe(recoloured);
    // Nothing selected, nothing to recolour.
    const none = selectInstance(fourLegs(), undefined);
    expect(recolorSelected(none, 0, "#123456")).toBe(none);
  });

  it("makes one undo step of a run of live colours, until the picker closes", () => {
    const legs = selectInstance(fourLegs(), "back-left");
    let state = recolorSelected(legs, 0, "#111111", { live: true });
    state = recolorSelected(state, 0, "#222222", { live: true });
    state = recolorSelected(state, 0, "#333333", { live: true });
    expect(colorsOf(state)?.[0]).toBe("#333333");
    expect(state.history.past).toHaveLength(legs.history.past.length + 1);
    expect(present(undo(state))).toBe(present(legs));
    // Closed: the next live colour is a new step.
    const next = recolorSelected(endRecolorRun(state), 0, "#444444", { live: true });
    expect(next.history.past).toHaveLength(state.history.past.length + 1);
    // Another slot is a new step too.
    const other = recolorSelected(state, 1, "#555555", { live: true });
    expect(other.history.past).toHaveLength(state.history.past.length + 1);
  });

  it("lists the suggested colours from the pack, lower-case", () => {
    expect(kit.suggestedColors.length).toBeGreaterThan(0);
    for (const color of kit.suggestedColors) expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("ladder steps", () => {
  it("steps the selected part and its image, and hints when it is two steps from the torso", () => {
    const eyes = selectInstance(withEyes(), "left-eye");
    expect(stepSpread(present(eyes))).toBe(false);
    const finer = stepSelected(eyes, -1);
    expect(partOf(finer, "left-eye")?.part?.step).toBe(0.0125);
    expect(partOf(finer, "right-eye")?.part?.step).toBe(0.0125);
    expect(finer.selected).toBe("left-eye");
    // 1.25 cm against the torso's 5 cm: a hint, not a block.
    expect(stepSpread(present(finer))).toBe(true);
    valid(present(finer));
    expect(present(undo(finer))).toBe(present(eyes));
  });

  it("refuses a step past the ladder's end or one that breaks a joint, saying why", () => {
    const finest = stepSelected(stepSelected(selectInstance(withEyes(), "left-eye"), -1), -1);
    expect(finest.notice).toBe(refusalText("ladder_end", "shrink"));
    expect(finest.notice).toBe("Its cubes are as small as they go.");
    // At 10 cm cubes the head no longer sits on the finer grid of the torso's socket, so the
    // torso can't grow on its own.
    const eyes = withEyes();
    const torso = stepSelected(selectInstance(eyes, ROOT), 1);
    expect(present(torso)).toBe(present(eyes));
    expect(torso.notice).toBe("It can't grow: a part would come out of its joint or off the grid.");
    // The bare torso grows: it is the head that would leave the grid.
    expect(present(stepSelected(selectInstance(legged(), ROOT), 1))).not.toBe(LEGGED);
  });

  it("steps the whole creature, keeping the selection, until a part is at the ladder's end", () => {
    const eyes = selectInstance(withEyes(), "left-eye");
    const bigger = stepCreature(eyes, 1);
    expect(partOf(bigger, ROOT)?.part?.step).toBe(0.1);
    expect(partOf(bigger, "left-eye")?.part?.step).toBe(0.05);
    expect(measureOf(present(bigger), kit).height).toBeCloseTo(
      2 * measureOf(present(eyes), kit).height,
    );
    expect(bigger.selected).toBe("left-eye");
    valid(present(bigger));
    const again = stepCreature(bigger, 1);
    expect(present(again)).toBe(present(bigger));
    expect(again.notice).toBe(
      "A part's cubes are as big as they go, so the creature can't grow any more.",
    );
    expect(present(stepCreature(bigger, -1))).toEqual(present(eyes));
  });

  it("can't make a creature of the built-in parts larger than large, so that block isn't met yet", () => {
    // Every torso, filled at random and stepped up as a whole: the biggest stays within large.
    for (const root of kit.rootParts) {
      for (const seed of [0, 1, 2, 3]) {
        const state = { ...startBuild(kit), history: startHistory(randomAt(root.id, seed)) };
        const grown = stepCreature(state, 1);
        expect(measureOf(present(grown), kit).sizeClass).toBe("large");
        // Nor does turning any part, one to three quarter turns, with Mirror on or off.
        for (const mirror of [true, false]) {
          for (const { id } of present(grown).instances.slice(1)) {
            let turned: BuildState = { ...grown, mirror, selected: id };
            for (let turn = 1; turn < 4; turn++) {
              turned = rotateSelected(turned);
              expect(measureOf(present(turned), kit).sizeClass).toBe("large");
            }
          }
        }
      }
    }
  });
});

const randomAt = (rootId: string, seed: number) => {
  const root = kit.byId.get(rootId);
  if (!root) throw new Error(`No ${rootId}`);
  return assembleParts({ start: root, parts: kit.parts, lookup: kit.lookup, seed });
};

describe("turning", () => {
  it("turns the selected part and its image a quarter turn; the torso can't turn", () => {
    const legs = selectInstance(fourLegs(), "back-left");
    expect(canRotate(legs)).toBe(true);
    const turned = rotateSelected(legs);
    const rotation = (id: string) =>
      present(turned).instances.find((instance) => instance.id === id)?.rotation;
    expect(rotation("back-left")).not.toEqual([0, 0, 0, 1]);
    expect(rotation("back-right")).toEqual(rotation("back-left"));
    expect(rotation("front-left")).toEqual([0, 0, 0, 1]);
    valid(present(turned));
    expect(present(undo(turned))).toBe(present(legs));

    const root = selectInstance(legs, ROOT);
    expect(canRotate(root)).toBe(false);
    expect(rotateSelected(root).notice).toBe("The torso can't turn: everything hangs from it.");
  });
});

describe("Randomize and Fill empty", () => {
  it("builds the same random creature for the same seed, on a root part, as one undo step", () => {
    const start = startBuild(kit);
    const a = randomize(start, kit, 7);
    const b = randomize(start, kit, 7);
    expect(JSON.stringify(present(a))).toBe(JSON.stringify(present(b)));
    valid(present(a));
    const root = present(a).instances.find((instance) => !instance.parent);
    const rootType = root && present(a).parts[root.part]?.type;
    expect(rootType && kit.roots.has(rootType)).toBe(true);
    expect(present(a).instances.length).toBeGreaterThan(1);
    expect(present(undo(a))).toBe(present(start));
    expect(a.selected).toBeUndefined();
    // Seeds pick different torsos.
    const roots = new Set(
      [0, 1, 2, 3].map((seed) => present(randomize(start, kit, seed)).instances[0]?.part),
    );
    expect(roots.size).toBe(4);
  });

  it("fills the free sockets and keeps every part there was, the same for the same seed", () => {
    const head = selectInstance(withEyes(), "neck");
    const filled = fillEmpty(head, kit, 5);
    const kept = present(head).instances;
    expect(present(filled).instances.slice(0, kept.length)).toEqual(kept);
    expect(present(filled).instances.length).toBeGreaterThan(kept.length);
    expect(JSON.stringify(present(fillEmpty(head, kit, 5)))).toBe(JSON.stringify(present(filled)));
    expect(filled.selected).toBe("neck");
    valid(present(filled));
    expect(present(undo(filled))).toBe(present(head));
    // Full: nothing to fill, nothing recorded.
    const again = fillEmpty(filled, kit, 9);
    expect(again.history).toBe(filled.history);
    expect(again.notice).toBe(NOTHING_TO_FILL);
  });
});

describe("Reset and a loaded creature", () => {
  it("goes back to the default torso as one undo step", () => {
    const start = startBuild(kit);
    expect(atBaseline(start)).toBe(true);
    expect(reset(start).history).toBe(start.history);
    const edited = randomize(start, kit, 3);
    expect(atBaseline(edited)).toBe(false);
    const back = reset(edited);
    expect(present(back)).toBe(kit.start);
    expect(atBaseline(back)).toBe(true);
    expect(canUndo(back)).toBe(true);
    expect(present(undo(back))).toBe(present(edited));
  });

  it("starts a loaded creature afresh, with it as what Reset goes back to", () => {
    const loaded = randomAt("hollow:upright-torso", 4);
    const state = startBuild(kit, loaded);
    expect(present(state)).toBe(loaded);
    expect(canUndo(state)).toBe(false);
    expect(atBaseline(state)).toBe(true);
    const edited = recolorSelected(selectInstance(state, "neck"), 0, "#101010");
    expect(atBaseline(edited)).toBe(false);
    expect(present(reset(edited))).toBe(loaded);
  });
});

describe("drag-to-socket's target", () => {
  /** Where each of `sockets` is in the body frame, by `scoreSockets`. */
  const positions = (assembly: VoxelAssembly, sockets: SocketRef[]) =>
    new Map(
      scoreSockets(assembly, sockets, {
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 1, y: 0, z: 0 },
      }).map((s) => [s.socket, s.position]),
    );
  const legSockets = ["front-left", "front-right", "back-left", "back-right"].map((s) => at(s));
  const reach = 0.05;
  /** A probe from 2 m above-left aimed at `target`. */
  const aimedAt = (target: { x: number; y: number; z: number }, from = { x: 0, y: 2, z: 2 }) => ({
    origin: from,
    direction: { x: target.x - from.x, y: target.y - from.y, z: target.z - from.z },
  });

  it("picks the socket the probe points at, among those the part can go on", () => {
    const where = positions(LEGGED, legSockets);
    const backLeft = where.get("back-left");
    if (!backLeft) throw new Error("No back-left");
    expect(dragTarget(kit, LEGGED, "hollow:paw-leg", true, aimedAt(backLeft), reach)).toEqual(
      at("back-left"),
    );
    // Nowhere near a socket: none.
    const away: SocketProbe = { origin: { x: 0, y: 2, z: 2 }, direction: { x: 0, y: 1, z: 0 } };
    expect(dragTarget(kit, LEGGED, "hollow:paw-leg", true, away, reach)).toBeUndefined();
    // A part with nowhere to go has no target.
    expect(
      dragTarget(kit, LEGGED, "hollow:bead-eye", true, aimedAt(backLeft), reach),
    ).toBeUndefined();
  });

  it("is forgiving: a probe a little off the socket still finds it", () => {
    const where = positions(LEGGED, legSockets);
    const backLeft = where.get("back-left");
    if (!backLeft) throw new Error("No back-left");
    const off = aimedAt({ ...backLeft, x: backLeft.x + 0.03 });
    const angle = angleBetween(off.direction, aimedAt(backLeft).direction);
    expect(angle).toBeGreaterThan(0);
    expect(angle).toBeLessThan(reach);
    expect(dragTarget(kit, LEGGED, "hollow:paw-leg", true, off, reach)).toEqual(at("back-left"));
  });

  it("prefers the nearer of two sockets in line, and finds taken sockets the part can replace", () => {
    const where = positions(LEGGED, legSockets);
    const backLeft = where.get("back-left");
    if (!backLeft) throw new Error("No back-left");
    // From the creature's left side, straight across: back-left in front of back-right.
    const side = Math.sign(backLeft.z);
    const across = aimedAt(backLeft, { x: backLeft.x, y: backLeft.y, z: backLeft.z + 2 * side });
    expect(dragTarget(kit, LEGGED, "hollow:paw-leg", false, across, reach)).toEqual(
      at("back-left"),
    );
    // The legs move the body frame's origin, so the sockets are found again.
    const legs = present(fourLegs());
    const taken = positions(legs, legSockets).get("back-left");
    if (!taken) throw new Error("No back-left");
    expect(dragTarget(kit, legs, "hollow:stout-leg", true, aimedAt(taken), reach)).toEqual(
      at("back-left"),
    );
  });
});
