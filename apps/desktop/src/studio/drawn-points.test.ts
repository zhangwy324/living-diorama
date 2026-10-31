import {
  DRAWING_GRID,
  PART_DRAWING_VIEWS,
  PartDrawingSchema,
  VoxelPartSchema,
  fitDrawnPart,
  voxelizeDrawing,
  type DrawnVoxels,
  type PartDrawingView,
  type VoxelPart,
} from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import {
  NO_PLACED_POINTS,
  dropDepths,
  dropPoint,
  overridesFor,
  partnerOf,
  placedFrom,
  silhouette,
  toCanvas,
  toPart,
} from "./drawn-points";

/** A solid torso with a mirrored pair of hip sockets and a neck, like the starter's. */
const torso: VoxelPart = VoxelPartSchema.parse({
  type: "test:torso",
  size: { x: 9, y: 6, z: 7 },
  step: 0.05,
  colors: ["#7fae5a"],
  voxels: [9 * 6 * 7, 1],
  attach: { x: 4.5, y: 0, z: 3.5 },
  sockets: [
    { id: "left-hip", type: "test:hip", position: { x: 6, y: 1, z: 2.5 } },
    { id: "right-hip", type: "test:hip", position: { x: 6, y: 1, z: 4.5 }, mirrors: "left-hip" },
    { id: "neck", type: "test:neck", position: { x: 6, y: 5, z: 3.5 } },
  ],
});

/** Rows of `1`s from the canvas's (left, top). */
function drawn(
  lines: readonly string[],
  options: {
    view?: PartDrawingView;
    rule?: "puffy" | "tube" | "flat";
    left?: number;
    top?: number;
  } = {},
): DrawnVoxels {
  const { view = "side", rule = "puffy", left = 4, top = 6 } = options;
  const pixels = new Array<number>(DRAWING_GRID * DRAWING_GRID).fill(0);
  lines.forEach((line, y) =>
    [...line].forEach((char, x) => {
      if (char === "1") pixels[(top + y) * DRAWING_GRID + left + x] = 1;
    }),
  );
  const result = voxelizeDrawing(
    PartDrawingSchema.parse({ pixels, palette: ["#7fae5a"], view, rule, step: 0.05 }),
  );
  if (!result) throw new Error("Nothing drawn");
  return result;
}

const block = (width: number, height: number) =>
  Array.from({ length: height }, () => "1".repeat(width));

describe("canvas points", () => {
  it.each(PART_DRAWING_VIEWS)("go to the part and back in %s view", (view) => {
    const cubes = drawn(block(12, 8), { view });
    for (const point of [
      { x: 0, y: 0, z: 0 },
      { x: 1.5, y: 2, z: 0.5 },
      { x: cubes.size.x, y: cubes.size.y, z: cubes.size.z },
    ]) {
      expect(toPart(toCanvas(point, cubes, view), cubes, view)).toEqual(point);
    }
  });

  it("put a side view's part where it was drawn: +X right, +Y up, depth from the middle", () => {
    const cubes = drawn(block(12, 8));
    // The cubes' bottom-left-back corner is the drawing's bottom-left, half the depth behind.
    expect(toCanvas({ x: 0, y: 0, z: 0 }, cubes, "side")).toEqual({
      u: 4,
      v: 14,
      d: -cubes.size.z / 2,
    });
    expect(toCanvas({ x: 12, y: 8, z: cubes.size.z / 2 }, cubes, "side")).toEqual({
      u: 16,
      v: 6,
      d: 0,
    });
  });

  it("put a front view's +Z (the creature's right) on the canvas's left", () => {
    const cubes = drawn(block(12, 8), { view: "front" });
    expect(toCanvas({ x: 0, y: 0, z: cubes.size.z }, cubes, "front").u).toBe(4);
    expect(toCanvas({ x: 0, y: 0, z: 0 }, cubes, "front").u).toBe(16);
  });

  it("stay where they were put on the canvas when the crop moves", () => {
    const before = drawn(block(12, 8));
    // More drawn to the left and above: the crop starts elsewhere.
    const after = drawn(block(16, 10), { left: 0, top: 4 });
    const point = { u: 10, v: 9, d: 0.5 };
    expect(toCanvas(toPart(point, before, "side"), before, "side")).toEqual(point);
    expect(toCanvas(toPart(point, after, "side"), after, "side")).toEqual(point);
  });

  it("reopen a saved part with its points where they were saved", () => {
    const cubes = drawn(block(12, 8));
    const fit = fitDrawnPart(cubes, torso);
    const placed = placedFrom(fit.part, cubes, "side");
    const again = fitDrawnPart(cubes, fit.part, overridesFor(placed, cubes, "side"));
    expect(again.part).toEqual(fit.part);
  });
});

