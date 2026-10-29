// Values defined in docs/world-coordinates.md. Change both together.

export const WORLD_TOLERANCES = {
  maxWalkableSlopeDeg: 35,
  maxStepHeight: 0.25,
  /** Largest height between land and water a creature that swims jumps in or climbs out over. */
  maxBankJumpHeight: 0.75,
  /**
   * Widest horizontal gap between such a creature's body on land and its body in the water, edge
   * to edge, it jumps across: the steep face of a bank and the cells its radius keeps clear.
   */
  maxBankJumpGap: 1.75,
  surfaceEpsilon: 0.001,
  positionEpsilon: 0.01,
} as const;

export const SIZE_CLASSES = {
  tiny: { radius: 0.1, height: 0.2 },
  small: { radius: 0.2, height: 0.4 },
  medium: { radius: 0.4, height: 0.8 },
  large: { radius: 0.8, height: 1.6 },
} as const;

export type SizeClass = keyof typeof SIZE_CLASSES;

/** Current data-format version per definition type (ADR 0003). */
export const SCHEMA_VERSIONS = {
  world: 2,
  structure: 2,
  prop: 1,
  species: 1,
} as const;

export type DefinitionKind = keyof typeof SCHEMA_VERSIONS;

/** Current data-format version of a world save (ADR 0019). */
export const WORLD_SAVE_SCHEMA_VERSION = 2;
