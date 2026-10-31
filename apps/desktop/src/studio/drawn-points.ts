import {
  DRAWING_GRID,
  DRAWN_SOCKET_DEPTHS,
  VIEW_AXES,
  decodeVoxels,
  fitDrawnPart,
  voxelIndex,
  type DrawnPartFit,
  type DrawnPartOverrides,
  type DrawnVoxels,
  type PartDrawingView,
  type VoxelPart,
  type VoxelPoint,
} from "@living-diorama/content-schema";

// A drawn part's attach point and sockets on Draw mode's grid (ADR 0025 §3). The player drags
// them on the canvas, so the points they placed are kept in canvas terms: they stay where they
// were put while the drawing around them changes and its crop moves. Pure.

/**
 * A point on the canvas: `u` across and `v` down, in pixels from the grid's top-left corner, and
 * `d` along the depth, in cubes from the part's middle plane.
 */
export interface CanvasPoint {
  u: number;
  v: number;
  d: number;
}

/** The points the player placed, by what they are; the rest are fitted from the base part. */
export interface PlacedPoints {
  attach?: CanvasPoint;
  sockets: Readonly<Record<string, CanvasPoint>>;
}

export const NO_PLACED_POINTS: PlacedPoints = { sockets: {} };

type Drawn = Pick<DrawnVoxels, "size" | "origin">;

/** Where a point of the drawn part lies on the canvas. */
export function toCanvas(point: VoxelPoint, drawn: Drawn, view: PartDrawingView): CanvasPoint {
  const { canvasX, canvasY, depth } = VIEW_AXES[view];
  const along = ([axis, sign]: typeof canvasX, offset: number) =>
    offset + (sign === 1 ? point[axis] : drawn.size[axis] - point[axis]);
  return {
    u: along(canvasX, drawn.origin.left),
    v: along(canvasY, drawn.origin.top),
    d: point[depth] - drawn.size[depth] / 2,
  };
}

/** The point of the drawn part at a canvas point: `toCanvas` the other way. */
export function toPart(point: CanvasPoint, drawn: Drawn, view: PartDrawingView): VoxelPoint {
  const { canvasX, canvasY, depth } = VIEW_AXES[view];
  const part = { x: 0, y: 0, z: 0 };
  const set = ([axis, sign]: typeof canvasX, value: number, offset: number) => {
    part[axis] = sign === 1 ? value - offset : drawn.size[axis] - (value - offset);
  };
  set(canvasX, point.u, drawn.origin.left);
  set(canvasY, point.v, drawn.origin.top);
  part[depth] = drawn.size[depth] / 2 + point.d;
  return part;
}

/** The placed points as `fitDrawnPart`'s overrides for the drawing as it is now. */
export function overridesFor(
  placed: PlacedPoints,
  drawn: Drawn,
  view: PartDrawingView,
): DrawnPartOverrides {
  return {
    ...(placed.attach && { attach: toPart(placed.attach, drawn, view) }),
    sockets: Object.fromEntries(
      Object.entries(placed.sockets).map(([id, point]) => [id, toPart(point, drawn, view)]),
    ),
  };
}

/**
 * Every point of a part as placed points, e.g. to reopen a saved part with its points where they
 * were saved. `drawn` must be its drawing's cubes.
 */
export function placedFrom(part: VoxelPart, drawn: Drawn, view: PartDrawingView): PlacedPoints {
  return {
    attach: toCanvas(part.attach, drawn, view),
    sockets: Object.fromEntries(
      part.sockets.map((socket) => [socket.id, toCanvas(socket.position, drawn, view)]),
    ),
  };
}

/** The other socket of a socket's mirror pair on `base`, if it has one. */
export function partnerOf(base: VoxelPart, id: string): string | undefined {
  const socket = base.sockets.find((s) => s.id === id);
  if (socket?.mirrors !== undefined) return socket.mirrors;
  return base.sockets.find((s) => s.mirrors === id)?.id;
}

/** What is being dragged: the attach point or a socket. */
export type DraggedPoint = { kind: "attach" } | { kind: "socket"; id: string };

const rank = (depth: (typeof DRAWN_SOCKET_DEPTHS)[number]) => DRAWN_SOCKET_DEPTHS.indexOf(depth);

/** At most this many depths are tried for a dropped point. */
const DROP_DEPTHS = 5;

/**
 * The depths a dropped point is tried at: where it was, then nearer the middle plane, ending on
 * it, so a point carried onto a thinner place sinks to where the drawing is deep enough.
 */
