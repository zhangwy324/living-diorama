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
/** A spot more than this far above or below the place's base is not beside it, in metres. */
export const SPOT_MAX_RISE = 0.75;
/** Angles tried around a place, the creature's own first, then on in equal steps. */
export const SPOT_ANGLES = 8;

export interface SpotQuery {
  place: PlaceView;
  /** The creature's body radius. */
  radius: number;
  /** The creature's own angle (`CreatureState.spotAngle`). */
  angle: number;
  masks: ReadonlyMap<string, RegionMask>;
  /** Walkable cells the creature can reach, per region, in cell order. */
  reachable: ReachableCells;
  /** Whether a spot is free to take; one that isn't is passed over. All are by default. */
  clear?: (position: RegionPosition) => boolean;
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
 * reachable walkable cell within `SPOT_SEARCH_RADIUS` of that point. If neither exists, the same
 * at the angle a step of 2π / `SPOT_ANGLES` on, and so on round the place. Only cells whose
 * surface is within `SPOT_MAX_RISE` of the place's base height count, and where regions overlap
 * (a bridge deck over a path) the one whose surface is nearest that height wins. A spot that
 * isn't `clear` is passed over for the next angle (issue #158).
 */
export function findSpot(query: SpotQuery): RegionPosition | undefined {
  for (let k = 0; k < SPOT_ANGLES; k++) {
    const spot = spotAt(query, query.angle + (2 * Math.PI * k) / SPOT_ANGLES);
    if (spot && (!query.clear || query.clear(spot))) return spot;
  }
  return undefined;
}

function spotAt(
  { place, radius, masks, reachable }: SpotQuery,
  angle: number,
): RegionPosition | undefined {
  const distance = place.blockRadius + radius + SPOT_GAP;
  const px = place.x + Math.sin(angle) * distance;
  const pz = place.z + Math.cos(angle) * distance;
  let best: Candidate | undefined;
  for (const [regionId, cells] of reachable) {
    const mask = masks.get(regionId);
    if (!mask) continue;
    const cell = mask.cellAt(px, pz);
    const rise = cell === -1 ? NaN : Math.abs(mask.height(cell) - place.y);
    if (rise <= SPOT_MAX_RISE && holds(cells, cell)) {
      best = better(best, { position: { regionId, x: px, z: pz }, distance: 0, rise });
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
        const rise = Math.abs(mask.height(cell) - place.y);
        if (d <= SPOT_SEARCH_RADIUS && rise <= SPOT_MAX_RISE) {
          best = better(best, { position: { regionId, x, z }, distance: d, rise });
        }
      }
    }
  }
  return best?.position;
}
