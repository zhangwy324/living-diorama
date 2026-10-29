import type { Vec2 } from "@living-diorama/content-schema";

export interface Box2 {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function boxOf(points: readonly Vec2[]): Box2 {
  const box = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
  for (const p of points) {
    box.minX = Math.min(box.minX, p.x);
    box.minZ = Math.min(box.minZ, p.z);
    box.maxX = Math.max(box.maxX, p.x);
    box.maxZ = Math.max(box.maxZ, p.z);
  }
  return box;
}

/** Each edge of a closed polygon as [previous point, point]. */
export function polygonEdges(polygon: readonly Vec2[]): [Vec2, Vec2][] {
  return polygon.map((p, i) => [polygon[(i + polygon.length - 1) % polygon.length] ?? p, p]);
}

/** Consecutive pairs of an open polyline. */
export function polylineSegments(line: readonly Vec2[]): [Vec2, Vec2][] {
  return line.slice(1).map((p, i) => [line[i] ?? p, p]);
}

/** Even-odd test; points exactly on an edge may land either side. */
export function pointInPolygon(x: number, z: number, polygon: readonly Vec2[]): boolean {
  let inside = false;
  // Each edge from the previous point `b` to `a`, without allocating: it runs per grid cell.
  let b = polygon[polygon.length - 1];
  for (const a of polygon) {
    if (b && a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
    b = a;
  }
  return inside;
}

/**
 * Where the polygon's edges cross the line at `z`: the x values `pointInPolygon` compares
 * against, computed the same way, so `insideAt` on them gives exactly its answer for every x on
 * that line. A scanline: one row's crossings serve every cell in the row.
 */
export function polygonCrossings(polygon: readonly Vec2[], z: number): number[] {
  const crossings: number[] = [];
  let b = polygon[polygon.length - 1];
  for (const a of polygon) {
    if (b && a.z > z !== b.z > z) crossings.push(((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x);
    b = a;
  }
  return crossings;
}

/** Whether x is inside the polygon, given its `polygonCrossings` on the line through the point. */
export function insideAt(crossings: readonly number[], x: number): boolean {
  let inside = false;
  for (const c of crossings) if (x < c) inside = !inside;
  return inside;
}

/** Closest point on segment a–b to p, as the parameter t in [0, 1] and the distance. */
export function projectOnSegment(
  px: number,
  pz: number,
  a: Vec2,
  b: Vec2,
): { t: number; distance: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const lengthSq = dx * dx + dz * dz;
  const t =
    lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (pz - a.z) * dz) / lengthSq));
  return { t, distance: Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz)) };
}

export function distanceToPolyline(x: number, z: number, line: readonly Vec2[]): number {
  let best = Infinity;
  for (const [a, b] of polylineSegments(line)) {
    best = Math.min(best, projectOnSegment(x, z, a, b).distance);
  }
  return best;
}

export function distanceToPolygonEdge(x: number, z: number, polygon: readonly Vec2[]): number {
  let best = Infinity;
  for (const [a, b] of polygonEdges(polygon)) {
    best = Math.min(best, projectOnSegment(x, z, a, b).distance);
  }
  return best;
}

/** Inside the polygon or within `epsilon` of its edge. */
export function pointInOrOnPolygon(
  x: number,
  z: number,
  polygon: readonly Vec2[],
  epsilon: number,
): boolean {
  return pointInPolygon(x, z, polygon) || distanceToPolygonEdge(x, z, polygon) <= epsilon;
}

/** Positive for counter-clockwise winding in (x, z). */
function signedArea(polygon: readonly Vec2[]): number {
  let area = 0;
  for (const [a, b] of polygonEdges(polygon)) area += (a.x - b.x) * (a.z + b.z);
  return area / 2;
}

const cross = (a: Vec2, b: Vec2, c: Vec2) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);

/** Ear-clipping triangulation of a simple polygon. Returns index triples into `polygon`. */
export function triangulate(polygon: readonly Vec2[]): number[] {
  const ring = polygon.map((p, index) => ({ p, index }));
  if (signedArea(polygon) < 0) ring.reverse();
  const triangles: number[] = [];

  let guard = ring.length * ring.length;
  while (ring.length > 3 && guard-- > 0) {
    for (let k = 0; k < ring.length; k++) {
      const [a, b, c] = [-1, 0, 1].map((o) => ring[(k + o + ring.length) % ring.length]);
      if (!a || !b || !c) break;
      // Convex corners only: counter-clockwise means a left turn.
      if (cross(a.p, b.p, c.p) <= 0) continue;
      const blocked = ring.some(
        (v) =>
          v !== a &&
          v !== b &&
          v !== c &&
          cross(a.p, b.p, v.p) > 0 &&
          cross(b.p, c.p, v.p) > 0 &&
          cross(c.p, a.p, v.p) > 0,
      );
      if (blocked) continue;
      triangles.push(a.index, b.index, c.index);
      ring.splice(k, 1);
      break;
    }
  }
  if (ring.length === 3) triangles.push(...ring.map((v) => v.index));
  return triangles;
}
