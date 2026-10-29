// What a creature knows of the world (ADR 0018 §10, §16 and amendments): places it has seen that
// offer an affordance it remembers, how its recent attempts to reach them failed, and the cells
// of a coarse grid it has visited recently. Plain data, saved with the creature. Perception
// (`perception.ts`) and actions (through `ActionContext.noteReach`) fill it; this file holds the
// shape, the bounded inserts and the reach back-off.

/** Side of the coarse exploration grid's cells, in metres (ADR 0018 amendments, §11). */
export const KNOWLEDGE_CELL_SIZE = 8;
/** Recently visited grid cells a creature keeps. A starting value, to tune. */
export const RECENT_CELL_LIMIT = 8;

/**
 * Back-off after failing to reach a place (ADR 0018 amendments, §11), in seconds: the first
 * failure of a kind skips the place this long, and each further failure of that kind doubles it.
 * Finding no spot or route at all is the more lasting failure, so it starts longer. Starting
 * values, to tune.
 */
export const REACH_BACKOFF_SECONDS = { no_route: 120, stuck: 30 } as const;
/** The longest back-off, in seconds, so a place is tried again at least once an hour. */
export const MAX_REACH_BACKOFF_SECONDS = 3600;

/** How an attempt to reach a known place ended. */
export type ReachOutcome = "reached" | keyof typeof REACH_BACKOFF_SECONDS;

/** A cell of the coarse grid, by integer index: world x and z divided by the cell size, floored. */
export interface GridCell {
  x: number;
  z: number;
}

/** Failed attempts to reach a known place since it was last reached (ADR 0018 amendments, §11). */
export interface ReachFailures {
  /** Times the creature found no spot or route there. */
  noRoute: number;
  /** Times it got stuck on the way. */
  stuck: number;
  /** Behaviors leave the place out before this tick. */
  retryTick: number;
  /** The grid cell it last failed from, or last saw the place from without being able to reach it. */
  cell: GridCell;
}

/** A prop or structure placement the creature has seen. */
export interface KnownPlace {
  placementId: string;
  /** Tick it was last seen (or touched). */
  lastSeenTick: number;
  /** Present while the creature has failed to reach the place since it last did. */
  failures?: ReachFailures;
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

/** When and where an attempt to reach a place ended. */
export interface ReachAttempt {
  tick: number;
  tickSeconds: number;
  /** The grid cell the creature stood in. */
  cell: GridCell;
}

/**
 * Records how an attempt to reach the known place `placementId`, remembered under
 * `affordanceId`, ended (ADR 0018 amendments, §11). Reaching it clears its failures. A failure
 * counts towards its kind and skips the place until `retryTick`: the kind's
 * `REACH_BACKOFF_SECONDS`, doubled for each earlier failure of that kind, at most
 * `MAX_REACH_BACKOFF_SECONDS`, or later if an earlier back-off ends later. A place the creature
 * doesn't know is left alone.
 */
export function recordReach(
  knowledge: CreatureKnowledge,
  affordanceId: string,
  placementId: string,
  outcome: ReachOutcome,
  { tick, tickSeconds, cell }: ReachAttempt,
): void {
  const place = knowledge.places[affordanceId]?.find((p) => p.placementId === placementId);
  if (!place) return;
  if (outcome === "reached") {
    delete place.failures;
    return;
  }
  const failures = (place.failures ??= { noRoute: 0, stuck: 0, retryTick: tick, cell });
  const count = outcome === "stuck" ? ++failures.stuck : ++failures.noRoute;
  const seconds = Math.min(
    MAX_REACH_BACKOFF_SECONDS,
    REACH_BACKOFF_SECONDS[outcome] * 2 ** (count - 1),
  );
  // A shorter back-off of the other kind never cuts a longer one short.
  failures.retryTick = Math.max(
    failures.retryTick,
    tick + Math.max(1, Math.round(seconds / tickSeconds)),
  );
  failures.cell = { x: cell.x, z: cell.z };
}

/** Whether behaviors leave `place` out at `tick`, as the creature failed to reach it lately. */
export function isBackedOff(place: Readonly<KnownPlace>, tick: number): boolean {
  return place.failures !== undefined && tick < place.failures.retryTick;
}

/** A deep copy, for observations and snapshots. */
export function copyKnowledge(knowledge: CreatureKnowledge): CreatureKnowledge {
  return {
    places: Object.fromEntries(
      Object.entries(knowledge.places).map(([id, places]) => [id, places.map(copyPlace)]),
    ),
    recentCells: knowledge.recentCells.map((c) => ({ ...c })),
  };
}

function copyPlace({ failures, ...place }: KnownPlace): KnownPlace {
  return failures ? { ...place, failures: { ...failures, cell: { ...failures.cell } } } : place;
}
