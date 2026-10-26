import { createRegistries } from "@living-diorama/extension-api";
import { expect, it } from "vitest";
import { BUILT_IN_NAMESPACE, registerBuiltInContent } from "./index";

it("registers its world, species and structure under its own namespace", () => {
  const registries = createRegistries();
  const results = registerBuiltInContent(registries);
  expect(results.every((r) => r.ok)).toBe(true);
  const ids = [registries.worlds, registries.species, registries.structures].flatMap((r) =>
    r.values().map((e) => e.id),
  );
  expect(ids).toHaveLength(3);
  for (const id of ids) expect(id.startsWith(`${BUILT_IN_NAMESPACE}:`)).toBe(true);
  for (const asset of registries.assets.values()) {
    expect(asset.id.startsWith(`${BUILT_IN_NAMESPACE}:`)).toBe(true);
  }
});
