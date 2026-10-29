import type { Diagnostic, Drawing, Result, SizeClass } from "@living-diorama/content-schema";
import type { RequestHandlers } from "@living-diorama/desktop-integration";
import type { CheckedLimits } from "@living-diorama/simulation";
import type { LibrarySpecies, SpeciesLibrary } from "./species-library";
import {
  canMove,
  locomotionCapabilities,
  type BodyPlanChoice,
  type LocomotionChoice,
} from "./body-plan";
import { userSpeciesIds, userSpeciesUuid } from "./user-species";

// What the Creation Studio and the strip say to each other over the window channel (ADR 0015 §5).

/** A species as the Studio lists it: the library's, with its creatures in the world. */
export type StudioSpecies = LibrarySpecies & {
  /** The UUID it is stored under, to load its image with (ADR 0014 §1). */
  libraryId: string;
  /** How many of its creatures are in the world now. */
  inWorld: number;
};

/** The species library as the Studio sees it. Images are not included: the Studio loads them. */
export interface LibrarySnapshot {
  species: StudioSpecies[];
  /** Creatures in the world now, of every species, built-in ones included. */
  creatures: number;
  /** The most creatures the world holds. */
  maxCreatures: number;
}

export interface ReleaseParams {
  /**
   * The lowercase UUID the species is kept under. The Studio makes one per drawing and sends the
   * same one again when the player retries, so a release whose answer was lost isn't saved twice.
   */
  releaseId: string;
  drawing: Drawing;
  /** The appearance image's PNG bytes. */
  image: number[];
  name: string;
  sizeClass: SizeClass;
  /** The body's depth as a share of its height. */
  thickness: number;
  /** The body plan chosen in the confirm panel (ADR 0020 §12, §14). */
  plan: BodyPlanChoice;
}

export interface Released {
  speciesId: string;
  name: string;
  /** Set when the species was kept but no creature of it could be added: why, in words. */
  notAdded?: string;
}

export type StudioRequests = {
  /** The library now. The Studio asks when it opens, since a push before then is lost. */
  snapshot: { params: undefined; result: LibrarySnapshot };
  /**
   * Where a drawn species of this size, moving this way, wouldn't fit in the world, registering
   * nothing (ADR 0015 §8, ADR 0020 §12). Errors among them mean it can't be released so. With
   * them, the locomotion rules of its ways of moving, which the preview plays (issue #136).
   */
  limits: {
    params: { sizeClass: SizeClass; locomotion: Pick<LocomotionChoice, "land" | "swim"> };
    result: CheckedLimits;
  };
  /** Saves the drawing as a species in the library and adds one of it to the world. */
  release: { params: ReleaseParams; result: Released };
  /** Adds a creature of a library species. Resolves with its ID. */
  addCreature: { params: { speciesId: string }; result: string };
  /** Takes the newest creature of a species out of the world. Resolves with its ID. */
  removeCreature: { params: { speciesId: string }; result: string };
  /** Deletes a species from the library; its creatures leave the world (ADR 0014 §9). */
  deleteSpecies: { params: { speciesId: string }; result: null };
};

type Creature = { id: string; speciesId: string };

/** What the strip's answers need. */
export interface StudioServices {
  /** The library, once it is open. */
  library(): SpeciesLibrary | undefined;
  /** The creatures in the world now, from the latest snapshot. */
  creatures(): readonly Creature[];
  /** The world's creature cap (ADR 0012 §6). */
  maxCreatures: number;
  /** The worker's limits query, once the world is running. */
  checkLimits(
    sizeClass: SizeClass,
    capabilities: Record<string, number>,
  ): Promise<Result<CheckedLimits>>;
}

/** The worker says the same when a spawn would pass the cap (ADR 0012 §6). */
export const worldFullMessage = (maxCreatures: number) =>
  `The world is full (${maxCreatures} creatures). Remove one to add another.`;

const NOT_OPEN = "The world is still starting. Try again in a moment.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const describe = (diagnostics: readonly Diagnostic[]) =>
  diagnostics.map((d) => d.message).join("; ");

/** Release needs at least one way of moving (ADR 0020 §1). */
export const NO_LOCOMOTION = "Choose at least one way for it to move: on land, swimming or both.";

/**
 * Why a release failed, in the player's words where the reason is one they can act on. A world
 * with no starting spot for this size and way of moving refuses the species (`no_spawn_point`,
 * ADR 0020 §6): for a creature that only swims, a world whose spawn points are all on land.
 */
