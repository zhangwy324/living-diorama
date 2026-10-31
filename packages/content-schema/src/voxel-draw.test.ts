import { describe, expect, it } from "vitest";
import {
  DRAWING_GRID,
  MAX_PART_CUBES,
  PartDrawingSchema,
  VoxelAssemblySchema,
  VoxelPartSchema,
  decodeVoxels,
  fitDrawnPart,
  voxelIndex,
  voxelizeDrawing,
  type DrawnVoxels,
  type PartDrawing,
  type PartDrawingInput,
  type VoxelPart,
  type VoxelPartInput,
} from "./index";

/**
 * A drawing from rows of text, `.` empty and a digit a colour index, its top-left pixel at
 * (`left`, `top`) of the grid.
 */
function drawing(
  rows: readonly string[],
  options: Partial<PartDrawingInput> & { left?: number; top?: number } = {},
): PartDrawing {
  const { left = 3, top = 2, ...rest } = options;
  const pixels = new Array<number>(DRAWING_GRID * DRAWING_GRID).fill(0);
  rows.forEach((row, y) =>
    [...row].forEach((char, x) => {
      if (char !== ".") pixels[(top + y) * DRAWING_GRID + left + x] = Number(char);
    }),
  );
  return PartDrawingSchema.parse({
    pixels,
    palette: ["#aa8855", "#334455", "#ffffff"],
    view: "side",
    rule: "flat",
    step: 0.025,
    ...rest,
  });
}

/** A filled disc `2r` pixels across. */
const disc = (r: number) =>
  Array.from({ length: 2 * r }, (_, y) =>
    Array.from({ length: 2 * r }, (_, x) =>
      (x + 0.5 - r) ** 2 + (y + 0.5 - r) ** 2 <= r * r ? "1" : ".",
    ).join(""),
  );

/** A bar `width` pixels wide and `height` tall. */
const bar = (width: number, height: number) =>
  Array.from({ length: height }, () => "1".repeat(width));

const voxels = (input: PartDrawing): DrawnVoxels => {
  const drawn = voxelizeDrawing(input);
  if (!drawn) throw new Error("Nothing drawn");
  return drawn;
};

const at = (drawn: DrawnVoxels, x: number, y: number, z: number) =>
  drawn.grid[voxelIndex(drawn.size, x, y, z)] ?? 0;

/** Filled cubes along the depth axis at canvas pixel (x, y) of the cropped drawing. */
function depthAt(drawn: DrawnVoxels, view: "side" | "front", x: number, y: number): number {
  const cy = drawn.size.y - 1 - y;
  let count = 0;
  if (view === "side") {
    for (let z = 0; z < drawn.size.z; z++) if (at(drawn, x, cy, z)) count++;
  } else {
    for (let d = 0; d < drawn.size.x; d++) if (at(drawn, d, cy, drawn.size.z - 1 - x)) count++;
  }
  return count;
}

/** Whether the cubes are their own mirror image across the depth axis's middle plane. */
function isSymmetric(drawn: DrawnVoxels, axis: "x" | "z"): boolean {
  const { size } = drawn;
  for (let z = 0; z < size.z; z++) {
    for (let y = 0; y < size.y; y++) {
      for (let x = 0; x < size.x; x++) {
        const [mx, mz] = axis === "z" ? [x, size.z - 1 - z] : [size.x - 1 - x, z];
        if (at(drawn, x, y, z) !== at(drawn, mx, y, mz)) return false;
      }
    }
  }
  return true;
}

