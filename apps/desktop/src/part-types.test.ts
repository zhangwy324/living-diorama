import { sampleVoxelAssembly } from "@living-diorama/built-in-content";
import { DEFAULT_PART_DRAWING_RECIPE, measureAssembly } from "@living-diorama/content-schema";
import { describeVoxelParts } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { loadContent } from "./content";
import {
  partDrawingRecipeLookup,
  partFitLookup,
  partMotionLookup,
  partRoleLookup,
} from "./part-types";

// The part and socket types as the worker's `ready` lists them.
const content = loadContent();
if (!content.ok) throw new Error("The built-in content doesn't load");
const { partTypes, socketTypes } = describeVoxelParts(content.value);

describe("partRoleLookup", () => {
  it("gives the built-in tail and torso their roles and other types none", () => {
    const roleOf = partRoleLookup(partTypes);
    expect(roleOf("hollow:tail")).toBe("tail");
    expect(roleOf("hollow:torso")).toBe("root");
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

describe("partMotionLookup", () => {
  it("gives the built-in part types their motions and the torso, nose and mouth none", () => {
    const motionOf = partMotionLookup(partTypes);
    expect(motionOf("hollow:leg")).toBe("swing");
    expect(motionOf("hollow:eye")).toBe("blink");
    expect(motionOf("hollow:tail-fin")).toBe("wag");
    for (const still of ["hollow:torso", "hollow:nose", "hollow:mouth", "pack:unknown"]) {
      expect(motionOf(still)).toBeUndefined();
    }
  });

  it("agrees with the registries on every part type", () => {
    const motionOf = partMotionLookup(partTypes);
    for (const type of content.value.partTypes.values()) {
      expect(motionOf(type.id)).toBe(type.motion);
    }
  });
});

describe("partDrawingRecipeLookup", () => {
  it("gives the built-in part types their drawing recipes", () => {
    const recipeOf = partDrawingRecipeLookup(partTypes);
    expect(recipeOf("hollow:torso")).toEqual({ view: "side", rule: "puffy" });
    expect(recipeOf("hollow:leg")).toEqual({ view: "side", rule: "tube" });
    expect(recipeOf("hollow:eye")).toEqual({ view: "front", rule: "flat" });
  });

  it("draws a type without a recipe, or one the summary doesn't list, flat from the side", () => {
    const recipeOf = partDrawingRecipeLookup([{ id: "pack:antenna", name: "Antenna", fits: [] }]);
    expect(DEFAULT_PART_DRAWING_RECIPE).toEqual({ view: "side", rule: "flat" });
    expect(recipeOf("pack:antenna")).toBe(DEFAULT_PART_DRAWING_RECIPE);
    expect(recipeOf("pack:unknown")).toBe(DEFAULT_PART_DRAWING_RECIPE);
  });

  it("agrees with the registries on every part type", () => {
    const recipeOf = partDrawingRecipeLookup(partTypes);
    for (const type of content.value.partTypes.values()) {
      expect(recipeOf(type.id)).toEqual(type.drawing ?? DEFAULT_PART_DRAWING_RECIPE);
    }
  });
});

describe("partFitLookup", () => {
  it("gives a registered part type's fits, and none for one the summary doesn't list", () => {
    const lookup = partFitLookup(partTypes, socketTypes);
    expect(lookup.fitsOf("hollow:leg")).toEqual(["hollow:leg-mount"]);
    expect(lookup.fitsOf("pack:unknown")).toBeUndefined();
  });

  it("knows the registered socket types only", () => {
    const lookup = partFitLookup(partTypes, socketTypes);
    expect(lookup.isSocketType("hollow:leg-mount")).toBe(true);
    expect(lookup.isSocketType("hollow:leg")).toBe(false);
    expect(lookup.isSocketType("pack:unknown")).toBe(false);
  });

  it("agrees with the registries on every part and socket type", () => {
    const lookup = partFitLookup(partTypes, socketTypes);
    for (const type of content.value.partTypes.values()) {
      expect(lookup.fitsOf(type.id)).toEqual(type.fits);
      expect(lookup.roleOf(type.id)).toBe(type.role);
    }
    for (const type of content.value.socketTypes.values()) {
      expect(lookup.isSocketType(type.id)).toBe(true);
    }
  });
});
