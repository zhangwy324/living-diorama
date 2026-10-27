import { error, type Diagnostic, type Result } from "@living-diorama/content-schema";
import semver from "semver";
import { REGISTRY_NAMES, type RegistryName, type Registries } from "./registries";
import type { Reference, Registry, RegistryEntry } from "./registry";

export interface EntryKey {
  registry: RegistryName;
  id: string;
}

export interface Resolution {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Every entry, dependencies before dependents. Empty if there is a cycle. */
  loadOrder: EntryKey[];
}

const keyOf = (registry: string, id: string) => `${registry}/${id}`;

/**
 * Resolves every reference between registered entries: targets must exist, satisfy declared
 * version ranges and pass target-specific checks. Also orders entries for loading.
 */
export function resolveReferences(registries: Registries): Resolution {
  const diagnostics: Diagnostic[] = [];
  const edges = new Map<string, Set<string>>();
  const keys = new Map<string, EntryKey>();

  for (const registryName of REGISTRY_NAMES) {
    const registry = registries[registryName] as Registry<RegistryEntry>;
    for (const entry of registry.values()) {
      const source = keyOf(registryName, entry.id);
      keys.set(source, { registry: registryName, id: entry.id });
      const targets = new Set<string>();
      edges.set(source, targets);

      for (const ref of registry.references(entry)) {
        diagnostics.push(...checkReference(ref, lookup(registries, ref.registry, ref.id), source));
        targets.add(keyOf(ref.registry, ref.id));
      }
    }
  }

  const { order, cycle } = topologicalOrder(edges);
  if (cycle) {
    diagnostics.push(
      error("dependency_cycle", `Dependency cycle: ${cycle.join(" → ")}`, [], cycle[0]),
    );
  }
  return {
    ok: diagnostics.length === 0,
    diagnostics,
    loadOrder: cycle ? [] : order.flatMap((k) => keys.get(k) ?? []),
  };
}

/** An entry to add with `addEntries`, as raw input to its registry. */
export interface NewEntry {
  registry: RegistryName;
  input: unknown;
}

/**
 * Adds entries to registries that are already resolved, e.g. a species and its appearance while
 * the app runs. Every entry is validated as `register` would, and its references are resolved
 * against what is registered plus the other new entries. Nothing is registered unless all of
 * them pass. There is no cycle check: existing entries can't refer to the new ones.
 */
export function addEntries(
  registries: Registries,
  entries: readonly NewEntry[],
): Result<EntryKey[]> {
  const diagnostics: Diagnostic[] = [];
  const staged = new Map<string, { key: EntryKey; entry: RegistryEntry; input: unknown }>();
  for (const { registry: registryName, input } of entries) {
    const registry = registries[registryName] as Registry<RegistryEntry>;
    const result = registry.validate(input);
    if (!result.ok) {
      diagnostics.push(...result.diagnostics);
      continue;
    }
    const { id } = result.value;
    const key = keyOf(registryName, id);
    if (staged.has(key)) {
      diagnostics.push(
        error("duplicate_id", `"${id}" is added to ${registryName} twice`, ["id"], key),
      );
      continue;
    }
    staged.set(key, { key: { registry: registryName, id }, entry: result.value, input });
  }
  // References to an entry that failed would only repeat its failure as "not registered".
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  for (const [source, { key, entry }] of staged) {
    const registry = registries[key.registry] as Registry<RegistryEntry>;
    for (const ref of registry.references(entry)) {
      const target =
        staged.get(keyOf(ref.registry, ref.id))?.entry ?? lookup(registries, ref.registry, ref.id);
      diagnostics.push(...checkReference(ref, target, source));
    }
  }
  if (diagnostics.some((d) => d.severity === "error")) return { ok: false, diagnostics };
  for (const { key, input } of staged.values()) {
    (registries[key.registry] as Registry<RegistryEntry>).register(input);
  }
  return { ok: true, value: [...staged.values()].map(({ key }) => key) };
}

function lookup(registries: Registries, registry: string, id: string): RegistryEntry | undefined {
  return (registries as unknown as Record<string, Registry<RegistryEntry> | undefined>)[
    registry
  ]?.get(id);
}

/** Checks one reference against its target: it exists, its version fits and its checks pass. */
function checkReference(
  ref: Reference,
  target: RegistryEntry | undefined,
  source: string,
): Diagnostic[] {
  if (!target) {
    return [
      error(
        "unresolved_reference",
        `"${ref.id}" is not registered in ${ref.registry}`,
        ref.path,
        source,
      ),
    ];
  }
  const found: Diagnostic[] = [];
  if (ref.versionRange !== undefined && !semver.satisfies(target.version, ref.versionRange)) {
    found.push(
      error(
        "version_mismatch",
        `"${ref.id}" is version ${target.version}, which does not satisfy ${ref.versionRange}`,
        ref.path,
        source,
      ),
    );
  }
  for (const d of ref.check?.(target) ?? []) found.push({ ...d, source });
  return found;
}

function topologicalOrder(edges: Map<string, Set<string>>) {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (node: string): string[] | undefined => {
    const s = state.get(node);
    if (s === "done") return undefined;
    if (s === "visiting") return [...stack.slice(stack.indexOf(node)), node];
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(node, "done");
    order.push(node);
    return undefined;
  };

  for (const node of edges.keys()) {
    const cycle = visit(node);
    if (cycle) return { order, cycle };
  }
  return { order, cycle: undefined };
}
