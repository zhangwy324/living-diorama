import type { RegionPosition } from "@living-diorama/content-schema";
import type { EventCounts } from "@living-diorama/desktop-integration";
import type { SimulationEvent, SimulationSnapshot } from "@living-diorama/simulation";

/** How far a stuck creature must move from where it last got stuck to count as recovered. */
const RECOVERY_DISTANCE = 0.5;

/**
 * Counts the events the soak test checks (ADR 0009 §5–6): `creature_stuck`, how many of those the
 * creature recovered from by moving away again, and `path_failed`.
 */
export class EventCounter {
  readonly counts: EventCounts = { stuck: 0, recovered: 0, pathFailed: 0 };
  /** Creatures waiting to recover: where they last got stuck and how many stuck events that covers. */
  readonly #waiting = new Map<string, { position: RegionPosition; events: number }>();

  /** Takes one snapshot message. Returns whether the counts changed. */
  observe(snapshot: SimulationSnapshot, events: readonly SimulationEvent[]): boolean {
    let changed = false;
    for (const creature of snapshot.creatures) {
      const waiting = this.#waiting.get(creature.id);
      if (waiting && movedAway(waiting.position, creature.position)) {
        this.#waiting.delete(creature.id);
        this.counts.recovered += waiting.events;
        changed = true;
      }
    }
    for (const event of events) {
      if (event.type === "creature_stuck") {
        const events = (this.#waiting.get(event.creatureId)?.events ?? 0) + 1;
        this.#waiting.set(event.creatureId, { position: event.position, events });
        this.counts.stuck++;
        changed = true;
      } else if (event.type === "path_failed") {
        this.counts.pathFailed++;
        changed = true;
      }
    }
    return changed;
  }
}

const movedAway = (from: RegionPosition, to: RegionPosition) =>
  from.regionId !== to.regionId || Math.hypot(to.x - from.x, to.z - from.z) >= RECOVERY_DISTANCE;
