import type { VoxelPoint, VoxelSocket } from "@living-diorama/content-schema";
import type { PartSidecar } from "./part-definition";
import {
  box,
  capsule,
  ellipsoid,
  intersect,
  roundedBox,
  Sketch,
  superellipsoid,
  union,
  type Point,
  type Solid,
} from "./shapes";
import type { VoxCubes } from "./vox-parser";

// The first-pass recipes of the built-in pack's starter parts (ADR 0022, M20 decisions "First-pass
// art in code" and "The starter set"), written as `.vox` files and sidecars by
// `pnpm parts:bootstrap`. Once written, the `.vox` files and sidecars are the parts' sources: they
// are refined in MagicaVoxel and by hand, and a recipe only makes a part whose files are missing
// (or every part again with `--force`, which discards those edits).
//
// Axes as ADR 0022 §16: +X forward, Y up, +Z to the creature's right. A part for the base socket
// of a mirrored pair is made for the creature's left (−Z) side; the right one is its mirror image.
// Large parts use 5 cm cubes; eyes, noses and mouths 2.5 cm, as thin raised parts: a back layer
// sunk half a 5 cm cube into the face and a front layer standing proud of it.
//
// Joints: every socket lies at least one cube of the finer grid inside its part (§12). A part
// reaches into its parent with a peg narrower than what shows outside, and sockets sit away from
// the parent's edges, so the two parts' outer faces never lie flush in one plane (§14). Sockets on
// a torso's or head's middle (a neck, a nose) are at z = width / 2, half a cube, with the part's
// attach point at half a cube too; every other socket and attach point between two 5 cm parts is
// at whole cubes.

/** A starter part's sidecar and how to make its cubes. */
export interface StarterPart {
  /** The file name of its `.vox` and sidecar, without an extension. */
  file: string;
  sidecar: PartSidecar;
  cubes: () => VoxCubes;
}

const LARGE = 0.05;
const FINE = 0.025;

// Colours: creature hues toned toward Woodland Hollow's greens, browns and stone (ADR 0022 §4–§5),
// with no pure black or white; dark details are near-black.
const DARK = "#1d1d1d";
const EYE_WHITE = "#ece5d3";
const GLINT = "#f6f1e4";

const FOX = "#bf7e45";
const FOX_SHADE = "#a2693a";
const CREAM = "#e6d5ae";
const PAW = "#5e4433";

const BROWN = "#977250";
const BROWN_SHADE = "#7d5d41";
const BELLY = "#d9c49c";
const PINK = "#d69a8b";
const PINK_SHADE = "#bb8174";

const TEAL = "#5d939a";
const TEAL_SHADE = "#4b7c83";
const TEAL_BELLY = "#c3d3b8";
const FIN = "#8bbcab";
const FIN_SHADE = "#6c9f8f";

const MOSS = "#479571";
const MOSS_LIGHT = "#74b88f";
const MOSS_DARK = "#2f7354";
const MOSS_FEET = "#6b4a2e";
const CHEEK = "#d99484";

const p = (x: number, y: number, z: number): Point => ({ x, y, z });
const at = (x: number, y: number, z: number): VoxelPoint => ({ x, y, z });

/** A socket, and its mirrored twin at `z` when given. */
function sockets(
  id: string,
  type: string,
  position: VoxelPoint,
  mirror?: { id: string; z: number },
): VoxelSocket[] {
  const base: VoxelSocket = { id, type: `hollow:${type}`, position };
  if (!mirror) return [base];
  return [base, { ...base, id: mirror.id, position: { ...position, z: mirror.z }, mirrors: id }];
}

function part(
  file: string,
  name: string,
  type: string,
  step: PartSidecar["step"],
  attach: VoxelPoint,
  socketList: VoxelSocket[],
  cubes: () => VoxCubes,
): StarterPart {
  return {
    file,
    sidecar: {
      id: `hollow:${file}`,
      version: "1.0.0",
      name,
      type: `hollow:${type}`,
      step,
      attach,
      sockets: socketList,
    },
    cubes,
  };
}

const below =
  (y: number): Solid =>
  (q) =>
    q.y < y;
const above =
  (y: number): Solid =>
  (q) =>
    q.y > y;
const before =
  (x: number): Solid =>
  (q) =>
    q.x < x;
