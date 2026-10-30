import type {
  Diagnostic,
  Drawing,
  Result,
  SizeClass,
  VoxelAssembly,
} from "@living-diorama/content-schema";
import {
  StudioRequestError,
  type RequestHandlers,
  type StudioChannel,
} from "@living-diorama/desktop-integration";
import type { CheckedLimits, PartSummary, PartTypeSummary } from "@living-diorama/simulation";
import {
  assemblyBytes,
  MAX_ASSEMBLY_BYTES,
  tooBigMessage,
  type LibraryAssembly,
  type LibrarySpecies,
  type SpeciesLibrary,
} from "./species-library";
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

/** A voxel creature to release (ADR 0023 §17). */
export interface ReleaseVoxelParams {
  /** As for `ReleaseParams`: the Studio keeps it while the assembly, name and plan are unchanged. */
  releaseId: string;
  /** The assembly as built. Untrusted: the library checks it again. */
  assembly: VoxelAssembly;
  name: string;
  /** Its ways of moving. A voxel body's size and anchors come from its cubes (ADR 0022 §20). */
  plan: Pick<BodyPlanChoice, "locomotion">;
}

/** The parts the Studio builds with, from the strip's latest `ready` (ADR 0023 §18). */
export interface StudioParts {
  /** Every registered voxel part, by ID. */
  parts: PartSummary[];
  /** Every registered part type, by ID, with its name for the tray's headings. */
  partTypes: PartTypeSummary[];
  /** The ID of every registered socket type, sorted. */
  socketTypes: string[];
  /** The colours to suggest for recolouring, as `#rrggbb`, from the packs' palettes (§11). */
  suggestedColors: string[];
}

/** The parts the Studio builds with, picked from a `ready`'s content (ADR 0023 §18). */
export const studioParts = ({
  parts,
  partTypes,
  socketTypes,
  suggestedColors,
}: StudioParts): StudioParts => ({ parts, partTypes, socketTypes, suggestedColors });

/**
 * Why the strip refused a request, for the Studio to act on as well as show (`StudioRequestError`'s
 * `code`). The message is in the player's words.
 * - `not_ready`: the world or the library is still starting; asking again later may work.
 * - `invalid_request`: no name, no way of moving or a malformed release ID. The Studio shouldn't
 *   send these.
 * - `world_full`: no room for another creature (ADR 0012 §6).
 * - `assembly_too_big`: over `MAX_ASSEMBLY_BYTES` as JSON (#208).
 * - `too_large`: larger than `large`, so no size class fits it (ADR 0023 §14).
 * - `no_spawn_point`: a limit error, nowhere for it to appear in this world (ADR 0023 §14).
 * - `release_failed`: anything else that kept a release from being saved.
 * - `unknown_species`, `not_voxel`: no voxel species with that ID is in the library.
 */
export type StudioErrorCode =
  | "not_ready"
  | "invalid_request"
  | "world_full"
  | "assembly_too_big"
  | "too_large"
  | "no_spawn_point"
  | "release_failed"
  | "unknown_species"
  | "not_voxel";

const refuse = (code: StudioErrorCode, message: string) => new StudioRequestError(code, message);

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
  /** The parts, part types and socket types to build with (ADR 0023 §18). */
  parts: { params: undefined; result: StudioParts };
  /** A saved voxel species' assembly, for its thumbnail or to edit a copy (ADR 0023 §3, §19). */
  assembly: { params: { speciesId: string }; result: LibraryAssembly };
  /**
   * Saves a voxel assembly as a species in the library and adds one of it to the world, with
   * `release`'s retries (ADR 0023 §17).
   */
  releaseVoxel: { params: ReleaseVoxelParams; result: Released };
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
  /** The parts from the strip's latest `ready`, once the world has said it is ready. */
  parts(): StudioParts | undefined;
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

/** Where a voxel creature has nowhere to appear: its size comes from its parts, so change them. */
function voxelNoSpawnPoint(name: string, locomotion: LocomotionChoice): string {
  return locomotion.land
    ? `${name} has nowhere to appear in this world at its size. Try adding or removing parts to change its size.`
    : `${name} has nowhere to appear in this world: no starting spot in the water suits it. Let it move on land too, or change its size.`;
}

/** Said when a voxel creature is larger than `large` (ADR 0023 §14). */
export const tooLargeMessage = (name: string) =>
  `${name} is too big to live in the world. Make it smaller to release it.`;

