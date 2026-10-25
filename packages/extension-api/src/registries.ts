import {
  error,
  isContentId,
  REGION_KINDS,
  parseSpeciesDefinition,
  parseStructureDefinition,
  parseWorldDefinition,
  validate,
  type ContentId,
  type Diagnostic,
  type RegionKind,
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
  "capabilities",
  "affordances",
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
/** An affordance a structure can offer, e.g. `core:crossable` (ADR 0005 §2). */
export type AffordanceType = CodeEntry;

/** Where and how a locomotion capability moves a creature (ADR 0005 §3). */
export interface LocomotionRule {
  /** Region kinds this locomotion works in, e.g. `["land", "cave"]` for walking. */
  readonly regionKinds: readonly RegionKind[];
  /** Steepest walkable surface in degrees. No limit if omitted. */
  readonly maxSlopeDeg?: number;
}

/** A capability species can have and connections can require, e.g. `core:walk`. */
export interface CapabilityType extends CodeEntry {
  /** Present when the capability is a way of moving. */
  readonly locomotion?: LocomotionRule;
}

/** The v1 registries (roadmap M1 task 4, plus capabilities and affordances from ADR 0005). */
export interface Registries {
  worlds: Registry<WorldDefinition>;
  structures: Registry<StructureDefinition>;
  species: Registry<SpeciesDefinition>;
  surfaces: Registry<SurfaceType>;
  actions: Registry<ActionType>;
  behaviors: Registry<BehaviorType>;
  capabilities: Registry<CapabilityType>;
  affordances: Registry<AffordanceType>;
}

function validateLocomotion(entry: CapabilityType, source: string): Diagnostic[] {
  const rule = entry.locomotion;
  if (rule === undefined) return [];
  const found: Diagnostic[] = [];
  if (!Array.isArray(rule.regionKinds) || rule.regionKinds.length === 0) {
    found.push(
      error(
        "invalid_value",
        "A locomotion rule needs at least one region kind",
        ["locomotion", "regionKinds"],
        source,
      ),
    );
  } else {
    rule.regionKinds.forEach((kind, i) => {
      if (!REGION_KINDS.includes(kind)) {
        found.push(
          error(
            "invalid_value",
            `Unknown region kind "${String(kind)}" (expected one of ${REGION_KINDS.join(", ")})`,
            ["locomotion", "regionKinds", i],
            source,
          ),
        );
      }
    });
  }
  const slope = rule.maxSlopeDeg;
  if (slope !== undefined && !(typeof slope === "number" && slope > 0 && slope <= 90)) {
    found.push(
      error(
        "invalid_value",
        "maxSlopeDeg must be a number in (0, 90]",
        ["locomotion", "maxSlopeDeg"],
        source,
      ),
    );
  }
  return found;
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
  const connections = [
    ...world.connections.map((connection, i) => ({ connection, path: ["connections", i] })),
    ...world.structures.flatMap((s, si) =>
      s.connections.map((connection, i) => ({
        connection,
        path: ["structures", si, "connections", i],
      })),
    ),
  ];
  for (const { connection, path } of connections) {
    connection.requiredCapabilities.forEach((id, i) =>
      refs.push({ registry: "capabilities", id, path: [...path, "requiredCapabilities", i] }),
    );
  }
  return refs;
}

const speciesReferences = (species: SpeciesDefinition): Reference[] => [
  ...species.behaviors.map((id, i) => ({ registry: "behaviors", id, path: ["behaviors", i] })),
  ...Object.keys(species.capabilities).map((id) => ({
    registry: "capabilities",
    id,
    path: ["capabilities", id],
  })),
];

const structureReferences = (structure: StructureDefinition): Reference[] =>
  structure.affordances.map((id, i) => ({
    registry: "affordances",
    id,
    path: ["affordances", i],
  }));

export function createRegistries(): Registries {
  return {
    worlds: new Registry("worlds", { validate: parseWorldDefinition, references: worldReferences }),
    structures: new Registry("structures", {
      validate: parseStructureDefinition,
      references: structureReferences,
    }),
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
    capabilities: new Registry<CapabilityType>("capabilities", {
      validate: validateCodeEntry<CapabilityType>(validateLocomotion),
      references: dependencyReferences,
    }),
    affordances: new Registry<AffordanceType>("affordances", {
      validate: validateCodeEntry(),
      references: dependencyReferences,
    }),
  };
}