const behind =
  (x: number): Solid =>
  (q) =>
    q.x > x;
const UP = { axis: "y", sign: 1 } as const;
const DOWN = { axis: "y", sign: -1 } as const;
const FRONT = { axis: "x", sign: 1 } as const;
const BACK = { axis: "x", sign: -1 } as const;

// Torsos ------------------------------------------------------------------------------------------

/** A four-legged body, 45 × 30 × 35 cm: four leg mounts below, a neck and a tail base. */
const fourLeggedTorso = part(
  "four-legged-torso",
  "Four-legged torso",
  "torso",
  LARGE,
  at(4.5, 0, 3.5),
  [
    ...sockets("front-left", "leg-mount", at(6, 1, 2.5), { id: "front-right", z: 4.5 }),
    ...sockets("back-left", "leg-mount", at(3, 1, 2.5), { id: "back-right", z: 4.5 }),
    ...sockets("neck", "neck", at(6, 5, 3.5)),
    ...sockets("tail-base", "tail-base", at(1, 3, 3.5)),
  ],
  () =>
    new Sketch({ x: 9, y: 6, z: 7 }, [FOX, CREAM, FOX_SHADE])
      .fill(roundedBox(p(0, 0, 0), p(9, 6, 7), 2.2))
      // A pale belly and chest, a darker saddle.
      .paintFacing(DOWN, 2, (q) => q.z > 1.5 && q.z < 5.5)
      .paintFacing(FRONT, 2, (q) => q.y < 3.5 && q.z > 1.5 && q.z < 5.5)
      .paintFacing(UP, 3, (q) => q.z > 2 && q.z < 5 && q.x > 1 && q.x < 6)
      .cubes(),
);

/** An upright body, 35 × 35 × 35 cm: hips below, arms at the shoulders, a neck and a tail base. */
const uprightTorso = part(
  "upright-torso",
  "Upright torso",
  "torso",
  LARGE,
  at(3.5, 0, 3.5),
  [
    ...sockets("left-hip", "leg-mount", at(3, 1, 2.5), { id: "right-hip", z: 4.5 }),
    ...sockets("left-arm", "shoulder", at(3, 5, 1), { id: "right-arm", z: 6 }),
    ...sockets("neck", "neck", at(4, 6, 3.5)),
    ...sockets("tail-base", "tail-base", at(1, 2, 3.5)),
  ],
  () =>
    new Sketch({ x: 7, y: 7, z: 7 }, [BROWN, BELLY, BROWN_SHADE])
      .fill(roundedBox(p(0, 0, 0), p(7, 7, 7), 2.4))
      // A pale belly on the front, a darker back.
      .paintFacing(FRONT, 2, (q) => q.z > 1.5 && q.z < 5.5 && q.y > 1 && q.y < 5)
      .paintFacing(BACK, 3, (q) => q.y > 3)
      .cubes(),
);

/** A fish or blob body, 35 × 30 × 35 cm: side fins, a mount for a tail fin and a neck. */
const fishTorso = part(
  "fish-torso",
  "Fish torso",
  "torso",
  LARGE,
  at(3.5, 0, 3.5),
  [
    ...sockets("left-fin", "fin-mount", at(4, 3, 1), { id: "right-fin", z: 6 }),
    ...sockets("tail-base", "tail-fin-mount", at(1, 3, 3.5)),
    ...sockets("neck", "neck", at(6, 3, 3.5)),
  ],
  () =>
    new Sketch({ x: 7, y: 6, z: 7 }, [TEAL, TEAL_BELLY, TEAL_SHADE])
      .fill(superellipsoid(p(3.5, 3, 3.5), p(3.7, 3.2, 3.7), 2.6))
      .paint(below(2), 2)
      .paintFacing(UP, 3, (q) => q.x > 1 && q.x < 6)
      .cubes(),
);

// Heads -------------------------------------------------------------------------------------------
// A head reaches into its torso's neck with a peg below it. Its face is flat, so face parts sit
// on it evenly.

