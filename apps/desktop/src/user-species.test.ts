import { AssetRefSchema, ContentIdSchema } from "@living-diorama/content-schema";
import { expect, it } from "vitest";
import { newUserSpeciesIds } from "./user-species";

it("generates distinct, valid IDs in the user namespace", () => {
  const a = newUserSpeciesIds();
  const b = newUserSpeciesIds();
  expect(a.speciesId).toMatch(/^user:[0-9a-f-]{36}$/);
  expect(a.appearanceId).toBe(`${a.speciesId}/appearance.png`);
  expect(ContentIdSchema.safeParse(a.speciesId).success).toBe(true);
  expect(AssetRefSchema.safeParse(a.appearanceId).success).toBe(true);
  expect(b.speciesId).not.toBe(a.speciesId);
});
