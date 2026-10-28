import { createRegistries } from "@living-diorama/extension-api";
import { expect, it } from "vitest";
import { BUILT_IN_NAMESPACE, registerBuiltInContent } from "./index";

it("registers its world, species, structure and prop types under its own namespace", () => {
  const registries = createRegistries();
  const results = registerBuiltInContent(registries);
  expect(results.every((r) => r.ok)).toBe(true);
  const ids = [
    registries.worlds,
    registries.species,
    registries.structures,
    registries.props,
  ].flatMap((r) => r.values().map((e) => e.id));
  expect(ids).toHaveLength(8);
  for (const id of ids) expect(id.startsWith(`${BUILT_IN_NAMESPACE}:`)).toBe(true);
  for (const asset of registries.assets.values()) {
    expect(asset.id.startsWith(`${BUILT_IN_NAMESPACE}:`)).toBe(true);
  }
});

it("offers food at mushrooms and bushes and shelter at round trees", () => {
  const registries = createRegistries();
  registerBuiltInContent(registries);
  const offering = (affordance: string) =>
    registries.props
      .values()
      .filter((p) => affordance in p.affordances)
      .map((p) => p.id)
      .sort();
  expect(offering("core:food")).toEqual(["hollow:bush", "hollow:mushroom"]);
  expect(offering("core:shelter")).toEqual(["hollow:round-tree"]);
});
