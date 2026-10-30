import {
  checkAssemblyFit,
  error,
  isContentId,
  LOCOMOTION_MEDIA,
  REGION_KINDS,
  parsePartTypeDefinition,
  parsePropCategoryDefinition,
  parseSocketTypeDefinition,
  parsePropDefinition,
  parseSpeciesDefinition,
  parseStructureDefinition,
  parseWorldDefinition,
  validate,
  type Affordances,
  type BodyShape,
  type ContentId,
  type Diagnostic,
  type DiagnosticPath,
  type LocomotionMedium,
  type PartTypeDefinition,
  type PropCategoryDefinition,
  type PropDefinition,
  type RegionKind,
  type Result,
  type Schema,
  type SocketTypeDefinition,
  type SpeciesDefinition,
  type StructureDefinition,
  type VoxelAssembly,
  type WorldDefinition,
} from "@living-diorama/content-schema";
import semver from "semver";
import { Registry, type Lookup, type Reference, type RegistryEntry } from "./registry";

export const REGISTRY_NAMES = [
  "worlds",
  "structures",
  "props",
  "propCategories",
  "partTypes",
  "socketTypes",
  "species",
  "surfaces",
  "actions",
  "behaviors",
  "capabilities",
  "affordances",
  "assets",
  "needs",
  "senses",
  "traits",
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

/**
 * Visible cues the renderer knows how to show without knowing any content ID (ADR 0018 §15).
 * Actions show what a creature is doing and needs what it lacks, so each has its own list.
 */
export const ACTION_CUES = ["eating", "sleeping"] as const;
export type ActionCue = (typeof ACTION_CUES)[number];
export const NEED_CUES = ["hungry"] as const;
export type NeedCue = (typeof NEED_CUES)[number];
export type Cue = ActionCue | NeedCue;

export interface ActionType extends CodeEntry {
  /** What the creature shows while doing the action and not walking. */
  readonly cue?: ActionCue;
}
export type BehaviorType = CodeEntry;

/**
 * An affordance a structure or prop can offer, e.g. `core:crossable` (ADR 0005 §2) or `core:food`
 * (ADR 0018 §2). Where it is offered, its params are validated against `paramsSchema`.
 */
export interface AffordanceType extends CodeEntry {
  readonly paramsSchema: Schema;
  /** How many places offering it a creature remembers at most. Not remembered if omitted. */
  readonly remember?: number;
}

/**
 * A need such as `core:hunger` (ADR 0018 §1). Its value runs from 0 (met) to 1 (pressing) and
 * changes on its own at the declared rates; actions change it further.
 */
export interface NeedType extends CodeEntry {
  /** Change per hour of simulation time, awake and asleep. Negative falls, e.g. tiredness asleep. */
  readonly perHour: { readonly awake: number; readonly asleep: number };
  /** The value from which a creature starts to act on the need. */
  readonly actAt: number;
  /** Values that start a decision when the need rises across them. Ascending, and includes `actAt`. */
  readonly triggers: readonly number[];
  /**
   * A spawned creature starts with a value drawn uniformly below this, at most `actAt`; default
   * `actAt`, so creatures spawned together don't all act at once.
   */
  readonly startBelow?: number;
  /** A cue the creature shows from the given value, e.g. `"hungry"` from 0.8. */
  readonly cue?: { readonly cue: NeedCue; readonly from: number };
  /** What happens while the need is at 1, e.g. walking at 80% speed. */
  readonly atMax?: { readonly speedFactor?: number };
  /** A trait whose value scales both rates, e.g. `core:appetite` for hunger. */
  readonly rateTrait?: string;
  /** Each individual's rates are scaled by a factor drawn once in [1 − variation, 1 + variation]. */
  readonly variation?: number;
}

/** A numeric value a species can declare, with its range and the value used when omitted. */
export interface RangedEntry extends CodeEntry {
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** Values must be whole numbers, e.g. `core:nocturnal` 0 or 1. */
  readonly integer?: boolean;
}

/** A sense, e.g. `core:vision` with its range in metres. A species without it lacks the sense. */
export interface SenseType extends RangedEntry {
  /** Each individual's value is scaled by a factor drawn once in [1 − variation, 1 + variation]. */
  readonly variation?: number;
}
/** A trait, e.g. `core:nocturnal`. A species without it has the default. */
export type TraitType = RangedEntry;

/**
 * Where a locomotion capability's animation profile comes from (ADR 0020 §8): a profile name such
 * as `"swim"`, or `{ fromStyle: "land" }` to use the species' style in that medium, its land gait
 * (`walk` or `hop`, each a profile of the same name). The renderer draws an unknown profile with
 * no motion.
 */
export type AnimationSource = string | { readonly fromStyle: LocomotionMedium };

/** Where and how a locomotion capability moves a creature (ADR 0005 §3, ADR 0020 §8–§9). */
export interface LocomotionRule {
  /** Region kinds this locomotion works in, e.g. `["land", "cave"]` for walking. */
  readonly regionKinds: readonly RegionKind[];
  /** Steepest walkable surface in degrees. No limit if omitted. */
  readonly maxSlopeDeg?: number;
  /** The animation profile while moving this way. No motion if omitted. */
  readonly animation?: AnimationSource;
  /**
   * How far the body sits below the surface while moving this way, as a share of its height from
   * 0 to 1. 0 if omitted.
   */
  readonly submersion?: number;
}

/**
 * The animation profile of a creature of a species with `body` while it moves by `rule`, or
 * undefined for none (ADR 0020 §8).
 */
export function animationProfile(rule: LocomotionRule, body: BodyShape): string | undefined {
  const source = rule.animation;
  if (source === undefined || typeof source === "string") return source;
  const medium = source.fromStyle;
  switch (medium) {
    case "land":
      return body.locomotion.land.gait;
    default: {
      // A new medium must say here which of the species' styles gives its profile.
      const unhandled: never = medium;
      throw new Error(`No animation profile for the style of medium "${String(unhandled)}"`);
    }
  }
}

/**
 * How far below the surface a creature sits while it moves by `rule`, as a share of its body's
 * height (ADR 0020 §9). The one place submersion is read, so that when it can come from the
 * species' style in a medium (a fish deeper than a floater), as `animation` can, it takes the
 * species' body here and nothing else changes.
 */
export function locomotionSubmersion(rule: LocomotionRule): number {
  return rule.submersion ?? 0;
}

/** A capability species can have and connections can require, e.g. `core:land`. */
export interface CapabilityType extends CodeEntry {
  /** Present when the capability is a way of moving. */
  readonly locomotion?: LocomotionRule;
}

export const ASSET_KINDS = ["image", "model"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * A file content refers to, e.g. `hollow:models/pine.glb` (ADR 0007 §1). The ID is the asset ref
 * itself; the pack decides where the file is served from.
 */
export interface AssetEntry extends CodeEntry {
  readonly kind: AssetKind;
  /** Where the file is served from, e.g. `new URL("./pine.glb", import.meta.url).href`. */
  readonly url: string;
  /** Metres per model unit, for models authored in another unit. 1 if omitted. */
  readonly scale?: number;
}

/**
 * The registries: roadmap M1 task 4, capabilities and affordances (ADR 0005), assets (ADR 0007),
 * prop types, needs, senses and traits (ADR 0018), prop categories (ADR 0021), voxel part types
 * and socket types (ADR 0022 §10).
 */
export interface Registries {
  worlds: Registry<WorldDefinition>;
  structures: Registry<StructureDefinition>;
  props: Registry<PropDefinition>;
  propCategories: Registry<PropCategoryDefinition>;
  partTypes: Registry<PartTypeDefinition>;
  socketTypes: Registry<SocketTypeDefinition>;
  species: Registry<SpeciesDefinition>;
  surfaces: Registry<SurfaceType>;
  actions: Registry<ActionType>;
  behaviors: Registry<BehaviorType>;
  capabilities: Registry<CapabilityType>;
  affordances: Registry<AffordanceType>;
  assets: Registry<AssetEntry>;
  needs: Registry<NeedType>;
  senses: Registry<SenseType>;
  traits: Registry<TraitType>;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isShare = (value: unknown): value is number =>
  isFiniteNumber(value) && value > 0 && value <= 1;

function validateAffordance(entry: AffordanceType, source: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  if (typeof entry.paramsSchema?.safeParse !== "function") {
    found.push(error("invalid_type", "Expected a params schema", ["paramsSchema"], source));
  }
  const remember = entry.remember;
  if (remember !== undefined && !(Number.isInteger(remember) && remember > 0)) {
    found.push(error("invalid_value", "remember must be a positive integer", ["remember"], source));
  }
  return found;
}

function validateNeed(entry: NeedType, source: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const key of ["awake", "asleep"] as const) {
    if (!isFiniteNumber(entry.perHour?.[key])) {
      found.push(
        error("invalid_type", `Expected the change per hour ${key}`, ["perHour", key], source),
      );
    }
  }
  if (!isShare(entry.actAt)) {
    found.push(error("invalid_value", "actAt must be a number in (0, 1]", ["actAt"], source));
  }
  if (entry.startBelow !== undefined && !isShare(entry.startBelow)) {
    found.push(
      error("invalid_value", "startBelow must be a number in (0, 1]", ["startBelow"], source),
    );
  } else if (
    entry.startBelow !== undefined &&
    isShare(entry.actAt) &&
    entry.startBelow > entry.actAt
  ) {
    found.push(error("invalid_value", "startBelow must be at most actAt", ["startBelow"], source));
  }
  if (!Array.isArray(entry.triggers)) {
    found.push(error("invalid_type", "Expected a list of trigger values", ["triggers"], source));
  } else {
    entry.triggers.forEach((value, i) => {
      if (!isShare(value)) {
        found.push(
          error("invalid_value", "A trigger must be a number in (0, 1]", ["triggers", i], source),
        );
      } else if (i > 0 && !(value > (entry.triggers[i - 1] ?? 0))) {
        found.push(
          error("invalid_value", "Triggers must be in ascending order", ["triggers", i], source),
        );
      }
    });
    if (isShare(entry.actAt) && !entry.triggers.includes(entry.actAt)) {
      found.push(error("invalid_value", "Triggers must include actAt", ["triggers"], source));
    }
  }
  if (entry.cue !== undefined && (typeof entry.cue !== "object" || entry.cue === null)) {
    found.push(error("invalid_type", "Expected a cue like { cue, from }", ["cue"], source));
  } else if (entry.cue !== undefined) {
    if (!(NEED_CUES as readonly unknown[]).includes(entry.cue.cue)) {
      found.push(
        error(
          "invalid_value",
          `Unknown need cue "${String(entry.cue.cue)}" (expected one of ${NEED_CUES.join(", ")})`,
          ["cue", "cue"],
          source,
        ),
      );
    }
    if (!isShare(entry.cue.from)) {
      found.push(
        error("invalid_value", "A cue's from must be a number in (0, 1]", ["cue", "from"], source),
      );
    }
  }
  const speedFactor = entry.atMax?.speedFactor;
  if (speedFactor !== undefined && !isShare(speedFactor)) {
    found.push(
      error(
        "invalid_value",
        "speedFactor must be a number in (0, 1]",
        ["atMax", "speedFactor"],
        source,
      ),
    );
  }
  if (entry.rateTrait !== undefined && !isContentId(entry.rateTrait)) {
    found.push(
      error(
        "invalid_format",
        'Expected a namespaced content ID like "core:appetite"',
        ["rateTrait"],
        source,
      ),
    );
  }
  found.push(...validateVariation(entry.variation, source));
  return found;
}

function validateVariation(variation: unknown, source: string): Diagnostic[] {
  return variation === undefined || (isFiniteNumber(variation) && variation >= 0 && variation < 1)
    ? []
    : [error("invalid_value", "variation must be a number in [0, 1)", ["variation"], source)];
}

function validateAction(entry: ActionType, source: string): Diagnostic[] {
  if (entry.cue === undefined || (ACTION_CUES as readonly unknown[]).includes(entry.cue)) return [];
  return [
    error(
      "invalid_value",
      `Unknown action cue "${String(entry.cue)}" (expected one of ${ACTION_CUES.join(", ")})`,
      ["cue"],
      source,
    ),
  ];
}

function validateRanged(entry: RangedEntry, source: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const key of ["default", "min", "max"] as const) {
    if (!isFiniteNumber(entry[key])) {
      found.push(error("invalid_type", `Expected a number for ${key}`, [key], source));
    }
  }
  if (entry.integer !== undefined && typeof entry.integer !== "boolean") {
    found.push(error("invalid_type", "integer must be true or false", ["integer"], source));
  }
  if (found.length > 0) return found;
  if (entry.integer === true && !Number.isInteger(entry.default)) {
    found.push(error("invalid_value", "default must be a whole number", ["default"], source));
  }
  if (!(entry.min <= entry.default && entry.default <= entry.max)) {
    found.push(
      error(
        "invalid_value",
        `default must lie in [min, max], here [${entry.min}, ${entry.max}]`,
        ["default"],
        source,
      ),
    );
  }
  return found;
}

/** A non-blank profile name, or exactly `{ fromStyle }` naming a medium of the body plan. */
function isAnimationSource(value: unknown): value is AnimationSource {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 &&
    keys[0] === "fromStyle" &&
    (LOCOMOTION_MEDIA as readonly unknown[]).includes((value as { fromStyle: unknown }).fromStyle)
  );
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
  if (rule.animation !== undefined && !isAnimationSource(rule.animation)) {
    found.push(
      error(
        "invalid_value",
        `animation must be a profile name or { fromStyle } with one of ${LOCOMOTION_MEDIA.join(", ")}`,
        ["locomotion", "animation"],
        source,
      ),
    );
  }
  const submersion = rule.submersion;
  if (
    submersion !== undefined &&
    !(isFiniteNumber(submersion) && submersion >= 0 && submersion <= 1)
  ) {
    found.push(
      error(
        "invalid_value",
        "submersion must be a number in [0, 1]",
        ["locomotion", "submersion"],
        source,
      ),
    );
  }
  return found;
}

