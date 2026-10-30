import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import { measureAssembly } from "@living-diorama/content-schema";
import { sortedPartTypes, sortedSocketTypes } from "@living-diorama/extension-api";
import { describe, expect, it } from "vitest";
import { loadContent } from "./content";
import { partFitLookup, partRoleLookup } from "./part-types";

// The part and socket types as the worker's `ready` lists them.
const content = loadContent();
if (!content.ok) throw new Error("The built-in content doesn't load");
const partTypes = sortedPartTypes(content.value).map(({ id, name, fits, role }) => ({
  id,
  name,
  fits: [...fits],
  ...(role ? { role } : {}),
}));
const socketTypes = sortedSocketTypes(content.value).map(({ id }) => id);

describe("partRoleLookup", () => {
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

describe("partFitLookup", () => {
  it("gives a registered part type's fits, and none for one the summary doesn't list", () => {
    const lookup = partFitLookup(partTypes, socketTypes);
    expect(lookup.fitsOf("hollow:leg")).toEqual(["hollow:hip", "hollow:shoulder"]);
    expect(lookup.fitsOf("pack:unknown")).toBeUndefined();
  });

  it("knows the registered socket types only", () => {
    const lookup = partFitLookup(partTypes, socketTypes);
    expect(lookup.isSocketType("hollow:hip")).toBe(true);
    expect(lookup.isSocketType("hollow:leg")).toBe(false);
    expect(lookup.isSocketType("pack:unknown")).toBe(false);
  });

  it("agrees with the registries on every part and socket type", () => {
    const lookup = partFitLookup(partTypes, socketTypes);
    for (const type of content.value.partTypes.values()) {
      expect(lookup.fitsOf(type.id)).toEqual(type.fits);
    }
    for (const type of content.value.socketTypes.values()) {
      expect(lookup.isSocketType(type.id)).toBe(true);
    }
  });
});
