import {
  assemblyWarnings,
  formatDiagnostic,
  measureAssembly,
  validate,
  VoxelAssemblySchema,
} from "@living-diorama/content-schema";
import {
  checkAssemblyTypes,
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import { expect, it } from "vitest";
import { registerBuiltInContent } from "./index";
import { mosslingAssembly } from "./reference-creatures";
import frozen from "./woodland-hollow/assets/voxels/mossling.json";

// The mossling species and its frozen assembly (ADR 0022, M20 decisions "The voxel mossling looks
// like today's", "The mossling's assembly is a frozen asset" and "Pack species are checked like
// library ones"): checked as the library checks a player's voxel creature when it is saved.

function registered(): Registries {
  const registries = createRegistries();
  const results = registerBuiltInContent(registries);
  expect(results.flatMap((r) => (r.ok ? [] : r.diagnostics.map(formatDiagnostic)))).toEqual([]);
  return registries;
}

const assembly = () => {
  const parsed = validate(VoxelAssemblySchema, frozen, "mossling.json");
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  return parsed.value;
};

it("is a voxel species of its frozen assembly, with no drawn-only settings", () => {
  const registries = registered();
  const species = registries.species.get("hollow:mossling");
  expect(species?.appearance).toBe("hollow:voxels/mossling.json");
  expect(registries.assets.get("hollow:voxels/mossling.json")?.kind).toBe("voxel");
  // The engine's capabilities and behaviours are registered by simulation, not here.
  const diagnostics = resolveReferences(registries).diagnostics.filter(
    (d) => d.source?.startsWith("species/") && ["appearance", "body"].includes(String(d.path[0])),
  );
  expect(diagnostics.map(formatDiagnostic)).toEqual([]);
});

it("is the size class it declares, measured from its cubes", () => {
  const registries = registered();
  const measured = measureAssembly(assembly(), (type) => registries.partTypes.get(type)?.role);
  expect(measured.sizeClass).toBe(registries.species.get("hollow:mossling")?.sizeClass);
});

it("fits its part types and has no flush faces", () => {
  const registries = registered();
  expect(checkAssemblyTypes(registries, assembly()).map(formatDiagnostic)).toEqual([]);
  expect(assemblyWarnings(assembly(), "mossling.json").map(formatDiagnostic)).toEqual([]);
});

it("is the mossling built from the registered parts, each copy naming its part as source", () => {
  // The text of the file is checked against `pnpm mossling` in tools/development.
  const registries = registered();
  const partOf = (id: string) => {
    const definition = registries.parts.get(id);
    if (!definition) throw new Error(`No part ${id}`);
    return definition.part;
  };
  expect(assembly()).toEqual(mosslingAssembly(partOf));
  for (const [key, part] of Object.entries(assembly().parts)) {
    const { source, ...rest } = part;
    expect([key, rest]).toEqual([key, source && partOf(source)]);
  }
});