describe("dropping a point", () => {
  const cubes = drawn(block(12, 8));
  const fit = fitDrawnPart(cubes, torso);
  const position = (part: VoxelPart, id: string) =>
    part.sockets.find((socket) => socket.id === id)!.position;

  it("knows a socket's mirror pair from either side", () => {
    expect(partnerOf(torso, "left-hip")).toBe("right-hip");
    expect(partnerOf(torso, "right-hip")).toBe("left-hip");
    expect(partnerOf(torso, "neck")).toBeUndefined();
  });

  it("tries depths from where it was to the middle plane", () => {
    expect(dropDepths(0)).toEqual([0]);
    expect(dropDepths(1)).toEqual([1, 0.5, 0]);
    expect(dropDepths(3)).toEqual([3, 2.5, 1.5, 1, 0]);
    expect(dropDepths(-3)).toEqual([-3, -2.5, -1.5, -1, 0]);
  });

  it("keeps the neck where it is dropped, snapped to half pixels, as deep as before", () => {
    const placed = dropPoint({
      drawn: cubes,
      base: torso,
      view: "side",
      placed: NO_PLACED_POINTS,
      fit,
      dragged: { kind: "socket", id: "neck" },
      u: 8.3,
      v: 9.9,
    });
    expect(placed.sockets.neck).toEqual({ u: 8.5, v: 10, d: 0 });
    const after = fitDrawnPart(cubes, torso, overridesFor(placed, cubes, "side"));
    expect(toCanvas(position(after.part, "neck"), cubes, "side")).toMatchObject({ u: 8.5, v: 10 });
    expect(after.sockets.neck?.shallow).toBe(false);
  });

  it("moves a mirror pair together, the partner mirrored across the middle plane", () => {
    const placed = dropPoint({
      drawn: cubes,
      base: torso,
      view: "side",
      placed: { sockets: { "left-hip": { u: 1, v: 1, d: 0 } } },
      fit,
      dragged: { kind: "socket", id: "right-hip" },
      u: 7,
      v: 12,
    });
    // The partner's own placed point goes, so the fit mirrors it.
    expect(Object.keys(placed.sockets)).toEqual(["right-hip"]);
    const after = fitDrawnPart(cubes, torso, overridesFor(placed, cubes, "side"));
    const right = position(after.part, "right-hip");
    const left = position(after.part, "left-hip");
    expect(left).toEqual({ ...right, z: after.part.size.z - right.z });
    expect(toCanvas(left, cubes, "side")).toMatchObject({ u: 7, v: 12 });
  });

  it("sinks a socket dropped on a thin place toward the middle until it is deep enough", () => {
    // A tube body 7 cubes deep with a tail one pixel tall, so one cube deep, on the right: on
    // the tail a hip as far off the middle as on the body would be off the cubes, so it sinks.
    const tail = drawn([...block(8, 6), "111111111111"], { rule: "tube" });
    const tailFit = fitDrawnPart(tail, torso);
    const from = toCanvas(position(tailFit.part, "right-hip"), tail, "side");
    expect(Math.abs(from.d)).toBeGreaterThan(0.5);
    const placed = dropPoint({
      drawn: tail,
      base: torso,
      view: "side",
      placed: NO_PLACED_POINTS,
      fit: tailFit,
      dragged: { kind: "socket", id: "right-hip" },
      u: 14.5,
      v: 12.5,
    });
    expect(placed.sockets["right-hip"]).toEqual({ u: 14.5, v: 12.5, d: 0 });
    const after = fitDrawnPart(tail, torso, overridesFor(placed, tail, "side"));
    expect(after.sockets["right-hip"]?.depth).toBe("finer");
  });

  it("keeps the attach point on the cubes", () => {
    const placed = dropPoint({
      drawn: cubes,
      base: torso,
      view: "side",
      placed: NO_PLACED_POINTS,
      fit,
      dragged: { kind: "attach" },
      u: 10,
      v: 14,
    });
    expect(placed.attach).toMatchObject({ u: 10, v: 14 });
    const after = fitDrawnPart(cubes, torso, overridesFor(placed, cubes, "side"));
    expect(after.attachOnCubes).toBe(true);
  });
});

describe("the base part's ghost", () => {
  it("is its silhouette seen from the view, canvas y downward", () => {
    // An L: a column at x 0 three cubes tall, and a foot at the bottom.
    const part = VoxelPartSchema.parse({
      type: "test:leg",
      size: { x: 2, y: 3, z: 1 },
      step: 0.05,
      colors: ["#334455"],
      // x fastest, then y: (0,0) (1,0) | (0,1) | (0,2).
      voxels: [3, 1, 1, 0, 1, 1, 1, 0],
      attach: { x: 0.5, y: 3, z: 0.5 },
    });
    const side = silhouette(part, "side");
    expect(side).toMatchObject({ width: 2, height: 3 });
    expect([...side.cells]).toEqual([1, 0, 1, 0, 1, 1]);
    const front = silhouette(part, "front");
    expect(front).toMatchObject({ width: 1, height: 3 });
    expect([...front.cells]).toEqual([1, 1, 1]);
    const top = silhouette(part, "top");
    expect(top).toMatchObject({ width: 2, height: 1 });
    expect([...top.cells]).toEqual([1, 1]);
  });
});
