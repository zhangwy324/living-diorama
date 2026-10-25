import { formatDiagnostic, type Result } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { createRegistries, resolveReferences, type Registries } from "./index";

const species = {
  schemaVersion: 1,
  id: "test:pebble",
  version: "0.1.0",
  name: "Pebble",
  appearance: "test:sprites/pebble.png",
  sizeClass: "small",
  capabilities: { "core:walk": 1 },
  baseSpeed: 0.6,
  behaviors: ["core:wander"],
};

function expectOk<T>(result: Result<T>) {
  expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([]);
}

function withActions(registries: Registries) {
  expectOk(registries.actions.register({ id: "core:idle", version: "1.0.0" }));
  expectOk(registries.actions.register({ id: "core:follow_path", version: "1.2.0" }));
}

describe("Registry", () => {
  it("validates content on registration and looks entries up by ID", () => {
    const registries = createRegistries();
    expectOk(registries.species.register(species));
    expect(registries.species.get("test:pebble")?.baseSpeed).toBe(0.6);
    expect(registries.species.has("test:other")).toBe(false);
    expect(registries.species.size).toBe(1);
  });

  it("returns diagnostics labelled with the registry and ID for invalid content", () => {
    const result = createRegistries().species.register({ ...species, baseSpeed: -1 });
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      "error: species/test:pebble baseSpeed: Too small: expected number to be >0 (too_small)",
    ]);
  });

  it("rejects duplicate IDs regardless of version", () => {
    const registries = createRegistries();
    expectOk(registries.species.register(species));
    const result = registries.species.register({ ...species, version: "0.2.0" });
    expect(result.ok ? [] : result.diagnostics.map(formatDiagnostic)).toEqual([
      'error: species/test:pebble id: "test:pebble" is already registered in species (version 0.1.0; this one is 0.2.0) (duplicate_id)',
    ]);
    expect(registries.species.get("test:pebble")?.version).toBe("0.1.0");
  });

  it("validates code entries: ID, version, dependencies and surface schemas", () => {
    const registries = createRegistries();
    const result = registries.behaviors.register({
      id: "wander",
      version: "1",
      dependencies: [{ registry: "moves", id: "core:idle", version: "not a range" }],
    });
    expect(result.ok ? [] : result.diagnostics.map((d) => d.path.join("."))).toEqual([
      "id",
      "version",
      "dependencies.0.registry",
      "dependencies.0.version",
    ]);

    const surface = registries.surfaces.register({ id: "core:deck", version: "1.0.0" });
    expect(surface.ok ? [] : surface.diagnostics.map((d) => d.message)).toEqual([
      "Expected a params schema",
    ]);
  });
});

describe("resolveReferences", () => {
  it("resolves references and orders dependencies first", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(
      registries.behaviors.register({
        id: "core:wander",
        version: "1.0.0",
        dependencies: [
          { registry: "actions", id: "core:idle" },
          { registry: "actions", id: "core:follow_path", version: "^1.0.0" },
        ],
      }),
    );
    expectOk(registries.species.register(species));

    const resolution = resolveReferences(registries);
    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.ok).toBe(true);
    const order = resolution.loadOrder.map((k) => `${k.registry}/${k.id}`);
    expect(order).toHaveLength(4);
    const before = (a: string, b: string) =>
      expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    before("actions/core:idle", "behaviors/core:wander");
    before("actions/core:follow_path", "behaviors/core:wander");
    before("behaviors/core:wander", "species/test:pebble");
  });

  it("reports unresolved references and unsatisfied version ranges", () => {
    const registries = createRegistries();
    withActions(registries);
    expectOk(
      registries.behaviors.register({
        id: "test:nap",
        version: "1.0.0",
        dependencies: [{ registry: "actions", id: "core:follow_path", version: "^2.0.0" }],
      }),
    );
    expectOk(registries.species.register({ ...species, behaviors: ["test:nap", "core:wander"] }));

    const resolution = resolveReferences(registries);
    expect(resolution.ok).toBe(false);
    expect(resolution.diagnostics.map(formatDiagnostic)).toEqual([
      'error: species/test:pebble behaviors[1]: "core:wander" is not registered in behaviors (unresolved_reference)',
      'error: behaviors/test:nap dependencies[0]: "core:follow_path" is version 1.2.0, which does not satisfy ^2.0.0 (version_mismatch)',
    ]);
  });

  it("reports dependency cycles", () => {
    const registries = createRegistries();
    expectOk(
      registries.behaviors.register({
        id: "test:a",
        version: "1.0.0",
        dependencies: [{ registry: "behaviors", id: "test:b" }],
      }),
    );
    expectOk(
      registries.behaviors.register({
        id: "test:b",
        version: "1.0.0",
        dependencies: [{ registry: "behaviors", id: "test:a" }],
      }),
    );
    const resolution = resolveReferences(registries);
    expect(resolution.diagnostics.map(formatDiagnostic)).toEqual([
      "error: behaviors/test:a: Dependency cycle: behaviors/test:a → behaviors/test:b → behaviors/test:a (dependency_cycle)",
    ]);
    expect(resolution.loadOrder).toEqual([]);
  });
});
