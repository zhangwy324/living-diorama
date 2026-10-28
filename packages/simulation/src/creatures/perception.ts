import type { AffordanceType } from "@living-diorama/extension-api";
import type { PropModel } from "../world/world-model";
import { gridCellAt, rememberPlace, visitCell, type CreatureKnowledge } from "./knowledge";

// Perception (ADR 0018 §10 and amendments): once a second, a creature notes the places around it
// that offer an affordance it remembers, and the coarse grid cell it is in. The engine runs it,
// since behaviors only see copies of knowledge. Generic: places are found by affordance.

/** The sense that gives a creature its sight range, in metres. */
export const VISION_SENSE = "core:vision";
/** A creature learns of a place it comes this close to, vision or not, in metres from its edge. */
export const TOUCH_DISTANCE = 1;
/** Scans per simulated second. */
export const PERCEPTION_HZ = 1;

/**
 * The tick offset, within one scan period, at which a creature scans: spread by its ID so the
 * scans of many creatures don't all land on the same tick (ADR 0018 amendments, §10).
 */
export function perceptionOffset(creatureId: string, periodTicks: number): number {
  // FNV-1a: stable across runs and platforms.
  let hash = 0x811c9dc5;
  for (let k = 0; k < creatureId.length; k++) {
    hash = Math.imul(hash ^ creatureId.charCodeAt(k), 0x01000193) >>> 0;
  }
  return hash % periodTicks;
}

export interface PerceptionInput {
  knowledge: CreatureKnowledge;
  x: number;
  z: number;
  /** Sight range in metres, variation applied; undefined for a creature without vision. */
  vision: number | undefined;
  tick: number;
  propsByAffordance: ReadonlyMap<string, readonly PropModel[]>;
  affordance(id: string): AffordanceType | undefined;
}

/**
 * Remembers every place within sight (straight-line distance to its centre, no line of sight)
 * or within touch (`TOUCH_DISTANCE` of its edge) that offers an affordance with a `remember` cap,
 * and records the grid cell the creature is in. When more places of one affordance are in view
 * than the cap, only the nearest are noted, so a scan never forgets what it has just seen.
 */
export function perceive({
  knowledge,
  x,
  z,
  vision,
  tick,
  propsByAffordance,
  affordance,
}: PerceptionInput): void {
  for (const [id, props] of propsByAffordance) {
    const cap = affordance(id)?.remember;
    if (cap === undefined || cap < 1) continue;
    const noticed: { prop: PropModel; distance: number }[] = [];
    for (const prop of props) {
      const { position } = prop.transform;
      const distance = Math.hypot(position.x - x, position.z - z);
      const seen = vision !== undefined && distance <= vision;
      if (seen || distance - prop.blockRadius <= TOUCH_DISTANCE) noticed.push({ prop, distance });
    }
    // At most `cap` noted per scan, so every eviction drops a place seen on an earlier scan.
    noticed.sort((a, b) => a.distance - b.distance);
    for (const { prop } of noticed.slice(0, cap)) {
      rememberPlace(knowledge, id, prop.id, tick, cap);
    }
  }
  visitCell(knowledge, gridCellAt(x, z), tick);
}
