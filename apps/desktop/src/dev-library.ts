import {
  assembleParts,
  error,
  formatDiagnostic,
  type PartFitLookup,
  type Result,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import type { PartSummary } from "@living-diorama/simulation";
import type { LocomotionChoice } from "./body-plan";
import type { TimeDevHook } from "./dev-time";
import type { WorldDevHook } from "./dev-world";
import type { LibrarySpecies, SpeciesLibrary } from "./species-library";

// A development-only console hook to the species library (ADR 0014), for checks the Studio (M11)
// doesn't cover. In the dev app's console:
//
//   await livingDiorama.library.saveVoxelSample("hop")   // a voxel creature (ADR 0022), added
//   await livingDiorama.library.addCreature(livingDiorama.library.list()[0].speciesId)
//   livingDiorama.library.starterParts()   // the registered voxel parts, as a table
//   await livingDiorama.library.saveStarterCreature({ seed: 42 })   // assembled from them, added
//
// `dev-time.ts` adds `livingDiorama.time`, and `dev-world.ts` `livingDiorama.world`.

declare global {
  interface Window {
    livingDiorama?: { library?: unknown; time?: TimeDevHook; world?: WorldDevHook };
  }
}

/** The body plans the voxel sample can have, through the Studio's mapping (`body-plan.ts`). */
export const VOXEL_SAMPLE_PLANS = {
  walk: { land: true, gait: "walk", swim: false },
  hop: { land: true, gait: "hop", swim: false },
  swim: { land: false, gait: "walk", swim: true },
  "land+swim": { land: true, gait: "walk", swim: true },
} as const satisfies Record<string, LocomotionChoice>;
export type VoxelSamplePlan = keyof typeof VOXEL_SAMPLE_PLANS;

const failure = (code: string, message: string): Result<never> => ({
  ok: false,
  diagnostics: [error(code, message, [])],
});

/** The ways of moving of `plan`, or `unknown_plan`. */
function planLocomotion(plan: VoxelSamplePlan): Result<LocomotionChoice> {
  if (Object.hasOwn(VOXEL_SAMPLE_PLANS, plan)) {
    return { ok: true, value: { ...VOXEL_SAMPLE_PLANS[plan] } };
  }
  const plans = Object.keys(VOXEL_SAMPLE_PLANS).join(", ");
  return failure("unknown_plan", `"${plan}" is not one of ${plans}`);
}

/** Saves a voxel assembly as a species moving that way, and adds one of its creatures. */
async function saveAndAdd(
  library: SpeciesLibrary,
  assembly: VoxelAssembly,
  name: string,
  locomotion: LocomotionChoice,
): Promise<Result<{ species: LibrarySpecies; creatureId: string }>> {
  const saved = await library.saveVoxel(assembly, name, { locomotion });
  if (!saved.ok) return saved;
  const added = await library.addCreature(saved.value.speciesId);
  return added.ok ? { ok: true, value: { species: saved.value, creatureId: added.value } } : added;
}

/**
 * Saves the sample voxel creature (`sampleVoxelAssembly`) as a species of `plan`, and adds one of
 * its creatures to the world. Resolves with the species and the creature's ID.
 */
export async function saveVoxelSample(
  library: SpeciesLibrary,
  plan: VoxelSamplePlan = "walk",
  name = `Voxel ${plan}`,
): Promise<Result<{ species: LibrarySpecies; creatureId: string }>> {
  const locomotion = planLocomotion(plan);
  if (!locomotion.ok) return locomotion;
  // Loaded only when asked for, so the pack stays out of the strip's own bundle.
  const { sampleVoxelAssembly } = await import("@living-diorama/built-in-content");
  return saveAndAdd(library, sampleVoxelAssembly(), name, locomotion.value);
}

/**
 * The registered voxel parts (`ready.parts`) and what the assembler needs of the registered types
 * (`partFitLookup`), to assemble starter creatures from (ADR 0022, M20 decisions).
 */
export interface StarterParts {
  parts: readonly PartSummary[];
  lookup: PartFitLookup;
}

/**
 * The parts a starter creature can be built on: those whose part type has the `root` role, such as
 * the torsos (ADR 0023 §10). Read from roles, not from IDs, so a pack's parts work the same.
 * Sorted by ID, so the root a seed picks doesn't depend on the order the parts come in.
 */
export function starterRoots({ parts, lookup }: StarterParts): PartSummary[] {
  return parts
    .filter(({ part }) => lookup.roleOf(part.type) === "root")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A random seed for the assembler: a whole number from 0 to 2³² − 1. */
export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

export interface StarterOptions {
  /** The ID of the part to build on. By default the seed picks one of `starterRoots`. */
  root?: string;
  /** A whole number from 0 to 2³² − 1. Random by default. */
  seed?: number;
  plan?: VoxelSamplePlan;
  /** The species' name, by default `Starter <seed>`. */
  name?: string;
}

/** A starter creature and what it was built from, so the same one can be built again. */
export interface StarterAssembly {
  assembly: VoxelAssembly;
  root: string;
  seed: number;
}

/**
 * Assembles a creature from the starter parts with `assembleParts`, on `root` or, by default, on
 * the root the seed picks of `starterRoots`, so the same seed and parts give the same creature.
 */
export function assembleStarter(
  starter: StarterParts,
  { root, seed = randomSeed() }: Pick<StarterOptions, "root" | "seed"> = {},
): Result<StarterAssembly> {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    return failure(
      "invalid_seed",
      `The seed must be a whole number from 0 to 2³² − 1, not ${seed}`,
    );
  }
  let start: PartSummary | undefined;
  if (root === undefined) {
    const roots = starterRoots(starter);
    start = roots[seed % roots.length];
    if (!start) {
      const { length } = starter.parts;
      const message =
        length === 0
          ? "No voxel parts are registered"
          : `None of the ${length} registered voxel parts is a root`;
      return failure("no_root", message);
    }
  } else {
    start = starter.parts.find((p) => p.id === root);
    if (!start) return failure("unknown_part", `"${root}" is not a registered part`);
  }
  try {
    const assembly = assembleParts({ start, parts: starter.parts, lookup: starter.lookup, seed });
    return { ok: true, value: { assembly, root: start.id, seed } };
  } catch (cause) {
    return failure("assembly_failed", cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Assembles a starter creature (`assembleStarter`), saves it as a species of `plan` and adds one
 * of its creatures to the world. Resolves with the species, the creature's ID, and the root and
 * seed that build it again.
 */
export async function saveStarterCreature(
  library: SpeciesLibrary,
  starter: StarterParts,
  { plan = "walk", name, ...options }: StarterOptions = {},
): Promise<Result<{ species: LibrarySpecies; creatureId: string; root: string; seed: number }>> {
  const locomotion = planLocomotion(plan);
  if (!locomotion.ok) return locomotion;
  const assembled = assembleStarter(starter, options);
  if (!assembled.ok) return assembled;
  const { assembly, root, seed } = assembled.value;
  const added = await saveAndAdd(library, assembly, name ?? `Starter ${seed}`, locomotion.value);
  return added.ok ? { ok: true, value: { ...added.value, root, seed } } : added;
}

/** The starter parts as the console lists them. */
export const listStarterParts = ({ parts }: StarterParts) =>
  parts.map(({ id, name, part }) => ({ id, name, type: part.type }));

/**
 * Puts the library on `window.livingDiorama.library`, with `saveVoxelSample` to add a voxel
 * species, `starterParts` to list the registered voxel parts and `saveStarterCreature` to add a
 * voxel species assembled from them.
 */
export function installLibraryDevHook(library: SpeciesLibrary, starter: StarterParts): void {
  window.livingDiorama = {
    ...window.livingDiorama,
    library: {
      ...library,
      saveVoxelSample: (plan?: VoxelSamplePlan, name?: string) =>
        saveVoxelSample(library, plan, name),
      starterParts: () => {
        const listed = listStarterParts(starter);
        console.table(listed);
        return listed;
      },
      saveStarterCreature: async (options?: StarterOptions) => {
        const saved = await saveStarterCreature(library, starter, options);
        if (saved.ok) {
          const { species, creatureId, root, seed } = saved.value;
          console.info(
            `Saved ${species.name} (${species.speciesId}) and added ${creatureId}: root ${root}, seed ${seed}`,
          );
        } else {
          console.warn(saved.diagnostics.map(formatDiagnostic).join("\n"));
        }
        return saved;
      },
    },
  };
}
