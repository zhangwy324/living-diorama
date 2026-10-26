import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  error,
  type Diagnostic,
  type Result,
  type WorldDefinition,
} from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  checkWorld,
  describeNavigation,
  describeScene,
  profileForSpecies,
  registerCoreEngine,
  type NavigationOverlay,
  type SceneData,
} from "@living-diorama/simulation";

export const WORLD_ID = "hollow:woodland-hollow";
export const SPECIES_ID = "hollow:mossling";

/** Composition root for content: engine entries, then the built-in pack, then reference resolution. */
function register(): { registries: Registries; diagnostics: Diagnostic[] } {
  const registries = createRegistries();
  const results = [...registerCoreEngine(registries), ...registerBuiltInContent(registries)];
  const diagnostics = [
    ...results.flatMap((r) => (r.ok ? [] : r.diagnostics)),
    ...resolveReferences(registries).diagnostics,
  ];
  return { registries, diagnostics };
}

const hasErrors = (diagnostics: Diagnostic[]) => diagnostics.some((d) => d.severity === "error");

/** The registries the simulation worker runs on. */
export function loadContent(): Result<Registries> {
  const { registries, diagnostics } = register();
  return hasErrors(diagnostics) ? { ok: false, diagnostics } : { ok: true, value: registries };
}

/**
 * Loads content and runs the world checks. Returns scene data, the spawned species' navigation
 * overlay and the registered assets and species for the renderer, or the diagnostics.
 */
export function loadWorld(): {
  scene?: SceneData;
  navigation?: NavigationOverlay;
  assets?: Registries["assets"];
  species?: Registries["species"];
  diagnostics: Diagnostic[];
} {
  const { registries, diagnostics } = register();
  if (hasErrors(diagnostics)) return { diagnostics };
  const world = registries.worlds.get(WORLD_ID) as WorldDefinition | undefined;
  if (!world) {
    return { diagnostics: [error("unknown_world", `World "${WORLD_ID}" is not registered`)] };
  }
  const check = checkWorld(world, registries);
  diagnostics.push(...check.diagnostics);
  if (!check.model || hasErrors(diagnostics)) return { diagnostics };
  const spawned = registries.species.get(SPECIES_ID);
  const profile = spawned && profileForSpecies(spawned, registries);
  const navigation = check.navigations.find((n) => n.profile.key === profile?.key);
  return {
    scene: describeScene(check.model),
    ...(navigation ? { navigation: describeNavigation(check.model, navigation) } : {}),
    assets: registries.assets,
    species: registries.species,
    diagnostics,
  };
}