/** A round head, 30 × 25 × 35 cm, with a pale muzzle. */
const roundHead = part(
  "round-head",
  "Round head",
  "head",
  LARGE,
  at(3, 0, 3.5),
  [
    ...sockets("left-ear", "ear-mount", at(2, 5, 3), { id: "right-ear", z: 4 }),
    ...sockets("left-eye", "eye-mount", at(5.5, 4, 2), { id: "right-eye", z: 5 }),
    ...sockets("nose", "nose-mount", at(5.5, 2.5, 3.5)),
    ...sockets("mouth", "mouth-mount", at(5.5, 1.5, 3.5)),
  ],
  () =>
    new Sketch({ x: 6, y: 6, z: 7 }, [BROWN, BELLY])
      .fill(box(p(2, 0, 2), p(4, 1, 5)))
      .fill(intersect(roundedBox(p(0, 1, 0), p(8, 6, 7), 2), before(6)))
      .paint((q) => q.x > 4 && q.y < 3 && q.y > 1 && q.z > 1.5 && q.z < 5.5, 2)
      .cubes(),
);

/** A head with a long snout low on its face, 35 × 25 × 35 cm, pale below. */
const snoutHead = part(
  "snout-head",
  "Snout head",
  "head",
  LARGE,
  at(2, 0, 3.5),
  [
    ...sockets("left-ear", "ear-mount", at(2, 5, 3), { id: "right-ear", z: 4 }),
    ...sockets("left-eye", "eye-mount", at(4.5, 4, 2), { id: "right-eye", z: 5 }),
    ...sockets("nose", "nose-mount", at(6.5, 2.5, 3.5)),
    ...sockets("mouth", "mouth-mount", at(6.5, 1.5, 3.5)),
  ],
  () =>
    new Sketch({ x: 7, y: 6, z: 7 }, [FOX, CREAM])
      .fill(box(p(1, 0, 2), p(3, 1, 5)))
      .fill(intersect(roundedBox(p(0, 1, 0), p(7, 6, 7), 2), before(5)))
      .fill(box(p(5, 1, 2), p(7, 3, 5)))
      // Pale cheeks and the underside of the snout.
      .paint((q) => q.y > 1 && q.y < 2 && q.x > 2, 2)
      .paint((q) => q.y > 1 && q.y < 3 && q.x > 3 && q.x < 5 && (q.z < 1 || q.z > 6), 2)
      .cubes(),
);

/** A wide, flat head, 15 × 20 × 45 cm, for frogs and fish. It reaches into a neck from behind. */
const wideHead = part(
  "wide-head",
  "Wide head",
  "head",
  LARGE,
  at(0, 2, 4.5),
  [
    ...sockets("left-ear", "ear-mount", at(2, 3, 4), { id: "right-ear", z: 5 }),
    ...sockets("left-eye", "eye-mount", at(3.5, 3, 2.5), { id: "right-eye", z: 6.5 }),
    ...sockets("nose", "nose-mount", at(3.5, 2.5, 4.5)),
    ...sockets("mouth", "mouth-mount", at(3.5, 1.5, 4.5)),
  ],
  () =>
    new Sketch({ x: 4, y: 4, z: 9 }, [TEAL, TEAL_BELLY, TEAL_SHADE])
      .fill(box(p(0, 1, 3), p(1, 3, 6)))
      .fill(intersect(roundedBox(p(-1, 0, 0), p(6, 4, 9), 1.6), behind(1), before(4)))
      // Rounder front corners, which also keep the creature's footprint small.
      .carve(box(p(3, 0, 0), p(4, 4, 1)))
      .carve(box(p(3, 0, 8), p(4, 4, 9)))
      .paint(below(1), 2)
      .paintFacing(UP, 3, (q) => q.x < 3)
      .cubes(),
);

// Limbs -------------------------------------------------------------------------------------------
// A leg or arm reaches into its torso with a peg at its inner top.

/** A slim leg, 10 cm below the body, with a dark paw stepping forward. */
const pawLeg = part("paw-leg", "Paw leg", "leg", LARGE, at(1, 3, 1.5), [], () =>
  new Sketch({ x: 3, y: 3, z: 2 }, [FOX, PAW])
    .fill(box(p(0, 0, 0), p(2, 2, 2)))
    .fill(box(p(0, 2, 1), p(2, 3, 2)))
    .fill(box(p(2, 0, 0), p(3, 1, 2)), 2)
    .paint(below(1), 2)
    .cubes(),
);