describe("voxelizeDrawing", () => {
  it("makes nothing of an empty drawing", () => {
    expect(voxelizeDrawing(drawing([]))).toBeUndefined();
  });

  it("crops the part to the painted pixels", () => {
    const drawn = voxels(drawing(["..1..", ".....", "...1."], { left: 10, top: 20 }));
    expect(drawn.size).toEqual({ x: 2, y: 3, z: 1 });
    expect(drawn.origin).toEqual({ left: 12, top: 20 });
  });

  it("maps a side view's canvas x to +X, canvas y down to −Y and depth to Z", () => {
    // An L: the top-left pixel is colour 2, the bottom-right colour 3.
    const drawn = voxels(drawing(["2..", "1..", "113"]));
    expect(drawn.size).toEqual({ x: 3, y: 3, z: 1 });
    expect(drawn.colors).toEqual(["#aa8855", "#334455", "#ffffff"]);
    expect(at(drawn, 0, 2, 0)).toBe(2);
    expect(at(drawn, 2, 0, 0)).toBe(3);
    expect(at(drawn, 2, 2, 0)).toBe(0);
  });

  it("maps a front view's canvas x to −Z, canvas y down to −Y and depth to X", () => {
    const drawn = voxels(drawing(["2..", "1..", "113"], { view: "front", flatThickness: 2 }));
    expect(drawn.size).toEqual({ x: 2, y: 3, z: 3 });
    // The canvas's left is the creature's right, +Z.
    expect(at(drawn, 0, 2, 2)).toBe(2);
    expect(at(drawn, 1, 2, 2)).toBe(2);
    expect(at(drawn, 0, 0, 0)).toBe(3);
    expect(at(drawn, 0, 2, 0)).toBe(0);
  });

  it("keeps only the colours used, in the palette's order", () => {
    const drawn = voxels(drawing(["3.3", ".1."]));
    expect(drawn.colors).toEqual(["#aa8855", "#ffffff"]);
    expect(at(drawn, 0, 1, 0)).toBe(2);
    expect(at(drawn, 1, 0, 0)).toBe(1);
  });

  describe("flat", () => {
    it.each([1, 2] as const)("is %i cubes deep everywhere", (flatThickness) => {
      const drawn = voxels(drawing(disc(5), { flatThickness }));
      expect(drawn.size).toEqual({ x: 10, y: 10, z: flatThickness });
      expect(depthAt(drawn, "side", 5, 5)).toBe(flatThickness);
      expect(depthAt(drawn, "side", 0, 4)).toBe(flatThickness);
    });
  });

  describe("puffy", () => {
    it("is deepest in the middle and shallow at the edge, a disc about a ball", () => {
      const drawn = voxels(drawing(disc(6), { rule: "puffy" }));
      expect(drawn.size.x).toBe(12);
      expect(drawn.size.z).toBeGreaterThanOrEqual(10);
      expect(drawn.size.z).toBeLessThanOrEqual(12);
      expect(depthAt(drawn, "side", 5, 5)).toBe(drawn.size.z);
      expect(depthAt(drawn, "side", 0, 5)).toBeLessThan(drawn.size.z / 2);
      // Deeper towards the middle along a row.
      const row = [0, 1, 2, 3, 4, 5].map((x) => depthAt(drawn, "side", x, 5));
      expect(row).toEqual([...row].sort((a, b) => a - b));
    });

    it("scales its depth by the chubby factor", () => {
      const plain = voxels(drawing(disc(4), { rule: "puffy" }));
      const chubby = voxels(drawing(disc(4), { rule: "puffy", chubby: 2 }));
      const thin = voxels(drawing(disc(4), { rule: "puffy", chubby: 0.5 }));
      expect(chubby.size.z).toBeGreaterThanOrEqual(2 * plain.size.z - 1);
      expect(thin.size.z).toBeLessThan(plain.size.z);
    });

    it("caps the depth at the part's cap", () => {
      const drawn = voxels(drawing(disc(16), { rule: "puffy", chubby: 2, left: 0, top: 0 }));
      expect(drawn.size).toEqual({ x: 32, y: 32, z: MAX_PART_CUBES });
    });

    it("is a mirror image about the middle plane, in either view", () => {
      const blob = ["..111...", ".11111..", "1111111.", "11111111", ".111111.", "..11...."];
      expect(isSymmetric(voxels(drawing(blob, { rule: "puffy" })), "z")).toBe(true);
      expect(isSymmetric(voxels(drawing(blob, { rule: "puffy", view: "front" })), "x")).toBe(true);
    });
  });

  describe("tube", () => {
    it.each([1, 2, 3, 4, 5, 6])("makes a bar %i pixels wide as deep as it is wide", (width) => {
      const drawn = voxels(drawing(bar(width, 10), { rule: "tube" }));
      expect(drawn.size).toEqual({ x: width, y: 10, z: width });
      for (let x = 0; x < width; x++) expect(depthAt(drawn, "side", x, 4)).toBe(width);
      // The ends too, not rounded off.
      expect(depthAt(drawn, "side", 0, 0)).toBe(width);
    });

    it("keeps a thin limb thin beside a thick body", () => {
      // A 9-wide body with a 3-wide leg below it.
      const rows = [...bar(9, 9), ...Array.from({ length: 8 }, () => "...111...")];
      const drawn = voxels(drawing(rows, { rule: "tube" }));
      expect(depthAt(drawn, "side", 4, 4)).toBe(9);
      expect(depthAt(drawn, "side", 4, 14)).toBe(3);
      expect(isSymmetric(drawn, "z")).toBe(true);
    });

    it("draws in top view with canvas y down along +Z and depth along Y", () => {
      // An L seen from above: the top-left pixel colour 2, the bottom-right colour 3.
      const drawn = voxels(drawing(["2..", "1..", "113"], { view: "top", flatThickness: 2 }));
      expect(drawn.size).toEqual({ x: 3, y: 2, z: 3 });
      expect(at(drawn, 0, 0, 0)).toBe(2);
      expect(at(drawn, 0, 1, 0)).toBe(2);
      expect(at(drawn, 2, 0, 2)).toBe(3);
      expect(at(drawn, 2, 0, 0)).toBe(0);
      const tube = voxels(drawing(bar(4, 6), { rule: "tube", view: "top" }));
      expect(tube.size).toEqual({ x: 4, y: 4, z: 6 });
    });

    it("draws in front view along X", () => {
      const drawn = voxels(drawing(bar(3, 6), { rule: "tube", view: "front" }));
      expect(drawn.size).toEqual({ x: 3, y: 6, z: 3 });
      expect(depthAt(drawn, "front", 1, 2)).toBe(3);
    });
  });

  it("gives the same cubes for the same drawing", () => {
    const input = drawing(disc(7), { rule: "puffy", chubby: 1.3 });
    const a = voxels(input);
    const b = voxels(JSON.parse(JSON.stringify(input)) as PartDrawing);
    expect(b).toEqual(a);
  });
});

