import { error, type Result } from "./diagnostics";

/** Upgrades a file by one schema version. */
export type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

/**
 * Brings a file's data up to `current`, the version this build reads. `migrations[n]` turns
 * version `n` into `n + 1`. A file from a newer build, or without a version, is an error: guessing
 * would lose data the newer build wrote.
 */
export function migrate(
  kind: string,
  input: unknown,
  current: number,
  migrations: Readonly<Record<number, Migration>>,
  source?: string,
): Result<unknown> {
  const fail = (code: string, message: string) => ({
    ok: false as const,
    diagnostics: [error(code, message, ["schemaVersion"], source)],
  });
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return {
      ok: false,
      diagnostics: [error("invalid_type", `Expected a ${kind} object`, [], source)],
    };
  }
  let data = input as Record<string, unknown>;
  const found = data.schemaVersion;
  if (typeof found !== "number" || !Number.isInteger(found) || found < 1) {
    return fail("unsupported_schema_version", `${kind} has no valid schema version`);
  }
  if (found > current) {
    return fail(
      "unsupported_schema_version",
      `${kind} schema version ${found} is newer than this app supports (${current})`,
    );
  }
  for (let version = found; version < current; version++) {
    const step = migrations[version];
    if (!step)
      return fail("missing_migration", `No migration for ${kind} schema version ${version}`);
    data = { ...step(data), schemaVersion: version + 1 };
  }
  return { ok: true, value: data };
}