export function releaseFailure(
  name: string,
  locomotion: LocomotionChoice,
  diagnostics: readonly Diagnostic[],
): string {
  if (diagnostics.some((d) => d.code === "no_spawn_point")) {
    return locomotion.land
      ? `${name} has nowhere to appear in this world at this size. Try another size.`
      : `${name} has nowhere to appear in this world: no starting spot in the water suits it. Let it move on land too, or try another size.`;
  }
  return `${name} couldn't be released: ${describe(diagnostics)}`;
}

/** How many creatures of each species are in the world. */
export function countBySpecies(creatures: readonly Creature[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { speciesId } of creatures) counts.set(speciesId, (counts.get(speciesId) ?? 0) + 1);
  return counts;
}

/** The library and the world's creatures as the Studio shows them. */
export function librarySnapshot(services: StudioServices): LibrarySnapshot {
  const creatures = services.creatures();
  const counts = countBySpecies(creatures);
  return {
    species: (services.library()?.list() ?? []).map((species) => ({
      ...species,
      libraryId: userSpeciesUuid(species.speciesId),
      inWorld: counts.get(species.speciesId) ?? 0,
    })),
    creatures: creatures.length,
    maxCreatures: services.maxCreatures,
  };
}

/** The strip's answers to the Studio's requests. */
export function studioHandlers(services: StudioServices): RequestHandlers<StudioRequests> {
  const open = () => {
    const library = services.library();
    if (!library) throw new Error(NOT_OPEN);
    return library;
  };
  // Checked here too, so a full world refuses a release before anything is saved.
  const makeRoom = () => {
    if (services.creatures().length >= services.maxCreatures) {
      throw new Error(worldFullMessage(services.maxCreatures));
    }
  };

  const release = async ({
    releaseId,
    drawing,
    image,
    name,
    sizeClass,
    thickness,
    plan,
  }: ReleaseParams): Promise<Released> => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Give your creature a name first.");
    if (!canMove(plan.locomotion)) throw new Error(NO_LOCOMOTION);
    if (!UUID.test(releaseId)) throw new Error(`Not a release ID: ${releaseId}`);
    const library = open();
    // Kept by an earlier try whose answer was lost, before the strip reloaded: add it, don't save.
    const { speciesId } = userSpeciesIds(releaseId);
    let species = library.list().find((kept) => kept.speciesId === speciesId);
    if (!species) {
      makeRoom();
      const saved = await library.save(drawing, Uint8Array.from(image), trimmed, sizeClass, {
        id: releaseId,
        thickness,
        plan,
      });
      if (!saved.ok) throw new Error(releaseFailure(trimmed, plan.locomotion, saved.diagnostics));
      species = saved.value;
    }
    const added = await library.addCreature(species.speciesId);
    return {
      speciesId: species.speciesId,
      name: species.name,
      ...(added.ok ? {} : { notAdded: describe(added.diagnostics) }),
    };
  };
  // A retry while the first try is still running, or after it finished, gets the same answer.
  const releases = new Map<string, Promise<Released>>();

  return {
    snapshot: () => librarySnapshot(services),
    limits: async ({ sizeClass, locomotion }) => {
      if (!canMove(locomotion)) throw new Error(NO_LOCOMOTION);
      // A navigation profile is the size and the capabilities; the gait doesn't change it.
      const checked = await services.checkLimits(sizeClass, locomotionCapabilities(locomotion));
      if (!checked.ok) throw new Error(describe(checked.diagnostics));
      return checked.value;
    },
    release: (params) => {
      let pending = releases.get(params.releaseId);
      if (!pending) {
        pending = release(params);
        releases.set(params.releaseId, pending);
        // Nothing was saved, so the same ID may try again.
        pending.catch(() => releases.delete(params.releaseId));
      }
      return pending;
    },
    addCreature: async ({ speciesId }) => {
      const library = open();
      makeRoom();
      const added = await library.addCreature(speciesId);
      if (!added.ok) throw new Error(describe(added.diagnostics));
      return added.value;
    },
    removeCreature: async ({ speciesId }) => {
      const library = open();
      const newest = services.creatures().findLast((creature) => creature.speciesId === speciesId);
      if (!newest) throw new Error("None of them are in the world.");
      const removed = await library.removeCreature(newest.id);
      if (!removed.ok) throw new Error(describe(removed.diagnostics));
      return removed.value;
    },
    deleteSpecies: async ({ speciesId }) => {
      const deleted = await open().deleteSpecies(speciesId);
      if (!deleted.ok) throw new Error(describe(deleted.diagnostics));
      return null;
    },
  };
}