/** A short stout leg with a broad dark foot. */
const stoutLeg = part("stout-leg", "Stout leg", "leg", LARGE, at(1, 3, 1.5), [], () =>
  new Sketch({ x: 3, y: 3, z: 2 }, [BROWN, BROWN_SHADE])
    .fill(box(p(0, 1, 0), p(2, 2, 2)))
    .fill(box(p(0, 2, 1), p(2, 3, 2)))
    .fill(box(p(0, 0, 0), p(3, 1, 2)), 2)
    .cubes(),
);

/** An arm hanging at the side, with a pale paw. */
const pawArm = part("paw-arm", "Paw arm", "arm", LARGE, at(1, 4, 2), [], () =>
  new Sketch({ x: 2, y: 4, z: 2 }, [BROWN, BELLY])
    .fill(box(p(0, 0, 0), p(2, 4, 1)))
    .fill(box(p(0, 3, 1), p(2, 4, 2)))
    .paint(below(1), 2)
    .cubes(),
);

/** A thin arm reaching down and forward, with a dark mitten. */
const mittenArm = part("mitten-arm", "Mitten arm", "arm", LARGE, at(1, 5, 2), [], () =>
  new Sketch({ x: 3, y: 5, z: 2 }, [FOX, PAW])
    .fill(box(p(0, 1, 0), p(1, 5, 1)))
    .fill(box(p(0, 4, 1), p(1, 5, 2)))
    .fill(box(p(1, 0, 0), p(3, 2, 1)), 2)
    .cubes(),
);

// Tails, ears and fins ----------------------------------------------------------------------------

/** A big bushy tail sweeping up and back, with a pale tip. Its peg is at its front. */
const bushyTail = part("bushy-tail", "Bushy tail", "tail", LARGE, at(5, 1, 1.5), [], () =>
  new Sketch({ x: 5, y: 7, z: 3 }, [FOX, CREAM, FOX_SHADE])
    .fill(
      intersect(
        union(
          capsule(p(3.4, 1.5, 1.5), p(2, 3.6, 1.5), 1.45),
          ellipsoid(p(1.8, 4.6, 1.5), p(1.9, 2.4, 1.6)),
        ),
        before(4),
      ),
    )
    .fill(box(p(4, 1, 1), p(5, 2, 2)))
    .paintFacing(DOWN, 3, (q) => q.y < 4)
    .paint(above(5.6), 2)
    .cubes(),
);

/** A round puff of a tail, pale at its back. */
const puffTail = part("puff-tail", "Puff tail", "tail", LARGE, at(4, 1, 1.5), [], () =>
  new Sketch({ x: 4, y: 3, z: 3 }, [BELLY, CREAM])
    .fill(intersect(ellipsoid(p(1.5, 1.5, 1.5), p(1.75, 1.75, 1.75)), before(3)))
    .fill(box(p(3, 1, 1), p(4, 2, 2)))
    .paintFacing(BACK, 2)
    .cubes(),
);

/** A tall pointed ear with a dark tip, leaning out. Its peg is at its inner bottom. */
const pointedEar = part("pointed-ear", "Pointed ear", "ear", LARGE, at(0, 1, 3), [], () =>
  new Sketch({ x: 1, y: 4, z: 3 }, [FOX, PAW])
    .fill(box(p(0, 0, 2), p(1, 2, 3)))
    .fill(box(p(0, 2, 0), p(1, 3, 3)))
    .fill(box(p(0, 3, 1), p(1, 4, 2)))
    .fill(box(p(0, 3, 0), p(1, 4, 1)), 2)
    .cubes(),
);

/** A round ear with a pink middle. Its peg is at its inner bottom. */
const roundEar = part("round-ear", "Round ear", "ear", LARGE, at(0, 1, 3), [], () =>
  new Sketch({ x: 2, y: 4, z: 3 }, [BROWN, PINK])
    .fill(box(p(0, 0, 2), p(1, 2, 3)))
    .fill(box(p(0, 2, 0), p(2, 4, 3)))
    .paint(box(p(1, 2, 1), p(2, 3, 2)), 2)
    .cubes(),
);

/** A flat paddle of a side fin, swept back. Its peg is at its inner front. */
const sideFin = part("side-fin", "Side fin", "fin", LARGE, at(3, 1, 2), [], () =>
  new Sketch({ x: 4, y: 1, z: 2 }, [FIN, FIN_SHADE])
    .fill(box(p(2, 0, 1), p(4, 1, 2)))
    .fill(box(p(0, 0, 0), p(4, 1, 1)))
    .paint(box(p(0, 0, 0), p(2, 1, 1)), 2)
    .cubes(),
);

