import {
  checkReferences,
  createRegistries,
  partFitsSocket,
  resolveReferences,
  sortedPartTypes,
  sortedPropCategories,
  suggestedColors,
} from "@living-diorama/extension-api";
import { expect, it } from "vitest";
import { BUILT_IN_NAMESPACE, registerBuiltInContent } from "./index";

it("registers its world, species, structure, prop types, prop categories, part types, socket types and palette under its own namespace", () => {
  const registries = createRegistries();
  const results = registerBuiltInContent(registries);
  expect(results.every((r) => r.ok)).toBe(true);
  const ids = [
    registries.worlds,
    registries.species,
    registries.structures,
    registries.props,
    registries.propCategories,
    registries.partTypes,
    registries.socketTypes,
    registries.palettes,
  ].flatMap((r) => r.values().map((e) => e.id));
  expect(ids).toHaveLength(34);
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

it("registers the core part types, each fitting a registered socket type", () => {
  const registries = createRegistries();
  registerBuiltInContent(registries);
  expect(
    resolveReferences(registries).diagnostics.filter((d) => d.source?.startsWith("partTypes")),
  ).toEqual([]);
  expect(sortedPartTypes(registries).map((t) => t.name)).toEqual([
    "Arm",
    "Ear",
    "Eye",
    "Fin",
    "Head",
    "Leg",
    "Mouth",
    "Nose",
    "Tail",
    "Tail fin",
    "Torso",
  ]);
  const withRole = (role: string) =>
    sortedPartTypes(registries)
      .filter((t) => t.role === role)
      .map((t) => t.id);
  expect(withRole("tail")).toEqual(["hollow:tail", "hollow:tail-fin"]);
  // The torso is the root: it hangs from nothing. Every other type hangs from something.
  expect(withRole("root")).toEqual(["hollow:torso"]);
  for (const type of registries.partTypes.values()) {
    expect([type.id, type.fits.length > 0]).toEqual([type.id, type.role !== "root"]);
  }
  // Every type moves but the torso (the body itself), the nose and the mouth (M22).
  expect(
    Object.fromEntries(sortedPartTypes(registries).map((t) => [t.id, t.motion ?? null])),
  ).toEqual({
    "hollow:arm": "swing",
    "hollow:ear": "flop",
    "hollow:eye": "blink",
    "hollow:fin": "paddle",
    "hollow:head": "bob",
    "hollow:leg": "swing",
    "hollow:mouth": null,
    "hollow:nose": null,
    "hollow:tail": "wag",
    "hollow:tail-fin": "wag",
    "hollow:torso": null,
  });
  expect(partFitsSocket(registries, "hollow:leg", "hollow:leg-mount")).toBe(true);
  expect(partFitsSocket(registries, "hollow:eye", "hollow:leg-mount")).toBe(false);
});

it("fits each part type to the sockets it is meant for, and no others (#225)", () => {
  // One kind of part per socket type, so a random creature never wears side fins as arms, legs
  // as arms or a bushy tail on a fish.
  const registries = createRegistries();
  registerBuiltInContent(registries);
  expect(Object.fromEntries(sortedPartTypes(registries).map(({ id, fits }) => [id, fits]))).toEqual(
    {
      "hollow:arm": ["hollow:shoulder"],
      "hollow:ear": ["hollow:ear-mount"],
      "hollow:eye": ["hollow:eye-mount"],
      "hollow:fin": ["hollow:fin-mount"],
      "hollow:head": ["hollow:neck"],
      "hollow:leg": ["hollow:leg-mount"],
      "hollow:mouth": ["hollow:mouth-mount"],
      "hollow:nose": ["hollow:nose-mount"],
      "hollow:tail": ["hollow:tail-base"],
      "hollow:tail-fin": ["hollow:tail-fin-mount"],
      "hollow:torso": [],
    },
  );
});

it("suggests creature colours with no pure black or white, each once", () => {
  const registries = createRegistries();
  registerBuiltInContent(registries);
  const colors = suggestedColors(registries);
  expect(colors).toEqual(registries.palettes.get("hollow:woodland")?.colors);
  expect(colors.length).toBeGreaterThanOrEqual(12);
  expect(colors).not.toContain("#000000");
  expect(colors).not.toContain("#ffffff");
  // Written in lower case, as the starter parts' colours are.
  for (const color of colors) expect(color).toBe(color.toLowerCase());
});
