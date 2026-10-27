// IDs for species the player draws (roadmap §2.2, ADR 0012). They live in the `user` namespace
// by convention only: the engine registers and runs them like any pack's species.

export interface UserSpeciesIds {
  /** The lowercase UUID the species is stored under in the library (ADR 0014 §1). */
  uuid: string;
  /** The species ID, e.g. `user:3f9c2a1e-…`. */
  speciesId: string;
  /** The ID of its appearance image, e.g. `user:3f9c2a1e-…/appearance.png`. */
  appearanceId: string;
}

/** The IDs of the drawn species stored under `uuid`; a fresh one by default. */
export function userSpeciesIds(uuid: string = crypto.randomUUID()): UserSpeciesIds {
  const speciesId = `user:${uuid}`;
  return { uuid, speciesId, appearanceId: `${speciesId}/appearance.png` };
}