/** A fan of a fin spreading backward with a notch, for a fish's tail. */
const fanFin = part("fan-fin", "Fan fin", "tail-fin", LARGE, at(3, 3, 0.5), [], () =>
  new Sketch({ x: 3, y: 5, z: 1 }, [FIN, FIN_SHADE])
    .fill(box(p(2, 2, 0), p(3, 3, 1)))
    .fill(box(p(1, 1, 0), p(2, 4, 1)))
    .fill(box(p(0, 0, 0), p(1, 5, 1)), 2)
    .carve(box(p(0, 2, 0), p(1, 3, 1)))
    .cubes(),
);

// Face parts --------------------------------------------------------------------------------------
// 2.5 cm cubes, two layers deep: the back one sinks into the face, so it is kept inside the front
// one's outline, away from the face's edges.

/** A big round eye: a pale ring, a dark pupil and a glint, 10 × 10 cm. */
const roundEye = part("round-eye", "Round eye", "eye", FINE, at(0, 2, 2), [], () =>
  new Sketch({ x: 2, y: 4, z: 4 }, [EYE_WHITE, DARK, GLINT])
    .fill(box(p(1, 1, 0), p(2, 3, 4)))
    .fill(box(p(1, 0, 1), p(2, 4, 3)))
    .fill(box(p(0, 1, 1), p(1, 3, 3)))
    .paint(box(p(1, 1, 1), p(2, 3, 3)), 2)
    .set(1, 2, 1, 3)
    .cubes(),
);

/** A small dark bead eye with a glint, 5 × 5 cm. */
const beadEye = part("bead-eye", "Bead eye", "eye", FINE, at(0, 1, 1), [], () =>
  new Sketch({ x: 2, y: 2, z: 2 }, [DARK, GLINT])
    .fill(box(p(1, 0, 0), p(2, 2, 2)))
    .fill(box(p(0, 0, 1), p(1, 1, 2)))
    .set(1, 1, 1, 2)
    .cubes(),
);

/** A dark button nose, wide at the top, 10 × 5 cm. */
const buttonNose = part("button-nose", "Button nose", "nose", FINE, at(0, 1, 2), [], () =>
  new Sketch({ x: 2, y: 2, z: 4 }, [DARK, "#463b35"])
    .fill(box(p(1, 1, 0), p(2, 2, 4)))
    .fill(box(p(0, 0, 1), p(2, 1, 3)))
    .set(1, 1, 1, 2)
    .cubes(),
);

/** A small pink nose, 10 × 5 cm. */
const pinkNose = part("pink-nose", "Pink nose", "nose", FINE, at(0, 1, 2), [], () =>
  new Sketch({ x: 2, y: 2, z: 4 }, [PINK, PINK_SHADE])
    .fill(box(p(1, 1, 0), p(2, 2, 4)))
    .fill(box(p(0, 0, 1), p(2, 1, 3)))
    .paint(below(1), 2)
    .cubes(),
);

/** A dark smile, 10 × 5 cm. */
const smile = part("smile", "Smile", "mouth", FINE, at(0, 1, 2), [], () =>
  new Sketch({ x: 2, y: 2, z: 4 }, [DARK])
    .fill(box(p(1, 0, 1), p(2, 1, 3)))
    .fill(box(p(0, 1, 0), p(2, 2, 1)))
    .fill(box(p(0, 1, 3), p(2, 2, 4)))
    .cubes(),
);

/** A small open mouth with a pink tongue, 10 × 5 cm. */
const openMouth = part("open-mouth", "Open mouth", "mouth", FINE, at(0, 1, 2), [], () =>
  new Sketch({ x: 2, y: 2, z: 4 }, [DARK, PINK])
    .fill(box(p(0, 1, 0), p(2, 2, 4)))
    .fill(box(p(1, 0, 1), p(2, 1, 3)), 2)
    .cubes(),
);

// The mossling ------------------------------------------------------------------------------------
// One round mossy body cut in two: the torso is its bottom slice, with the feet, and the head the
// rest, with the face. Both are cut from the same solid, in the creature's own cubes.

