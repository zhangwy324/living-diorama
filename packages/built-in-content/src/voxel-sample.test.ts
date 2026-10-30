import {
  assemblyWarnings,
  formatDiagnostic,
  measureAssembly,
  validate,
  VoxelAssemblySchema,
} from "@living-diorama/content-schema";
import { checkAssemblyTypes, createRegistries } from "@living-diorama/extension-api";
import { expect, it } from "vitest";
import { registerBuiltInContent, sampleVoxelAssembly } from "./index";

it("builds a valid medium sample creature, about 72 × 45 cm, of the built-in part and socket types", () => {
  const parsed = validate(VoxelAssemblySchema, sampleVoxelAssembly());
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  // Already in its parsed form, so a caller can use it without parsing.
  expect(parsed.value).toEqual(sampleVoxelAssembly());
  expect(assemblyWarnings(parsed.value)).toEqual([]);

  const registries = createRegistries();
  registerBuiltInContent(registries);
  expect(checkAssemblyTypes(registries, parsed.value)).toEqual([]);

  const roles = (type: string) => registries.partTypes.get(type)?.role;
  const measure = measureAssembly(parsed.value, roles);
  expect(measure.sizeClass).toBe("medium");
  // 72.5 cm long and 45 cm tall in 5 cm cubes.
  expect(measure.bounds.max.x - measure.bounds.min.x).toBeCloseTo(0.725);
  expect(measure.height).toBeCloseTo(0.45);
  // It has a tail-role part, so its tail is that part's attach point, at the back.
  expect(measure.tail.x).toBeLessThan(measure.centerOfGravity.x);
});

it("isn't registered as a species or placed in a world", () => {
  const registries = createRegistries();
  registerBuiltInContent(registries);
  expect(registries.species.values().map((s) => s.id)).toEqual(["hollow:mossling"]);
});
