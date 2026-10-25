import type { z } from "zod";
import { SCHEMA_VERSIONS, type DefinitionKind } from "./constants";
import {
  CreatureInstanceSchema,
  SpeciesDefinitionSchema,
  StructureDefinitionSchema,
  WorldDefinitionSchema,
  type CreatureInstance,
  type SpeciesDefinition,
  type StructureDefinition,
  type WorldDefinition,
} from "./definitions";
import { error, fromZodIssues, type Result } from "./diagnostics";

/** Any content schema. Lets other packages hold schemas without depending on Zod. */
export type Schema<T = unknown> = z.ZodType<T>;

export function validate<T>(schema: Schema<T>, input: unknown, source?: string): Result<T> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, diagnostics: fromZodIssues(parsed.error.issues, source) };
}

/** Rejects unsupported schema versions with one clear diagnostic before shape validation. */
function checkSchemaVersion(kind: DefinitionKind, input: unknown, source?: string) {
  if (typeof input !== "object" || input === null || !("schemaVersion" in input)) return undefined;
  const found = input.schemaVersion;
  const supported = SCHEMA_VERSIONS[kind];
  if (found === supported) return undefined;
  return error(
    "unsupported_schema_version",
    `${kind} schema version ${JSON.stringify(found)} is not supported (supported: ${supported})`,
    ["schemaVersion"],
    source,
  );
}

function parseDefinition<T>(
  kind: DefinitionKind,
  schema: Schema<T>,
  input: unknown,
  source?: string,
): Result<T> {
  const versionError = checkSchemaVersion(kind, input, source);
  return versionError
    ? { ok: false, diagnostics: [versionError] }
    : validate(schema, input, source);
}

export const parseWorldDefinition = (input: unknown, source?: string): Result<WorldDefinition> =>
  parseDefinition("world", WorldDefinitionSchema, input, source);

export const parseStructureDefinition = (
  input: unknown,
  source?: string,
): Result<StructureDefinition> =>
  parseDefinition("structure", StructureDefinitionSchema, input, source);

export const parseSpeciesDefinition = (
  input: unknown,
  source?: string,
): Result<SpeciesDefinition> => parseDefinition("species", SpeciesDefinitionSchema, input, source);

export const parseCreatureInstance = (input: unknown, source?: string): Result<CreatureInstance> =>
  validate(CreatureInstanceSchema, input, source);