// Base parts built here, like the starter parts but smaller: content-schema imports no content
// pack.

function part(input: VoxelPartInput): VoxelPart {
  return VoxelPartSchema.parse(input);
}

/** A solid box torso with two mirrored pairs of leg sockets, a neck and a tail base. */
const torso = part({
  type: "test:torso",
  size: { x: 9, y: 6, z: 7 },
  step: 0.05,
  colors: ["#7fae5a"],
  voxels: [9 * 6 * 7, 1],
  attach: { x: 4.5, y: 0, z: 3.5 },
  sockets: [
    { id: "front-left", type: "test:hip", position: { x: 6, y: 1, z: 2.5 } },
    {
      id: "front-right",
      type: "test:hip",
      position: { x: 6, y: 1, z: 4.5 },
      mirrors: "front-left",
    },
    { id: "back-left", type: "test:hip", position: { x: 3, y: 1, z: 2.5 } },
    { id: "back-right", type: "test:hip", position: { x: 3, y: 1, z: 4.5 }, mirrors: "back-left" },
    { id: "neck", type: "test:neck", position: { x: 6, y: 5, z: 3.5 } },
  ],
});

/** A head whose eye sockets lie half a cube inside its face: they fit finer eyes only. */
const head = part({
  type: "test:head",
  size: { x: 6, y: 6, z: 7 },
  step: 0.05,
  colors: ["#7fae5a"],
  voxels: [6 * 6 * 7, 1],
  attach: { x: 3, y: 0, z: 3.5 },
  sockets: [
    { id: "left-eye", type: "test:eye-mount", position: { x: 5.5, y: 4, z: 2 } },
    {
      id: "right-eye",
      type: "test:eye-mount",
      position: { x: 5.5, y: 4, z: 5 },
      mirrors: "left-eye",
    },
  ],
});

