import type { LibrarySpecies } from "./species-library";

// What the Creation Studio and the strip say to each other over the window channel (ADR 0015 §5).
// Release, adding and removing creatures, deleting a species and the limits query join these in
// later PRs.

/** The species library as the Studio sees it. Images are not included: the Studio loads them. */
export interface LibrarySnapshot {
  species: LibrarySpecies[];
}

export type StudioRequests = {
  /** The library now. The Studio asks when it opens, since a push before then is lost. */
  snapshot: { params: undefined; result: LibrarySnapshot };
};
