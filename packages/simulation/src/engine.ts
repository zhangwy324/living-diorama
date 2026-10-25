import { WORLD_TOLERANCES, type Result } from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
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
    // Implementations arrive in M3; the entries exist now so content can depend on them.
    registries.actions.register({ id: "core:idle", version: "1.0.0" }),
    registries.actions.register({ id: "core:follow_path", version: "1.0.0" }),
    registries.behaviors.register({
      id: "core:wander",
      version: "1.0.0",
      dependencies: [
        { registry: "actions", id: "core:idle", version: "^1.0.0" },
        { registry: "actions", id: "core:follow_path", version: "^1.0.0" },
      ],
    }),
  ];
}
