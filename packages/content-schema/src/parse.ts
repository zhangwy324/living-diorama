import type { z } from "zod";
import { SCHEMA_VERSIONS, WORLD_SAVE_SCHEMA_VERSION, type DefinitionKind } from "./constants";
import {
  PropDefinitionSchema,
  SpeciesDefinitionSchema,
  StructureDefinitionSchema,
  WorldDefinitionSchema,
  type PropDefinition,
  type SpeciesDefinition,
  type StructureDefinition,
  type WorldDefinition,
} from "./definitions";
import { error, fromZodIssues, type Result } from "./diagnostics";
import { WorldSaveSchema, type WorldSave } from "./save";

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

export const parsePropDefinition = (input: unknown, source?: string): Result<PropDefinition> =>
  parseDefinition("prop", PropDefinitionSchema, input, source);

export const parseSpeciesDefinition = (
  input: unknown,
  source?: string,
): Result<SpeciesDefinition> => parseDefinition("species", SpeciesDefinitionSchema, input, source);

/**
 * Validates a world save. A save of another schema version gets one clear diagnostic
 * (`unsupported_save_version`) and is never migrated: the caller discards it (ADR 0019).
 */
export function parseWorldSave(input: unknown, source?: string): Result<WorldSave> {
  if (typeof input === "object" && input !== null && "schemaVersion" in input) {
    const found = input.schemaVersion;
    if (found !== WORLD_SAVE_SCHEMA_VERSION) {
      const message = `World save version ${JSON.stringify(found)} is not supported (supported: ${WORLD_SAVE_SCHEMA_VERSION})`;
      return {
        ok: false,
        diagnostics: [error("unsupported_save_version", message, ["schemaVersion"], source)],
      };
    }
  }
  return validate(WorldSaveSchema, input, source);
}
