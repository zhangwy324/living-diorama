// WORLD_TOLERANCES and SIZE_CLASSES are defined in docs/world-coordinates.md. Change both together.

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

/** The radius of the largest size class, in metres. */
export const MAX_SIZE_CLASS_RADIUS = Math.max(
  ...Object.values(SIZE_CLASSES).map((size) => size.radius),
);

// The arc of a bank jump (ADR 0020 §4, issue #132). The renderer draws it; navigation keeps
// raised surfaces out of its way up to its cap. Both read these, so they change together.

/**
 * How far a bank jump's arc rises above the higher end of the jump, in metres: a base plus a
 * share of the jump's horizontal length, so long jumps leap higher, up to `maxJumpClearance`.
 */
export const JUMP_CLEARANCE = { base: 0.1, perMetre: 0.2 } as const;

/**
 * The most a bank jump's arc rises above its higher end, whatever the jump's length, for a
 * creature of `radius`: its radius (half its height), so a small creature leaps like one and
 * stays under a deck it may pass beneath.
 */
export const maxJumpClearance = (radius: number): number => radius;

/**
 * How far above its higher end the arc of a jump `horizontal` metres long rises, for a creature
 * of `radius`: a tiny one 0.1 m, a large one up to 0.77 m on its longest jump. With the size
 * unknown, the largest size class's radius caps it.
 */
export const jumpClearance = (horizontal: number, radius = MAX_SIZE_CLASS_RADIUS): number =>
  Math.min(JUMP_CLEARANCE.base + JUMP_CLEARANCE.perMetre * horizontal, maxJumpClearance(radius));

/** Current data-format version per definition type (ADR 0003). */
export const SCHEMA_VERSIONS = {
  world: 2,
  structure: 2,
  prop: 2,
  propCategory: 1,
  species: 1,
} as const;

export type DefinitionKind = keyof typeof SCHEMA_VERSIONS;

/** Current data-format version of a world save (ADR 0019). */
export const WORLD_SAVE_SCHEMA_VERSION = 4;
