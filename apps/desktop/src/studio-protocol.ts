import type { Result, SizeClass } from "@living-diorama/content-schema";
import type { RequestHandlers } from "@living-diorama/desktop-integration";
import type { Limit } from "@living-diorama/simulation";
import type { LibrarySpecies } from "./species-library";
import { DRAWN_SPECIES_DEFAULTS } from "./startup";

// What the Creation Studio and the strip say to each other over the window channel (ADR 0015 §5).
// Release, adding and removing creatures and deleting a species join these in PR 4.

/** The species library as the Studio sees it. Images are not included: the Studio loads them. */
export interface LibrarySnapshot {
  species: LibrarySpecies[];
}

export type StudioRequests = {
  /** The library now. The Studio asks when it opens, since a push before then is lost. */
  snapshot: { params: undefined; result: LibrarySnapshot };
  /**
   * Where a drawn species of this size wouldn't fit in the world, registering nothing (ADR 0015
   * §8). Errors among them mean it can't be released at that size.
   */
  limits: { params: { sizeClass: SizeClass }; result: Limit[] };
};

/** What the strip's answers need. */
export interface StudioServices {
  library(): LibrarySnapshot;
  /** The worker's limits query, once the world is running. */
  checkLimits(sizeClass: SizeClass, capabilities: Record<string, number>): Promise<Result<Limit[]>>;
}

/** The strip's answers to the Studio's requests. */
export function studioHandlers(services: StudioServices): RequestHandlers<StudioRequests> {
  return {
    snapshot: () => services.library(),
    limits: async ({ sizeClass }) => {
      // Drawn species all move like this (ADR 0014 §11), so size is the only part that varies.
      const checked = await services.checkLimits(sizeClass, DRAWN_SPECIES_DEFAULTS.capabilities);
      if (!checked.ok) throw new Error(checked.diagnostics.map((d) => d.message).join("; "));
      return checked.value;
    },
  };
}
