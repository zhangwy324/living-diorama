import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import { measureAssembly } from "@living-diorama/content-schema";
import { sortedPartTypes } from "@living-diorama/extension-api";
import { describe, expect, it } from "vitest";
import { loadContent } from "./content";
import { partRoleLookup } from "./part-roles";

describe("partRoleLookup", () => {
  // The part types as the worker's `ready` lists them.
  const content = loadContent();
  if (!content.ok) throw new Error("The built-in content doesn't load");
  const partTypes = sortedPartTypes(content.value).map(({ id, role }) => ({
    id,
    ...(role ? { role } : {}),
  }));

  it("gives the built-in tail its role and other types none", () => {
    const roleOf = partRoleLookup(partTypes);
    expect(roleOf("hollow:tail")).toBe("tail");
    expect(roleOf("hollow:leg")).toBeUndefined();
    expect(roleOf("pack:unknown")).toBeUndefined();
  });

  it("puts the sample creature's tail at its tail part, not the middle of its rear", () => {
    const assembly = sampleVoxelAssembly();
    const withRoles = measureAssembly(assembly, partRoleLookup(partTypes));
    const without = measureAssembly(assembly);
    expect(without.tail.y).toBeCloseTo(without.height / 2);
    expect(withRoles.tail).not.toEqual(without.tail);
  });
});
