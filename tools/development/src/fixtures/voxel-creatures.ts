import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import { measureAssembly, SCHEMA_VERSIONS, type LandGait } from "@living-diorama/content-schema";
import type { RuntimeSpecies } from "../simulation-run";

// Test-only voxel species (ADR 0022, M19): the built-in pack's sample voxel creature
// (`sampleVoxelAssembly`) as the app's development console saves it, one species per body plan.
// They stand in for voxel creatures saved to the library, so they are registered as the app
// registers a library species: while the world runs, with `Simulation.registerSpecies` and the
// appearance kind `voxel`, before a save is restored. The worker gets the assembly's URL only and
// never reads it, so the simulation never sees a cube. Used by tests, `pnpm sim --species` and
// `pnpm soak`.

/** The body plans the app's console offers (`VOXEL_SAMPLE_PLANS` in apps/desktop). */
export const VOXEL_PLANS = {
  walk: { land: true, gait: "walk", swim: false },
  hop: { land: true, gait: "hop", swim: false },
  swim: { land: false, gait: "walk", swim: true },
  "land+swim": { land: true, gait: "walk", swim: true },
} as const satisfies Record<string, { land: boolean; gait: LandGait; swim: boolean }>;
export type VoxelPlan = keyof typeof VOXEL_PLANS;

/**
 * The size class measured from the sample's cubes, as the app's library measures it when the
 * species is saved (ADR 0022, M19 decisions), not written down here.
 */
export const VOXEL_SIZE_CLASS = (() => {
  const { sizeClass } = measureAssembly(sampleVoxelAssembly());
  if (!sizeClass) throw new Error("The sample voxel creature is too large for every size class");
  return sizeClass;
})();

/**
 * The sample voxel creature as a species of `plan`, with the app's defaults for a player's species
 * (`USER_SPECIES_DEFAULTS`) and a `user:` ID like a library species'. Its capabilities and gait
 * come from the plan as the app maps them (`locomotionCapabilities`, `planVoxelBody`).
 */
export function voxelSpecies(plan: VoxelPlan): RuntimeSpecies {
  const { land, gait, swim } = VOXEL_PLANS[plan];
  const id = `user:voxel-${plan.replace("+", "-")}`;
  return {
    input: {
      schemaVersion: SCHEMA_VERSIONS.species,
      id,
      version: "1.0.0",
      name: `Voxel ${plan}`,
      appearance: `${id}/assembly.json`,
      sizeClass: VOXEL_SIZE_CLASS,
      capabilities: { ...(land ? { "core:land": 1 } : {}), ...(swim ? { "core:swim": 1 } : {}) },
      baseSpeed: 0.6,
      behaviors: ["core:wander", "core:feed", "core:rest"],
      senses: { "core:vision": 8 },
      traits: {},
      body: { locomotion: { land: { gait } } },
    },
    // The app's would be a `blob:` URL of the assembly's JSON. Nothing reads this one.
    url: `blob:fixture/${id}/assembly.json`,
    kind: "voxel",
  };
}

/** One voxel species per plan, by plan. */
export const VOXEL_SPECIES = Object.fromEntries(
  (Object.keys(VOXEL_PLANS) as VoxelPlan[]).map((plan) => [plan, voxelSpecies(plan)]),
) as Record<VoxelPlan, RuntimeSpecies>;