/** The mossling's round body, flat in front for its face, in its cubes with the feet below. */
const mosslingBody = intersect(
  superellipsoid(p(5.5, 5.1, 4.5), p(5.6, 6.1, 4.6), 2.4),
  (q) => q.y > 0 && q.x < 10,
);
/** Where the torso ends and the head begins, in the body's cubes. */
const MOSSLING_SPLIT = 3;

/** The bottom slice of the mossling's body, 50 × 15 × 45 cm, with two hips and the neck. */
const mosslingTorso = part(
  "mossling-torso",
  "Mossling torso",
  "torso",
  LARGE,
  at(5, 0, 4.5),
  [
    ...sockets("left-hip", "leg-mount", at(6, 1, 3), { id: "right-hip", z: 6 }),
    ...sockets("neck", "neck", at(5, 2, 4.5)),
  ],
  () =>
    new Sketch({ x: 10, y: MOSSLING_SPLIT, z: 9 }, [MOSS, MOSS_DARK])
      .fill(intersect(mosslingBody, below(MOSSLING_SPLIT)))
      .paintFacing(DOWN, 2)
      .cubes(),
);

/**
 * The rest of the mossling's body, 50 × 50 × 45 cm, with its face, pink cheeks, a pale sheen on its
 * back and darker moss on top. Its bottom layer reaches into the torso, one cube inside its edge.
 */
const mosslingHead = part(
  "mossling-head",
  "Mossling head",
  "head",
  LARGE,
  at(5, 0, 4.5),
  [
    ...sockets("left-eye", "eye-mount", at(9.5, 4.5, 3), { id: "right-eye", z: 6 }),
    ...sockets("nose", "nose-mount", at(9.5, 3.5, 4.5)),
    ...sockets("mouth", "mouth-mount", at(9.5, 2.5, 4.5)),
    ...sockets("left-ear", "ear-mount", at(4, 8, 4), { id: "right-ear", z: 5 }),
  ],
  () => {
    const s = MOSSLING_SPLIT;
    const body = (q: Point) => mosslingBody({ ...q, y: q.y + s - 1 });
    // The bottom layer: the torso's top layer, one cube in from its edges.
    const inside = (q: Point) =>
      [
        [0, 0],
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].every(([dx = 0, dz = 0]) => mosslingBody({ x: q.x + dx, y: s - 0.5, z: q.z + dz }));
    const sheen = (q: Point) => q.x < 4.5 && q.y > 4 && q.z < 4;
    const spots = [p(6.5, 8.5, 3.5), p(3.5, 8.5, 5.5)];
    return new Sketch({ x: 10, y: 9, z: 9 }, [MOSS, MOSS_LIGHT, MOSS_DARK, CHEEK])
      .fill(intersect(body, above(1)))
      .fill(intersect(below(1), (q) => inside({ x: q.x, y: 0, z: q.z })))
      .paintFacing(BACK, 2, sheen)
      .paintFacing({ axis: "z", sign: -1 }, 2, sheen)
      .paintFacing(
        UP,
        3,
        (q) => q.y > 7 && spots.some((c) => Math.abs(c.x - q.x) + Math.abs(c.z - q.z) < 0.6),
      )
      .paintFacing(FRONT, 4, (q) => q.y > 2 && q.y < 4 && (q.z < 2.5 || q.z > 6.5))
      .cubes();
  },
);

/** A mossling's round brown foot, peeking out under its body. Its peg is at its inner top. */
const mosslingFoot = part("mossling-foot", "Mossling foot", "leg", LARGE, at(2, 2, 2), [], () =>
  new Sketch({ x: 3, y: 2, z: 2 }, [MOSS_FEET])
    .fill(box(p(0, 0, 0), p(3, 1, 2)))
    .fill(box(p(1, 1, 1), p(2, 2, 2)))
    .cubes(),
);

/** Every starter part. */
export const STARTER_PARTS: readonly StarterPart[] = [
  fourLeggedTorso,
  uprightTorso,
  fishTorso,
  roundHead,
  snoutHead,
  wideHead,
  pawLeg,
  stoutLeg,
  pawArm,
  mittenArm,
  bushyTail,
  puffTail,
  pointedEar,
  roundEar,
  sideFin,
  fanFin,
  roundEye,
  beadEye,
  buttonNose,
  pinkNose,
  smile,
  openMouth,
  mosslingTorso,
  mosslingHead,
  mosslingFoot,
];
