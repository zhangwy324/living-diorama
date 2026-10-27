// IDs for species the player draws (roadmap §2.2, ADR 0012). They live in the `user` namespace
// by convention only: the engine registers and runs them like any pack's species.

export interface UserSpeciesIds {
  /** The species ID, e.g. `user:3f9c2a1e-…`. */
  speciesId: string;
  /** The ID of its appearance image, e.g. `user:3f9c2a1e-…/appearance.png`. */
  appearanceId: string;
}

/** Fresh IDs for a new drawn species. */
export function newUserSpeciesIds(uuid: () => string = () => crypto.randomUUID()): UserSpeciesIds {
  const speciesId = `user:${uuid()}`;
  return { speciesId, appearanceId: `${speciesId}/appearance.png` };
}