function validateAsset(entry: AssetEntry, source: string): Diagnostic[] {
  const found: Diagnostic[] = [];
  if (!ASSET_KINDS.includes(entry.kind)) {
    found.push(
      error(
        "invalid_value",
        `Unknown asset kind "${String(entry.kind)}" (expected one of ${ASSET_KINDS.join(", ")})`,
        ["kind"],
        source,
      ),
    );
  }
  if (typeof entry.url !== "string" || entry.url.length === 0) {
    found.push(error("invalid_type", "Expected the asset's URL", ["url"], source));
  }
  if (entry.scale !== undefined && !(typeof entry.scale === "number" && entry.scale > 0)) {
    found.push(error("invalid_value", "scale must be a positive number", ["scale"], source));
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

/** A reference to an asset, optionally of one kind (a prop needs a model). */
function assetReference(id: string, path: DiagnosticPath, kind?: AssetKind): Reference {
  if (kind === undefined) return { registry: "assets", id, path };
  return {
    registry: "assets",
    id,
    path,
    check: (target) => {
      const actual = (target as AssetEntry).kind;
      return actual === kind
        ? []
        : [error("invalid_value", `"${id}" is an asset of kind ${actual}, expected ${kind}`, path)];
    },
  };
}

function worldReferences(world: WorldDefinition): Reference[] {
  const refs: Reference[] = world.structures.map((s, i) => ({
    registry: "structures",
    id: s.structure,
    path: ["structures", i, "structure"],
  }));
  world.props.forEach((prop, i) =>
    refs.push({ registry: "props", id: prop.prop, path: ["props", i, "prop"] }),
  );
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

/** References from a species' sense or trait map, each value checked against the entry's range. */
const rangedReferences = (
  registry: "senses" | "traits",
  values: Record<string, number>,
): Reference[] =>
  Object.entries(values).map(([id, value]) => {
    const path = [registry, id];
    return {
      registry,
      id,
      path,
      check: (target) => {
        const { min, max, integer } = target as RangedEntry;
        if (integer === true && !Number.isInteger(value)) {
          return [error("invalid_value", `"${id}" is ${value}, expected a whole number`, path)];
        }
        return value >= min && value <= max
          ? []
          : [
              error(
                "invalid_value",
                `"${id}" is ${value}, outside its range [${min}, ${max}]`,
                path,
              ),
            ];
      },
    };
  });

const speciesReferences = (species: SpeciesDefinition): Reference[] => [
  assetReference(species.appearance, ["appearance"]),
  ...species.behaviors.map((id, i) => ({ registry: "behaviors", id, path: ["behaviors", i] })),
  ...Object.keys(species.capabilities).map((id) => ({
    registry: "capabilities",
    id,
    path: ["capabilities", id],
  })),
  ...rangedReferences("senses", species.senses),
  ...rangedReferences("traits", species.traits),
];

/**
 * A species needs a way of moving (ADR 0020 §1): at least one of its capabilities must have a
 * locomotion rule. Unregistered capabilities are left to reference resolution.
 */
function checkSpeciesLocomotion(species: SpeciesDefinition, lookup: Lookup): Diagnostic[] {
  const found = Object.keys(species.capabilities).map(
    (id) => lookup("capabilities", id) as CapabilityType | undefined,
  );
  if (found.some((capability) => capability === undefined || capability.locomotion !== undefined)) {
    return [];
  }
  return [
    error(
      "no_locomotion",
      "A species needs at least one way of moving: a capability with a locomotion rule",
      ["capabilities"],
    ),
  ];
}

/** References from an affordance map, each entry's params checked against the type's schema. */
const affordanceReferences = (affordances: Affordances): Reference[] =>
  Object.entries(affordances).map(([id, params]) => {
    const path = ["affordances", id];
    return {
      registry: "affordances",
      id,
      path,
      check: (target) => {
        const result = validate((target as AffordanceType).paramsSchema, params);
        return result.ok
          ? []
          : result.diagnostics.map((d) => ({ ...d, path: [...path, ...d.path] }));
      },
    };
  });

const structureReferences = (structure: StructureDefinition): Reference[] => [
  ...affordanceReferences(structure.affordances),
  ...structure.visualAssets.map((id, i) => assetReference(id, ["visualAssets", i])),
];

const propReferences = (prop: PropDefinition): Reference[] => [
  assetReference(prop.model, ["model"], "model"),
  ...affordanceReferences(prop.affordances),
  ...(prop.category === undefined
    ? []
    : [{ registry: "propCategories", id: prop.category, path: ["category"] }]),
];

/**
 * The registered prop categories in the order an editor shows them (ADR 0021): ascending `order`,
 * then by ID, so packs that pick the same order still list the same way every time. Prop types
 * without a category belong to none of them; an editor lists those under "Other".
 */
export function sortedPropCategories(registries: Registries): PropCategoryDefinition[] {
  return registries.propCategories.values().sort((a, b) => a.order - b.order || byId(a, b));
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The registered voxel part types, by ID. */
export const sortedPartTypes = (registries: Registries): PartTypeDefinition[] =>
  registries.partTypes.values().sort(byId);

/** The registered socket types, by ID. */
export const sortedSocketTypes = (registries: Registries): SocketTypeDefinition[] =>
  registries.socketTypes.values().sort(byId);

/**
 * Whether a part of type `partType` fits a socket of type `socketType` (ADR 0022 §9): the part
 * type is registered and lists the socket type.
 */
export const partFitsSocket = (
  registries: Registries,
  partType: string,
  socketType: string,
): boolean => registries.partTypes.get(partType)?.fits.includes(socketType) ?? false;

/**
 * The checks a voxel assembly must pass when its creature is released, against the registered
 * part and socket types (`checkAssemblyFit`). Loading a released creature doesn't need them.
 */
export const checkAssemblyTypes = (
  registries: Registries,
  assembly: VoxelAssembly,
  source?: string,
): Diagnostic[] =>
  checkAssemblyFit(
    assembly,
    {
      partType: (id) => registries.partTypes.get(id),
      socketType: (id) => registries.socketTypes.get(id),
    },
    source,
  );

export function createRegistries(): Registries {
  return {
    worlds: new Registry("worlds", { validate: parseWorldDefinition, references: worldReferences }),
    structures: new Registry("structures", {
      validate: parseStructureDefinition,
      references: structureReferences,
    }),
    props: new Registry("props", { validate: parsePropDefinition, references: propReferences }),
    propCategories: new Registry("propCategories", { validate: parsePropCategoryDefinition }),
    partTypes: new Registry("partTypes", {
      validate: parsePartTypeDefinition,
      references: (partType) =>
        partType.fits.map((id, i) => ({ registry: "socketTypes", id, path: ["fits", i] })),
    }),
    socketTypes: new Registry("socketTypes", { validate: parseSocketTypeDefinition }),
    species: new Registry("species", {
      validate: parseSpeciesDefinition,
      references: speciesReferences,
      check: checkSpeciesLocomotion,
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
      validate: validateCodeEntry<ActionType>(validateAction),
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
      validate: validateCodeEntry<AffordanceType>(validateAffordance),
      references: dependencyReferences,
    }),
    assets: new Registry<AssetEntry>("assets", {
      validate: validateCodeEntry<AssetEntry>(validateAsset),
      references: dependencyReferences,
    }),
    needs: new Registry<NeedType>("needs", {
      validate: validateCodeEntry<NeedType>(validateNeed),
      references: (need) => [
        ...dependencyReferences(need),
        ...(need.rateTrait === undefined
          ? []
          : [{ registry: "traits", id: need.rateTrait, path: ["rateTrait"] }]),
      ],
    }),
    senses: new Registry<SenseType>("senses", {
      validate: validateCodeEntry<SenseType>((entry, source) => [
        ...validateRanged(entry, source),
        ...validateVariation(entry.variation, source),
      ]),
      references: dependencyReferences,
    }),
    traits: new Registry<TraitType>("traits", {
      validate: validateCodeEntry<TraitType>(validateRanged),
      references: dependencyReferences,
    }),
  };
}