const leg = (step: 0.05 | 0.0125) =>
  part({
    type: "test:leg",
    size: { x: 2, y: 3, z: 2 },
    step,
    colors: ["#334455"],
    voxels: [12, 1],
    attach: { x: 1, y: 3, z: 1 },
  });

const eye = part({
  type: "test:eye",
  size: { x: 2, y: 2, z: 2 },
  step: 0.025,
  colors: ["#000000"],
  voxels: [8, 1],
  attach: { x: 0, y: 1, z: 1 },
});

/** Whether an assembly of `root` with `child` on each of its sockets is valid. */
function holds(root: VoxelPart, child: VoxelPart) {
  return VoxelAssemblySchema.safeParse({
    parts: { root, child },
    instances: [
      { id: "root", part: "root" },
      ...root.sockets.map((socket) => ({
        id: `on-${socket.id}`,
        part: "child",
        parent: { instance: "root", socket: socket.id },
        mirrored: socket.mirrors !== undefined,
      })),
    ],
  });
}

const fitted = (drawn: DrawnVoxels, base: VoxelPart): VoxelPart => {
  const fit = fitDrawnPart(drawn, base);
  for (const socket of Object.values(fit.sockets)) expect(socket.shallow).toBe(false);
  expect(fit.attachOnCubes).toBe(true);
  return fit.part;
};

const blob = [
  "....11111....",
  "..111111111..",
  ".11111111111.",
  "1111111111111",
  "1111111111111",
  "1111111111111",
  ".11111111111.",
  "..111111111..",
];

