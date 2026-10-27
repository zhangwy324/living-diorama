import { parseDrawing } from "@living-diorama/content-schema";
import { expect, it } from "vitest";
import { SAMPLE_DRAWING } from "./dev-library";

it("ships a valid sample drawing", () => {
  expect(parseDrawing(SAMPLE_DRAWING).ok).toBe(true);
});