export function dropDepths(d: number): number[] {
  const far = Math.abs(d);
  const steps = Math.min(DROP_DEPTHS - 1, Math.round(far * 2));
  const depths = Array.from(
    { length: steps + 1 },
    (_, i) => Math.round((2 * far * (steps - i)) / Math.max(1, steps)) / 2,
  );
  return [...new Set(depths)].map((depth) => (d < 0 && depth > 0 ? -depth : depth));
}

/**
 * The placed points after the player drops a point at canvas `u`, `v` (ADR 0025 §3): snapped to
 * half pixels on the grid and kept there. Its depth is the first of `dropDepths` from where it was
 * at which it sits as deep as it aims (the attach point on the cubes, a socket at its target
 * depth), else the deepest found. A socket of a mirror pair drops its partner's placed point, so
 * the fit mirrors the partner and the pair moves together.
 *
 * Each depth is tried with the other points held where `fit` has them, so a try costs little.
 */
export function dropPoint(options: {
  drawn: DrawnVoxels;
  base: VoxelPart;
  view: PartDrawingView;
  placed: PlacedPoints;
  /** The fit of the drawing before the drop. */
  fit: DrawnPartFit;
  dragged: DraggedPoint;
  u: number;
  v: number;
}): PlacedPoints {
  const { drawn, base, view, placed, fit, dragged } = options;
  const snap = (value: number) => Math.min(DRAWING_GRID, Math.max(0, Math.round(2 * value) / 2));
  const [u, v] = [snap(options.u), snap(options.v)];
  const partner = dragged.kind === "socket" ? partnerOf(base, dragged.id) : undefined;
  const now =
    dragged.kind === "attach"
      ? fit.part.attach
      : (fit.part.sockets.find((socket) => socket.id === dragged.id)?.position ?? fit.part.attach);
  const from = toCanvas(now, drawn, view);

  const withPoint = (point: CanvasPoint): PlacedPoints => {
    if (dragged.kind === "attach") return { ...placed, attach: point };
    const others = Object.entries(placed.sockets).filter(([id]) => id !== partner);
    return { ...placed, sockets: { ...Object.fromEntries(others), [dragged.id]: point } };
  };

  // The other points held where they are, to score a try without fitting them again.
  const held: DrawnPartOverrides = {
    attach: fit.part.attach,
    sockets: Object.fromEntries(
      fit.part.sockets
        .filter((socket) => socket.id !== partner)
        .map((socket) => [socket.id, socket.position]),
    ),
  };
  const score = (point: CanvasPoint) => {
    const at = toPart(point, drawn, view);
    if (dragged.kind === "attach") {
      return fitDrawnPart(drawn, base, { ...held, attach: at }).attachOnCubes ? 0 : 1;
    }
    const tried = fitDrawnPart(drawn, base, {
      ...held,
      sockets: { ...held.sockets, [dragged.id]: at },
    }).sockets[dragged.id];
    if (!tried) return Infinity;
    return Math.max(0, rank(tried.depth) - rank(tried.target));
  };

  let best: CanvasPoint | undefined;
  let bestScore = Infinity;
  for (const d of dropDepths(from.d)) {
    const point = { u, v, d };
    const scored = score(point);
    if (scored < bestScore) [best, bestScore] = [point, scored];
    if (scored === 0) break;
  }
  return withPoint(best ?? { u, v, d: 0 });
}

/**
 * A part's silhouette seen from a view: `width` × `height` cells in canvas order, 1 where any
 * cube lies behind the cell, one cell a cube of the part. The base part's ghost (ADR 0025 §3).
 */
export function silhouette(
  part: VoxelPart,
  view: PartDrawingView,
): { width: number; height: number; cells: Uint8Array } {
  const { canvasX, canvasY } = VIEW_AXES[view];
  const width = part.size[canvasX[0]];
  const height = part.size[canvasY[0]];
  const cells = new Uint8Array(width * height);
  const grid = decodeVoxels(part.voxels, part.size);
  const cube = { x: 0, y: 0, z: 0 };
  for (cube.z = 0; cube.z < part.size.z; cube.z++) {
    for (cube.y = 0; cube.y < part.size.y; cube.y++) {
      for (cube.x = 0; cube.x < part.size.x; cube.x++) {
        if (!grid[voxelIndex(part.size, cube.x, cube.y, cube.z)]) continue;
        const along = ([axis, sign]: typeof canvasX) =>
          sign === 1 ? cube[axis] : part.size[axis] - 1 - cube[axis];
        cells[along(canvasX) + width * along(canvasY)] = 1;
      }
    }
  }
  return { width, height, cells };
}
