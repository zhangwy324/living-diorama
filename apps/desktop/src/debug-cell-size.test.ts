import { DEBUG_CELL_SIZE } from "@living-diorama/renderer";
import { KNOWLEDGE_CELL_SIZE } from "@living-diorama/simulation";
import { expect, it } from "vitest";

// The renderer may import only types from the simulation, so it mirrors the knowledge grid's
// cell size for the debug overlay. This keeps the two equal.
it("draws recent cells on the simulation's knowledge grid", () => {
  expect(DEBUG_CELL_SIZE).toBe(KNOWLEDGE_CELL_SIZE);
});
