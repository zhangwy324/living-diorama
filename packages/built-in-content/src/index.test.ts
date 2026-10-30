import {
  checkReferences,
  createRegistries,
  sortedPropCategories,
} from "@living-diorama/extension-api";
import { expect, it } from "vitest";
import { BUILT_IN_NAMESPACE, registerBuiltInContent } from "./index";

it("registers its world, species, structure, prop types and prop categories under its own namespace", () => {
  const registries = createRegistries();
  const results = registerBuiltInContent(registries);
  expect(results.every((r) => r.ok)).toBe(true);
  const ids = [
    registries.worlds,
    registries.species,
    registries.structures,
    registries.props,
    registries.propCategories,
  ].flatMap((r) => r.values().map((e) => e.id));
  expect(ids).toHaveLength(12);
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

it("lists every prop type under a registered category", () => {
  const registries = createRegistries();
  registerBuiltInContent(registries);
  expect(sortedPropCategories(registries).map((c) => c.name)).toEqual([
    "Trees",
    "Rocks",
    "Plants",
    "Mushrooms",
  ]);
  const byCategory = (category: string) =>
    registries.props
      .values()
      .filter((p) => p.category === category)
      .map((p) => p.id)
      .sort();
  expect(byCategory("hollow:trees")).toEqual(["hollow:pine", "hollow:round-tree"]);
  expect(byCategory("hollow:rocks")).toEqual(["hollow:rock"]);
  expect(byCategory("hollow:plants")).toEqual(["hollow:bush"]);
  expect(byCategory("hollow:mushrooms")).toEqual(["hollow:mushroom"]);
  for (const prop of registries.props.values()) {
    const category = checkReferences(registries, "props", prop).filter(
      (d) => d.path[0] === "category",
    );
    expect(category).toEqual([]);
  }
});
