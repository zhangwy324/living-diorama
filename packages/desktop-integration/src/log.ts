import { isTauri } from "@tauri-apps/api/core";
import { error, warn } from "@tauri-apps/plugin-log";

/**
 * Also writes every `console.warn` and `console.error` to the diagnostics log (ADR 0009 §14), so
 * engine packages keep using the console and stay unaware of the log. Does nothing outside Tauri.
 */
export function forwardConsoleToLog(): void {
  if (!isTauri()) return;
  forward("warn", warn);
  forward("error", error);
}

function forward(level: "warn" | "error", write: (message: string) => Promise<void>) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    // Reported through the original, so a failing log never loops back into itself.
    write(formatForLog(args)).catch((cause: unknown) =>
      original("Could not write to the log", cause),
    );
  };
}

/** One line per console call, the way the console would show it. Errors keep their stack. */
export function formatForLog(args: readonly unknown[]): string {
  return args.map(formatValue).join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
