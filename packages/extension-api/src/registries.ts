import {
  error,
  isContentId,
  parseSpeciesDefinition,
  parseStructureDefinition,
  parseWorldDefinition,
  validate,
  type ContentId,
  type Diagnostic,
  type Result,
  type Schema,
  type SpeciesDefinition,
  type StructureDefinition,
  type WorldDefinition,
} from "@living-diorama/content-schema";
import semver from "semver";
import { Registry, type Reference, type RegistryEntry } from "./registry";

export const REGISTRY_NAMES = [
  "worlds",
  "structures",
  "species",
  "surfaces",
  "actions",
  "behaviors",
] as const;
export type RegistryName = (typeof REGISTRY_NAMES)[number];

/** Explicit dependency of a code entry on another registry entry. */
export interface Dependency {
  registry: RegistryName;
  id: ContentId;
  /** Semver range, e.g. `^1.0.0`. Any version if omitted. */
  version?: string;
}

/** Entries backed by engine code (surfaces, actions, behaviors) rather than JSON content. */
export interface CodeEntry extends RegistryEntry {
  readonly dependencies?: readonly Dependency[];
}

/** A surface type; region surface params are validated against `paramsSchema`. */
export interface SurfaceType extends CodeEntry {
  readonly paramsSchema: Schema;
}

export type ActionType = CodeEntry;
export type BehaviorType = CodeEntry;

/** The v1 registries (roadmap M1 task 4). */
export interface Registries {
  worlds: Registry<WorldDefinition>;
  structures: Registry<StructureDefinition>;
  species: Registry<SpeciesDefinition>;
  surfaces: Registry<SurfaceType>;
  actions: Registry<ActionType>;
  behaviors: Registry<BehaviorType>;
}

function validateCodeEntry<T extends CodeEntry>(
  extra?: (entry: T, source: string) => Diagnostic[],
): (input: unknown, source: string) => Result<T> {
  return (input, source) => {
    const found: Diagnostic[] = [];
    if (typeof input !== "object" || input === null) {
      return { ok: false, diagnostics: [error("invalid_type", "Expected an object", [], source)] };
    }
    const entry = input as T;
    if (typeof entry.id !== "string" || !isContentId(entry.id)) {
      found.push(
        error(
          "invalid_format",
          'Expected a namespaced content ID like "core:wander"',
          ["id"],
          source,
        ),
      );
    }
    if (typeof entry.version !== "string" || semver.valid(entry.version) === null) {
      found.push(
        error("invalid_format", 'Expected a semantic version like "1.0.0"', ["version"], source),
      );
    }
    (entry.dependencies ?? []).forEach((dep, i) => {
      if (!REGISTRY_NAMES.includes(dep.registry)) {
        found.push(
          error(
            "invalid_value",
            `Unknown registry "${dep.registry}" (expected one of ${REGISTRY_NAMES.join(", ")})`,
            ["dependencies", i, "registry"],
            source,
          ),
        );
      }
      if (!isContentId(dep.id)) {
        found.push(
          error(
            "invalid_format",
            'Expected a namespaced content ID like "core:idle"',
            ["dependencies", i, "id"],
            source,
          ),
        );
      }
      if (dep.version !== undefined && semver.validRange(dep.version) === null) {
        found.push(
          error(
            "invalid_format",
            `"${dep.version}" is not a valid semver range`,
            ["dependencies", i, "version"],
            source,
          ),
        );
      }
    });
    found.push(...(extra?.(entry, source) ?? []));
    return found.length > 0 ? { ok: false, diagnostics: found } : { ok: true, value: entry };
  };
}

const dependencyReferences = (entry: CodeEntry): Reference[] =>
  (entry.dependencies ?? []).map((dep, i) => ({
    registry: dep.registry,
    id: dep.id,
    ...(dep.version === undefined ? {} : { versionRange: dep.version }),
    path: ["dependencies", i],
  }));

function worldReferences(world: WorldDefinition): Reference[] {
  const refs: Reference[] = world.structures.map((s, i) => ({
    registry: "structures",
    id: s.structure,
    path: ["structures", i, "structure"],
  }));
  const regions = [
    ...world.regions.map((region, i) => ({ region, regionPath: ["regions", i] })),
    ...world.structures.flatMap((s, si) =>
      s.regions.map((region, i) => ({ region, regionPath: ["structures", si, "regions", i] })),
    ),
  ];
  for (const { region, regionPath } of regions) {
    refs.push({
      registry: "surfaces",
      id: region.surface.type,
      path: [...regionPath, "surface", "type"],
      check: (target) => {
        const result = validate((target as SurfaceType).paramsSchema, region.surface.params);
        if (result.ok) return [];
        return result.diagnostics.map((d) => ({
          ...d,
          path: [...regionPath, "surface", "params", ...d.path],
        }));
      },
    });
  }
  return refs;
}

const speciesReferences = (species: SpeciesDefinition): Reference[] =>
  species.behaviors.map((id, i) => ({ registry: "behaviors", id, path: ["behaviors", i] }));

export function createRegistries(): Registries {
  return {
    worlds: new Registry("worlds", { validate: parseWorldDefinition, references: worldReferences }),
    structures: new Registry("structures", { validate: parseStructureDefinition }),
    species: new Registry("species", {
      validate: parseSpeciesDefinition,
      references: speciesReferences,
    }),
    surfaces: new Registry<SurfaceType>("surfaces", {
      validate: validateCodeEntry<SurfaceType>((entry, source) =>
        typeof entry.paramsSchema?.safeParse === "function"
          ? []
          : [error("invalid_type", "Expected a params schema", ["paramsSchema"], source)],
      ),
      references: dependencyReferences,
    }),
    actions: new Registry<ActionType>("actions", {
      validate: validateCodeEntry(),
      references: dependencyReferences,
    }),
    behaviors: new Registry<BehaviorType>("behaviors", {
      validate: validateCodeEntry(),
      references: dependencyReferences,
    }),
  };
}
