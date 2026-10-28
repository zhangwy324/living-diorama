import { describe, expect, it } from "vitest";
import {
  emptyKnowledge,
  gridCellAt,
  KNOWLEDGE_CELL_SIZE,
  RECENT_CELL_LIMIT,
  rememberPlace,
  visitCell,
} from "./knowledge";

describe("rememberPlace", () => {
  it("keeps at most the cap, forgetting the place seen longest ago", () => {
    const k = emptyKnowledge();
    expect(rememberPlace(k, "core:food", "a", 1, 2)).toBe(true);
    rememberPlace(k, "core:food", "b", 2, 2);
    // Seeing "a" again makes "b" the oldest.
    rememberPlace(k, "core:food", "a", 3, 2);
    rememberPlace(k, "core:food", "c", 4, 2);
    expect(k.places["core:food"]).toEqual([
      { placementId: "a", lastSeenTick: 3 },
      { placementId: "c", lastSeenTick: 4 },
    ]);
  });

  it("remembers nothing for an affordance without a cap", () => {
    const k = emptyKnowledge();
    expect(rememberPlace(k, "core:crossable", "bridge", 1, undefined)).toBe(false);
    expect(k).toEqual(emptyKnowledge());
  });
});

describe("visitCell", () => {
  it("moves a revisited cell to the end and keeps only the most recent cells", () => {
    const k = emptyKnowledge();
    for (let n = 0; n < RECENT_CELL_LIMIT + 2; n++) visitCell(k, { x: n, z: 0 }, n);
    visitCell(k, { x: 3, z: 0 }, 99);
    expect(k.recentCells).toHaveLength(RECENT_CELL_LIMIT);
    expect(k.recentCells[0]).toEqual({ x: 2, z: 0, tick: 2 });
    expect(k.recentCells.at(-1)).toEqual({ x: 3, z: 0, tick: 99 });
    expect(k.recentCells.filter((c) => c.x === 3)).toHaveLength(1);
  });

  it("indexes cells of the coarse grid by flooring, also below zero", () => {
    expect(gridCellAt(0, KNOWLEDGE_CELL_SIZE - 0.01)).toEqual({ x: 0, z: 0 });
    expect(gridCellAt(-0.01, KNOWLEDGE_CELL_SIZE)).toEqual({ x: -1, z: 1 });
  });
});