describe("fitDrawnPart", () => {
  it.each(["puffy", "tube"] as const)(
    "gives a %s torso the base's sockets, buried deep enough for any leg",
    (rule) => {
      const body = fitted(voxels(drawing(blob, { rule, step: 0.05 })), torso);
      expect(body.type).toBe("test:torso");
      expect(body.source).toBeUndefined();
      expect(body.sockets.map((socket) => [socket.id, socket.type, socket.mirrors])).toEqual(
        torso.sockets.map((socket) => [socket.id, socket.type, socket.mirrors]),
      );
      expect(holds(body, leg(0.05)).success).toBe(true);
      expect(holds(body, leg(0.0125)).success).toBe(true);
    },
  );

  it("keeps a mirror pair mirrored about the middle plane, off it as on the base", () => {
    const body = fitted(voxels(drawing(blob, { rule: "puffy", step: 0.05 })), torso);
    const position = (id: string) => body.sockets.find((socket) => socket.id === id)!.position;
    for (const [left, right] of [
      ["front-left", "front-right"],
      ["back-left", "back-right"],
    ] as const) {
      expect(position(right)).toEqual({ ...position(left), z: body.size.z - position(left).z });
      expect(position(left).z).toBeLessThan(body.size.z / 2);
    }
    // The neck stays on the middle plane, the front legs in front of the back ones.
    expect(position("neck").z).toBe(body.size.z / 2);
    expect(position("front-left").x).toBeGreaterThan(position("back-left").x);
    expect(position("neck").y).toBeGreaterThan(position("front-left").y);
  });

  it("puts the attach point on a filled cube", () => {
    const body = fitted(voxels(drawing(blob, { rule: "puffy", step: 0.05 })), torso);
    // Bottom middle, as on the base: the blob's bottom row is filled there.
    expect(body.attach.y).toBe(0);
    expect(Math.abs(body.attach.x - body.size.x / 2)).toBeLessThanOrEqual(0.5);
    expect(body.attach.z).toBe(body.size.z / 2);
  });

  it("moves an attach point off empty space onto the drawing", () => {
    // A leg leaning forward: its top middle, where the base's attach point scales to, is empty.
    const rows = ["11....", ".11...", "..11..", "...11.", "....11"];
    const drawn = voxels(drawing(rows, { rule: "flat", flatThickness: 2, step: 0.05 }));
    const limb = fitted(drawn, leg(0.05));
    const grid = decodeVoxels(limb.voxels, limb.size);
    // The cubes whose corners or sides it lies on, along each axis.
    const near = (value: number) =>
      Number.isInteger(value) ? [value - 1, value] : [Math.floor(value)];
    const { x, y, z } = limb.attach;
    const touching = near(x).some((cx) =>
      near(y).some((cy) =>
        near(z).some(
          (cz) =>
            cx >= 0 &&
            cy >= 0 &&
            cz >= 0 &&
            cx < limb.size.x &&
            cy < limb.size.y &&
            cz < limb.size.z &&
            grid[voxelIndex(limb.size, cx, cy, cz)] !== 0,
        ),
      ),
    );
    expect(touching).toBe(true);
    // At the top, where the base's is.
    expect(y).toBeGreaterThanOrEqual(limb.size.y - 1);
  });

  it("aims a socket for its base socket's depth: a face's eye socket half a cube in", () => {
    const fit = fitDrawnPart(voxels(drawing(blob, { rule: "puffy", step: 0.05 })), head);
    expect(fit.sockets["left-eye"]).toEqual({ depth: "finer", target: "finer", shallow: false });
    expect(fit.sockets["right-eye"]).toEqual({ depth: "finer", target: "finer", shallow: false });
    const face = fit.part;
    // A finer eye fits there; a child at the face's own step would need it a whole cube deep.
    expect(holds(face, eye).success).toBe(true);
    expect(holds(face, leg(0.05)).success).toBe(false);
    // Near the face, as on the base: half a cube from the front.
    const front = face.sockets.find((socket) => socket.id === "left-eye")!.position;
    expect(front.x).toBeGreaterThanOrEqual(face.size.x - 3);
    const left = face.sockets.find((socket) => socket.id === "left-eye")!.position;
    const right = face.sockets.find((socket) => socket.id === "right-eye")!.position;
    expect(right).toEqual({ ...left, z: face.size.z - left.z });
  });

  it("buries sockets at a drawn step finer than the base's", () => {
    const body = fitted(voxels(drawing(blob, { rule: "puffy", step: 0.025 })), torso);
    expect(body.step).toBe(0.025);
    expect(holds(body, leg(0.05)).success).toBe(true);
  });

  it("lists the sockets with no room as shallow, placed as deep as the drawing allows", () => {
    // One cube deep: a socket on the middle plane is half a cube deep at most.
    const flat = fitDrawnPart(voxels(drawing(blob, { rule: "flat", step: 0.05 })), torso);
    expect(Object.values(flat.sockets)).toEqual(
      torso.sockets.map(() => ({ depth: "finer", target: "own", shallow: true })),
    );
    expect(VoxelPartSchema.safeParse(flat.part).success).toBe(true);
    for (const socket of flat.part.sockets) expect(socket.position.z).toBe(0.5);
    // A finer child fits there.
    expect(holds(flat.part, leg(0.0125)).success).toBe(true);
    expect(holds(flat.part, leg(0.05)).success).toBe(false);
    // The pairs stay mirrored.
    const position = (id: string) => flat.part.sockets.find((socket) => socket.id === id)!.position;
    expect(position("front-right")).toEqual(position("front-left"));
  });

  it("reaches a shallow target on a stroke too thin for a whole cube", () => {
    // A one-pixel-wide flat stroke, two cubes deep.
    const rows = ["1", "1", "1", "1"];
    const fit = fitDrawnPart(
      voxels(drawing(rows, { rule: "flat", flatThickness: 2, step: 0.05 })),
      head,
    );
    expect(Object.values(fit.sockets).map((socket) => socket.depth)).toEqual(["finer", "finer"]);
    expect(Object.values(fit.sockets).some((socket) => socket.shallow)).toBe(false);
    expect(VoxelPartSchema.safeParse(fit.part).success).toBe(true);
  });

  it("puts a socket only on the cubes at the finest step, which has no finer child", () => {
    const flat = fitDrawnPart(voxels(drawing(blob, { rule: "flat", step: 0.0125 })), torso);
    expect(Object.values(flat.sockets)).toEqual(
      torso.sockets.map(() => ({ depth: "touching", target: "own", shallow: true })),
    );
    expect(VoxelPartSchema.safeParse(flat.part).success).toBe(true);
  });

  it("fits a leaf part on a flat drawing one cube deep", () => {
    const ear = fitted(voxels(drawing(["11", "111", "111"], { step: 0.0125 })), eye);
    expect(ear.size).toEqual({ x: 3, y: 3, z: 1 });
    expect(ear.sockets).toEqual([]);
    expect(VoxelPartSchema.safeParse(ear).success).toBe(true);
  });

  it("places the sockets of an asymmetric front-view drawing each on its own", () => {
    // Two blocks, upper on the canvas's left (the creature's right), lower on its right: the
    // mirror image of any point on one block is off both, so the pair can't mirror.
    const rows = ["11....", "11....", "......", "....11", "....11"];
    const fit = fitDrawnPart(
      voxels(drawing(rows, { view: "front", flatThickness: 2, step: 0.05 })),
      head,
    );
    expect(Object.values(fit.sockets).some((socket) => socket.shallow)).toBe(false);
    const left = fit.part.sockets.find((socket) => socket.id === "left-eye")!.position;
    const right = fit.part.sockets.find((socket) => socket.id === "right-eye")!.position;
    expect(right).not.toEqual({ ...left, z: fit.part.size.z - left.z });
    // Each on its own side's block: the left eye at small z (the canvas's right).
    expect(left.z).toBeLessThan(fit.part.size.z / 2);
    expect(right.z).toBeGreaterThan(fit.part.size.z / 2);
    expect(holds(fit.part, eye).success).toBe(true);
  });

  describe("with points the player placed", () => {
    const drawn = () => voxels(drawing(blob, { rule: "puffy", step: 0.05 }));

    it("keeps them, snapped to half cubes, and says how deep they are", () => {
      const fit = fitDrawnPart(drawn(), torso, {
        attach: { x: 0.3, y: 6.2, z: 0.1 },
        sockets: { neck: { x: 6.4, y: 4.1, z: 6 } },
      });
      expect(fit.part.attach).toEqual({ x: 0.5, y: 6, z: 0 });
      expect(fit.attachOnCubes).toBe(false);
      const neck = fit.part.sockets.find((socket) => socket.id === "neck")!;
      expect(neck.position).toEqual({ x: 6.5, y: 4, z: 6 });
      expect(fit.sockets.neck?.depth).toBe("own");
    });

    it("mirrors the socket of a pair whose partner was placed", () => {
      const placed = { x: 3, y: 2, z: 1 };
      const fit = fitDrawnPart(drawn(), torso, { sockets: { "front-right": placed } });
      const position = (id: string) =>
        fit.part.sockets.find((socket) => socket.id === id)!.position;
      expect(position("front-right")).toEqual(placed);
      expect(position("front-left")).toEqual({ ...placed, z: fit.part.size.z - 1 });
    });

    it("reports a socket off the cubes as loose", () => {
      const fit = fitDrawnPart(drawn(), torso, { sockets: { neck: { x: 0, y: 8, z: 0 } } });
      expect(fit.sockets.neck).toMatchObject({ depth: "loose", shallow: true });
    });
  });

  it("gives the same part for the same drawing and base", () => {
    const drawn = voxels(drawing(blob, { rule: "puffy", step: 0.05 }));
    expect(fitDrawnPart(drawn, torso)).toEqual(fitDrawnPart(drawn, torso));
  });
});
