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
import { restBehavior, sleepAction } from "./creatures/rest";
import { coreBehaviors } from "./creatures/wander";
import { coreSurfaces } from "./world/surfaces";

/** How far a swimmer sits below the water's surface, as a share of its body's height (ADR 0020 §9). */
export const SWIM_SUBMERSION = 0.5;

/**
 * Registers the engine's own entries: surface types, actions, behaviors and the core
 * capability (`core:land`, `core:swim`), affordance, need, sense and trait vocabulary. Content
 * packs register after this.
 */
export function registerCoreEngine(registries: Registries): Result<unknown>[] {
  return [
    ...coreSurfaces.map((surface) => registries.surfaces.register(surface)),
    registries.capabilities.register({
      id: "core:land",
      version: "1.0.0",
      locomotion: {
        regionKinds: ["land", "cave"],
        maxSlopeDeg: WORLD_TOLERANCES.maxWalkableSlopeDeg,
        // The species' land gait, `walk` or `hop`, names the profile (ADR 0020 §1, §8).
        animation: { fromStyle: "land" },
      },
    }),
    registries.capabilities.register({
      id: "core:swim",
      version: "1.0.0",
      // On the water's flat surface, so no slope limit (ADR 0020 §2).
      locomotion: { regionKinds: ["water"], animation: "swim", submersion: SWIM_SUBMERSION },
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
    ...[...coreActions, eatAction, sleepAction].map((action) =>
      registries.actions.register(action),
    ),
    ...[...coreBehaviors, feedBehavior, restBehavior].map((behavior) =>
      registries.behaviors.register(behavior),
    ),
  ];
}
