import { WORLD_TOLERANCES, type Result } from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import { coreActions } from "./creatures/core-actions";
import { coreBehaviors } from "./creatures/wander";
import { coreSurfaces } from "./world/surfaces";

/**
 * Registers the engine's own entries: surface types, actions, behaviors and the core
 * capability and affordance vocabulary. Content packs register after this.
 */
export function registerCoreEngine(registries: Registries): Result<unknown>[] {
  return [
    ...coreSurfaces.map((surface) => registries.surfaces.register(surface)),
    registries.capabilities.register({
      id: "core:walk",
      version: "1.0.0",
      locomotion: {
        regionKinds: ["land", "cave"],
        maxSlopeDeg: WORLD_TOLERANCES.maxWalkableSlopeDeg,
      },
    }),
    registries.affordances.register({ id: "core:crossable", version: "1.0.0" }),
    ...coreActions.map((action) => registries.actions.register(action)),
    ...coreBehaviors.map((behavior) => registries.behaviors.register(behavior)),
  ];
}
