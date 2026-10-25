import type { z } from "zod";

export type DiagnosticPath = readonly (string | number)[];

/** A structured, human-readable validation finding. */
export interface Diagnostic {
  severity: "error" | "warning";
  /** Stable machine-readable code, e.g. `duplicate_id` or a Zod issue code. */
  code: string;
  message: string;
  /** Location inside the validated input. */
  path: DiagnosticPath;
  /** What was being validated, e.g. `worlds/core:meadow`. */
  source?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; diagnostics: Diagnostic[] };

/** Formats a path as `regions[2].surface.params`. */
export function formatPath(path: DiagnosticPath): string {
  let out = "";
  for (const segment of path) {
    out += typeof segment === "number" ? `[${segment}]` : out === "" ? segment : `.${segment}`;
  }
  return out;
}

/** Formats a diagnostic as one readable line. */
export function formatDiagnostic(d: Diagnostic): string {
  const where = [d.source, formatPath(d.path)].filter((part) => part).join(" ");
  return `${d.severity}: ${where ? `${where}: ` : ""}${d.message} (${d.code})`;
}

export function error(
  code: string,
  message: string,
  path: DiagnosticPath = [],
  source?: string,
): Diagnostic {
  return source === undefined
    ? { severity: "error", code, message, path }
    : { severity: "error", code, message, path, source };
}

export function fromZodIssues(issues: readonly z.core.$ZodIssue[], source?: string): Diagnostic[] {
  return issues.map((issue) =>
    error(
      issue.code,
      issue.message,
      issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
      source,
    ),
  );
}
