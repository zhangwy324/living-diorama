import type { RegionPosition } from "@living-diorama/content-schema";
import type { ReachableCells } from "../navigation/pathfinder";
import type { RegionMask } from "../navigation/walkability";
import type { PlaceView } from "./contracts";

// Where a creature stands to use a place (ADR 0018 §11, §13 and amendments): at its own angle
// around the place, just clear of what the place blocks, falling back to the nearest walkable
// point it can reach. Shared by eating now and sleeping later.

/** Clearance between the creature's body and what the place blocks, in metres. */
export const SPOT_GAP = 0.3;
/** How far from its preferred spot the fallback looks for a walkable point, in metres. */
export const SPOT_SEARCH_RADIUS = 1.5;

export interface SpotQuery {
  place: PlaceView;
  /** The creature's body radius. */
  radius: number;
  /** The creature's own angle (`CreatureState.spotAngle`). */
  angle: number;
  masks: ReadonlyMap<string, RegionMask>;
  /** Walkable cells the creature can reach, per region, in cell order. */
  reachable: ReachableCells;
}

interface Candidate {
  position: RegionPosition;
  /** From the preferred point. */
  distance: number;
  /** Height difference between the surface there and the place. */
  rise: number;
}

/** The closer candidate, then the one nearer the place's height; the first on a full tie. */
const better = (a: Candidate | undefined, b: Candidate): Candidate =>
  !a || b.distance < a.distance || (b.distance === a.distance && b.rise < a.rise) ? b : a;

/** Whether sorted `cells` holds `cell`. */
function holds(cells: readonly number[], cell: number): boolean {
  let lo = 0;
  let hi = cells.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = cells[mid] ?? Infinity;
    if (value === cell) return true;
    if (value < cell) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/**
 * The creature's spot at a place: the point at its angle, `blockRadius + radius + SPOT_GAP` from
 * the place's centre, if a reachable walkable cell holds it; otherwise the centre of the nearest
 * reachable walkable cell within `SPOT_SEARCH_RADIUS` of that point. Where regions overlap (a
 * bridge deck over a river), the one whose surface is closest to the place's height wins.
 */
export function findSpot({
  place,
  radius,
  angle,
  masks,
  reachable,
}: SpotQuery): RegionPosition | undefined {
  const distance = place.blockRadius + radius + SPOT_GAP;
  const px = place.x + Math.sin(angle) * distance;
  const pz = place.z + Math.cos(angle) * distance;
  let best: Candidate | undefined;
  for (const [regionId, cells] of reachable) {
    const mask = masks.get(regionId);
    if (!mask) continue;
    const cell = mask.cellAt(px, pz);
    if (cell !== -1 && holds(cells, cell)) {
      best = better(best, {
        position: { regionId, x: px, z: pz },
        distance: 0,
        rise: Math.abs(mask.height(cell) - place.y),
      });
    }
  }
  if (best) return best.position;

  for (const [regionId, cells] of reachable) {
    const mask = masks.get(regionId);
    if (!mask || cells.length === 0) continue;
    const reach = Math.ceil(SPOT_SEARCH_RADIUS / mask.cellSize);
    const ci = Math.floor((px - mask.originX) / mask.cellSize) - mask.i0;
    const cj = Math.floor((pz - mask.originZ) / mask.cellSize) - mask.j0;
    for (let j = Math.max(0, cj - reach); j <= Math.min(mask.rows - 1, cj + reach); j++) {
      for (let i = Math.max(0, ci - reach); i <= Math.min(mask.columns - 1, ci + reach); i++) {
        const cell = j * mask.columns + i;
        if (!holds(cells, cell)) continue;
        const { x, z } = mask.center(cell);
        const d = Math.hypot(x - px, z - pz);
        if (d <= SPOT_SEARCH_RADIUS) {
          best = better(best, {
            position: { regionId, x, z },
            distance: d,
            rise: Math.abs(mask.height(cell) - place.y),
          });
        }
      }
    }
  }
  return best?.position;
}
