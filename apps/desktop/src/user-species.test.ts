import { AssetRefSchema, ContentIdSchema, libraryAppearance } from "@living-diorama/content-schema";
import { expect, it } from "vitest";
import { userSpeciesIds } from "./user-species";

it("generates distinct, valid IDs in the user namespace", () => {
  const a = userSpeciesIds();
  const b = userSpeciesIds();
  expect(a.uuid).toMatch(/^[0-9a-f-]{36}$/);
  expect(a.speciesId).toBe(`user:${a.uuid}`);
  expect(ContentIdSchema.safeParse(a.speciesId).success).toBe(true);
  // Its appearance, the assembly its library entry holds, is a valid asset reference.
  expect(AssetRefSchema.safeParse(libraryAppearance(a.speciesId)).success).toBe(true);
  expect(b.speciesId).not.toBe(a.speciesId);
});

it("derives the IDs of a stored species from its UUID", () => {
  expect(userSpeciesIds("3f9c2a1e-8b4d-4c6f-9a2e-1d5b7c9e0f13").speciesId).toBe(
    "user:3f9c2a1e-8b4d-4c6f-9a2e-1d5b7c9e0f13",
  );
});
