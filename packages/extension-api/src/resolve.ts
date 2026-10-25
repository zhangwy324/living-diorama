import { error, type Diagnostic } from "@living-diorama/content-schema";
import semver from "semver";
import { REGISTRY_NAMES, type RegistryName, type Registries } from "./registries";
import type { Registry, RegistryEntry } from "./registry";

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
        const targetRegistry = (registries as unknown as Record<string, Registry<RegistryEntry>>)[
          ref.registry
        ];
        const target = targetRegistry?.get(ref.id);
        if (!target) {
          diagnostics.push(
            error(
              "unresolved_reference",
              `"${ref.id}" is not registered in ${ref.registry}`,
              ref.path,
              source,
            ),
          );
          continue;
        }
        if (ref.versionRange !== undefined && !semver.satisfies(target.version, ref.versionRange)) {
          diagnostics.push(
            error(
              "version_mismatch",
              `"${ref.id}" is version ${target.version}, which does not satisfy ${ref.versionRange}`,
              ref.path,
              source,
            ),
          );
        }
        for (const d of ref.check?.(target) ?? []) diagnostics.push({ ...d, source });
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
