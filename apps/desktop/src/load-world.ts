import { registerBuiltInContent } from "@living-diorama/built-in-content";
import type { Diagnostic, WorldDefinition } from "@living-diorama/content-schema";
import { createRegistries, resolveReferences } from "@living-diorama/extension-api";
import {
  checkWorld,
  describeScene,
  registerCoreEngine,
  type SceneData,
} from "@living-diorama/simulation";

export const WORLD_ID = "hollow:woodland-hollow";

/**
 * Composition root for content: engine entries, then the built-in pack, then reference
 * resolution and the world checks. Returns scene data for the renderer, or the diagnostics.
 */
export function loadWorld(): { scene?: SceneData; diagnostics: Diagnostic[] } {
  const registries = createRegistries();
  const results = [...registerCoreEngine(registries), ...registerBuiltInContent(registries)];
  const diagnostics = [
    ...results.flatMap((r) => (r.ok ? [] : r.diagnostics)),
    ...resolveReferences(registries).diagnostics,
  ];
  const world = registries.worlds.get(WORLD_ID) as WorldDefinition | undefined;
  if (!world || diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  const check = checkWorld(world, registries);
  diagnostics.push(...check.diagnostics);
  if (!check.model || diagnostics.some((d) => d.severity === "error")) return { diagnostics };
  return { scene: describeScene(check.model), diagnostics };
}
