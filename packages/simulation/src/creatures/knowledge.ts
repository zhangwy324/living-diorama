// What a creature knows of the world (ADR 0018 §10, §16 and amendments): places it has seen that
// offer an affordance it remembers, and the cells of a coarse grid it has visited recently.
// Plain data, saved with the creature. Perception fills it from PR 4a; this file holds only the
// shape and the bounded inserts.

/** Side of the coarse exploration grid's cells, in metres (ADR 0018 amendments, §11). */
export const KNOWLEDGE_CELL_SIZE = 8;
/** Recently visited grid cells a creature keeps. A starting value, to tune. */
export const RECENT_CELL_LIMIT = 8;

/** A prop or structure placement the creature has seen. */
export interface KnownPlace {
  placementId: string;
  /** Tick it was last seen (or touched). */
  lastSeenTick: number;
}

/** A cell of the coarse grid, by integer index: world x and z divided by the cell size, floored. */
export interface GridCell {
  x: number;
  z: number;
}

export interface VisitedCell extends GridCell {
  /** Tick the creature was last in the cell. */
  tick: number;
}

export interface CreatureKnowledge {
  /**
   * Per affordance ID, the places offering it, in the order first seen. At most the affordance
   * entry's `remember` cap; an affordance without one is not remembered.
   */
  places: Record<string, KnownPlace[]>;
  /** Grid cells visited recently, most recent last, at most `RECENT_CELL_LIMIT`. */
  recentCells: VisitedCell[];
}

export function emptyKnowledge(): CreatureKnowledge {
  return { places: {}, recentCells: [] };
}

/** The coarse grid cell holding world point (x, z). */
export function gridCellAt(x: number, z: number): GridCell {
  return { x: Math.floor(x / KNOWLEDGE_CELL_SIZE), z: Math.floor(z / KNOWLEDGE_CELL_SIZE) };
}

/**
 * Remembers seeing `placementId`, which offers `affordanceId`, at `tick`. A known place gets its
 * tick updated. A new one is added, and if that takes the list over `cap` the place seen longest
 * ago is forgotten (the earliest in the list on a tie). With no cap nothing is remembered.
 * Returns whether the place is now known.
 */
export function rememberPlace(
  knowledge: CreatureKnowledge,
  affordanceId: string,
  placementId: string,
  tick: number,
  cap: number | undefined,
): boolean {
  if (cap === undefined || cap < 1) return false;
  const places = (knowledge.places[affordanceId] ??= []);
  const known = places.find((p) => p.placementId === placementId);
  if (known) {
    known.lastSeenTick = tick;
    return true;
  }
  places.push({ placementId, lastSeenTick: tick });
  while (places.length > cap) {
    let oldest = 0;
    let oldestTick = Infinity;
    places.forEach((p, k) => {
      if (p.lastSeenTick < oldestTick) [oldest, oldestTick] = [k, p.lastSeenTick];
    });
    places.splice(oldest, 1);
  }
  return true;
}

/**
 * Records being in `cell` at `tick`: the cell moves to the end of the recent list with the new
 * tick, and the list keeps its `RECENT_CELL_LIMIT` most recent cells.
 */
export function visitCell(knowledge: CreatureKnowledge, cell: GridCell, tick: number): void {
  const { recentCells } = knowledge;
  const index = recentCells.findIndex((c) => c.x === cell.x && c.z === cell.z);
  if (index >= 0) recentCells.splice(index, 1);
  recentCells.push({ x: cell.x, z: cell.z, tick });
  if (recentCells.length > RECENT_CELL_LIMIT) {
    recentCells.splice(0, recentCells.length - RECENT_CELL_LIMIT);
  }
}

/** A deep copy, for observations and snapshots. */
export function copyKnowledge(knowledge: CreatureKnowledge): CreatureKnowledge {
  return {
    places: Object.fromEntries(
      Object.entries(knowledge.places).map(([id, places]) => [id, places.map((p) => ({ ...p }))]),
    ),
    recentCells: knowledge.recentCells.map((c) => ({ ...c })),
  };
}
