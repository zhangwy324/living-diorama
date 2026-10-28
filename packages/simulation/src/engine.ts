import {
  EmptyAffordanceParamsSchema,
  FoodAffordanceParamsSchema,
  WORLD_TOLERANCES,
  type Result,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import { coreActions } from "./creatures/core-actions";
import { eatAction, feedBehavior } from "./creatures/feed";
import { coreNeeds, coreSenses, coreTraits } from "./creatures/needs";
import { coreBehaviors } from "./creatures/wander";
import { coreSurfaces } from "./world/surfaces";

/**
 * Registers the engine's own entries: surface types, actions, behaviors and the core
 * capability, affordance, need, sense and trait vocabulary. Content packs register after this.
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
    registries.affordances.register({
      id: "core:crossable",
      version: "1.0.0",
      paramsSchema: EmptyAffordanceParamsSchema,
    }),
    registries.affordances.register({
      id: "core:food",
      version: "1.0.0",
      paramsSchema: FoodAffordanceParamsSchema,
      remember: 8,
    }),
    registries.affordances.register({
      id: "core:shelter",
      version: "1.0.0",
      paramsSchema: EmptyAffordanceParamsSchema,
      remember: 4,
    }),
    ...coreNeeds.map((need) => registries.needs.register(need)),
    ...coreSenses.map((sense) => registries.senses.register(sense)),
    ...coreTraits.map((trait) => registries.traits.register(trait)),
    ...[...coreActions, eatAction].map((action) => registries.actions.register(action)),
    ...[...coreBehaviors, feedBehavior].map((behavior) => registries.behaviors.register(behavior)),
  ];
}
