import { registerBuiltInContent } from "@living-diorama/built-in-content";
import type { Result } from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import { registerCoreEngine } from "@living-diorama/simulation";

// Composition root for content (ADR 0010). Only the simulation worker imports this module: it is
// the one place content is registered and checked, and the main thread draws what the worker's
// `ready` message describes.

/** Registers the engine's entries, then the built-in pack, and resolves references. */
export function loadContent(): Result<Registries> {
  const registries = createRegistries();
  const results = [...registerCoreEngine(registries), ...registerBuiltInContent(registries)];
  const diagnostics = [
    ...results.flatMap((r) => (r.ok ? [] : r.diagnostics)),
    ...resolveReferences(registries).diagnostics,
  ];
  return diagnostics.some((d) => d.severity === "error")
    ? { ok: false, diagnostics }
    : { ok: true, value: registries };
}
