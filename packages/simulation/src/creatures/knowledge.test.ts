import { describe, expect, it } from "vitest";
import type { AffordanceType } from "@living-diorama/extension-api";
import type { PropModel } from "../world/world-model";
import {
  emptyKnowledge,
  gridCellAt,
  KNOWLEDGE_CELL_SIZE,
  copyKnowledge,
  isBackedOff,
  MAX_REACH_BACKOFF_SECONDS,
  REACH_BACKOFF_SECONDS,
  RECENT_CELL_LIMIT,
  recordReach,
  type CreatureKnowledge,
  rememberPlace,
  visitCell,
} from "./knowledge";
import { perceive } from "./perception";

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

describe("recordReach", () => {
  const at = (tick: number, cell = { x: 0, z: 0 }) => ({ tick, tickSeconds: 0.1, cell });
  const known = () => {
    const k = emptyKnowledge();
    rememberPlace(k, "core:food", "a", 0, 8);
    return k;
  };
  const place = (k: CreatureKnowledge) => k.places["core:food"]![0]!;

  it("backs a place off longer for each failure of a kind, up to the cap", () => {
    const k = known();
    const retries: number[] = [];
    for (let n = 0; n < 9; n++) {
      recordReach(k, "core:food", "a", "stuck", at(1000));
      retries.push((place(k).failures!.retryTick - 1000) / 10);
    }
    expect(retries).toEqual([30, 60, 120, 240, 480, 960, 1920, 3600, 3600]);
    expect(MAX_REACH_BACKOFF_SECONDS).toBe(3600);
    expect(place(k).failures).toMatchObject({ noRoute: 0, stuck: 9 });
  });

  it("counts no route apart from stuck, with a longer first back-off", () => {
    const k = known();
    recordReach(k, "core:food", "a", "stuck", at(0));
    recordReach(k, "core:food", "a", "no_route", at(100, { x: 2, z: -1 }));
    expect(place(k).failures).toEqual({
      noRoute: 1,
      stuck: 1,
      retryTick: 100 + REACH_BACKOFF_SECONDS.no_route * 10,
      cell: { x: 2, z: -1 },
    });
    expect(isBackedOff(place(k), 100 + 1199)).toBe(true);
    expect(isBackedOff(place(k), 100 + 1200)).toBe(false);
  });

  it("clears the failures once the place is reached, and ignores places it doesn't know", () => {
    const k = known();
    recordReach(k, "core:food", "a", "stuck", at(0));
    recordReach(k, "core:food", "a", "reached", at(5));
    expect(place(k)).toEqual({ placementId: "a", lastSeenTick: 0 });
    expect(isBackedOff(place(k), 5)).toBe(false);
    recordReach(k, "core:food", "b", "stuck", at(5));
    recordReach(k, "core:shelter", "a", "stuck", at(5));
    expect(k).toEqual(known());
  });

  it("copies failures deeply", () => {
    const k = known();
    recordReach(k, "core:food", "a", "stuck", at(0));
    const copy = copyKnowledge(k);
    expect(copy).toEqual(k);
    place(copy).failures!.cell.x = 9;
    expect(place(k).failures!.cell.x).toBe(0);
  });
});

describe("perceive and reach failures", () => {
  const food = { id: "a", transform: { position: { x: 4, y: 0, z: 4 } }, blockRadius: 0 };
  const scan = (k: CreatureKnowledge, x: number, z: number, tick: number, reachable: boolean) => {
    const asked: string[] = [];
    perceive({
      knowledge: k,
      x,
      z,
      vision: 20,
      tick,
      propsByAffordance: new Map([["core:food", [food as PropModel]]]),
      affordance: (id) => ({ id, remember: 8 }) as unknown as AffordanceType,
      canReach: (id) => {
        asked.push(id);
        return reachable;
      },
    });
    return asked;
  };
  const failed = () => {
    const k = emptyKnowledge();
    rememberPlace(k, "core:food", "a", 0, 8);
    recordReach(k, "core:food", "a", "no_route", {
      tick: 0,
      tickSeconds: 0.1,
      cell: { x: 0, z: 0 },
    });
    return k;
  };

  it("clears failures when it sees the place from another cell it can reach it from", () => {
    const k = failed();
    // The cell it failed from: not asked again.
    expect(scan(k, 1, 1, 10, true)).toEqual([]);
    expect(k.places["core:food"]![0]!.failures).toBeDefined();
    expect(scan(k, 9, 1, 20, true)).toEqual(["a"]);
    expect(k.places["core:food"]![0]!.failures).toBeUndefined();
  });

  it("from a cell it can't reach the place from, moves the failures there and asks once", () => {
    const k = failed();
    expect(scan(k, 9, 1, 10, false)).toEqual(["a"]);
    expect(k.places["core:food"]![0]!.failures).toMatchObject({ noRoute: 1, cell: { x: 1, z: 0 } });
    expect(scan(k, 9, 1, 20, false)).toEqual([]);
  });
});
