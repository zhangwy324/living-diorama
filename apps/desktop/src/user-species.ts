// IDs for species the player makes (roadmap §2.2, ADR 0012). They live in the `user` namespace
// by convention only: the engine registers and runs them like any pack's species.

export interface UserSpeciesIds {
  /** The lowercase UUID the species is stored under in the library (ADR 0014 §1). */
  uuid: string;
  /** The species ID, e.g. `user:3f9c2a1e-…`. */
  speciesId: string;
}

/** The IDs of the species stored under `uuid`; a fresh one by default. */
export function userSpeciesIds(uuid: string = crypto.randomUUID()): UserSpeciesIds {
  return { uuid, speciesId: `user:${uuid}` };
}

/** The UUID a species is stored under, from its species ID. */
export const userSpeciesUuid = (speciesId: string): string => speciesId.replace(/^user:/, "");