/** A refused voxel release, typed by the rule that blocked it (ADR 0023 §14, §17). */
function voxelReleaseError(
  name: string,
  locomotion: LocomotionChoice,
  diagnostics: readonly Diagnostic[],
): StudioRequestError<StudioErrorCode> {
  const has = (code: string) => diagnostics.some((d) => d.code === code);
  if (has("assembly_too_big")) return refuse("assembly_too_big", tooBigMessage(name));
  if (has("too_large")) return refuse("too_large", tooLargeMessage(name));
  if (has("no_spawn_point")) return refuse("no_spawn_point", voxelNoSpawnPoint(name, locomotion));
  return refuse("release_failed", `${name} couldn't be released: ${describe(diagnostics)}`);
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
    if (!library) throw refuse("not_ready", NOT_OPEN);
    return library;
  };
  // Checked here too, so a full world refuses a release before anything is saved.
  const makeRoom = () => {
    if (services.creatures().length >= services.maxCreatures) {
      throw refuse("world_full", worldFullMessage(services.maxCreatures));
    }
  };

  /** The name to release under, once the release's settings are checked. */
  const checkRelease = (releaseId: string, name: string, locomotion: LocomotionChoice) => {
    const trimmed = name.trim();
    if (!trimmed) throw refuse("invalid_request", "Give your creature a name first.");
    if (!canMove(locomotion)) throw refuse("invalid_request", NO_LOCOMOTION);
    if (!UUID.test(releaseId)) throw refuse("invalid_request", `Not a release ID: ${releaseId}`);
    return trimmed;
  };
  /** Saves a species with `save` under `releaseId`, unless it is kept already, then adds one. */
  const releaseAs = async (
    releaseId: string,
    save: (library: SpeciesLibrary) => Promise<LibrarySpecies>,
  ): Promise<Released> => {
    const library = open();
    // Kept by an earlier try whose answer was lost, before the strip reloaded: add it, don't save.
    const { speciesId } = userSpeciesIds(releaseId);
    let species = library.list().find((kept) => kept.speciesId === speciesId);
    if (!species) {
      makeRoom();
      species = await save(library);
    }
    const added = await library.addCreature(species.speciesId);
    return {
      speciesId: species.speciesId,
      name: species.name,
      ...(added.ok ? {} : { notAdded: describe(added.diagnostics) }),
    };
  };

  const release = (params: ReleaseParams) => {
    const { releaseId, drawing, image, name, sizeClass, thickness, plan } = params;
    const trimmed = checkRelease(releaseId, name, plan.locomotion);
    return releaseAs(releaseId, async (library) => {
      const saved = await library.save(drawing, Uint8Array.from(image), trimmed, sizeClass, {
        id: releaseId,
        thickness,
        plan,
      });
      if (!saved.ok) throw new Error(releaseFailure(trimmed, plan.locomotion, saved.diagnostics));
      return saved.value;
    });
  };
  const releaseVoxel = ({ releaseId, assembly, name, plan }: ReleaseVoxelParams) => {
    // Before anything else, even a species an earlier try kept, so an oversized assembly costs no
    // more work (#208). One that isn't JSON passes here and `saveVoxel` refuses it. A retry while
    // the first try is remembered gets its answer: the Studio sends the same assembly again.
    if ((assemblyBytes(assembly) ?? 0) > MAX_ASSEMBLY_BYTES) {
      throw refuse("assembly_too_big", tooBigMessage(name.trim() || "Your creature"));
    }
    const trimmed = checkRelease(releaseId, name, plan.locomotion);
    return releaseAs(releaseId, async (library) => {
      const saved = await library.saveVoxel(assembly, trimmed, plan, { id: releaseId });
      if (!saved.ok) throw voxelReleaseError(trimmed, plan.locomotion, saved.diagnostics);
      return saved.value;
    });
  };
  // A retry while the first try is still running, or after it finished, gets the same answer,
  // whichever kind of release it is.
  const releases = new Map<string, Promise<Released>>();
  const once = (releaseId: string, run: () => Promise<Released>) => {
    let pending = releases.get(releaseId);
    if (!pending) {
      // Run in a promise, so a refusal thrown before saving is forgotten too.
      pending = Promise.resolve().then(run);
      releases.set(releaseId, pending);
      // Nothing was saved, so the same ID may try again.
      pending.catch(() => releases.delete(releaseId));
    }
    return pending;
  };

  return {
    snapshot: () => librarySnapshot(services),
    limits: async ({ sizeClass, locomotion }) => {
      if (!canMove(locomotion)) throw new Error(NO_LOCOMOTION);
      // A navigation profile is the size and the capabilities; the gait doesn't change it.
      const checked = await services.checkLimits(sizeClass, locomotionCapabilities(locomotion));
      if (!checked.ok) throw new Error(describe(checked.diagnostics));
      return checked.value;
    },
    release: (params) => once(params.releaseId, () => release(params)),
    releaseVoxel: (params) => once(params.releaseId, () => releaseVoxel(params)),
    parts: () => {
      const parts = services.parts();
      if (!parts) throw refuse("not_ready", NOT_OPEN);
      return parts;
    },
    assembly: ({ speciesId }) => {
      const found = open().assembly(speciesId);
      if (found.ok) return found.value;
      const code = found.diagnostics.some((d) => d.code === "not_voxel")
        ? "not_voxel"
        : "unknown_species";
      throw refuse(code, describe(found.diagnostics));
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

/** The Studio's typed requests for building voxel creatures (ADR 0023 §17–§19). */
export function studioClient(
  channel: Pick<StudioChannel<StudioRequests, LibrarySnapshot>, "request">,
) {
  return {
    parts: () => channel.request("parts", undefined),
    assembly: (speciesId: string) => channel.request("assembly", { speciesId }),
    releaseVoxel: (params: ReleaseVoxelParams) => channel.request("releaseVoxel", params),
  };
}

/** The code of the strip's refusal, or undefined for any other failure, such as a timeout. */
export function studioErrorCode(error: unknown): StudioErrorCode | undefined {
  return error instanceof StudioRequestError ? (error.code as StudioErrorCode) : undefined;
}
