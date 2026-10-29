import type { Diagnostic } from "@living-diorama/content-schema";
import type { BodyCheck } from "@living-diorama/renderer";
import type { Limit } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { drawingHints, limitHints } from "./hints";

const check = (fields: Partial<BodyCheck>): BodyCheck => ({
  width: 1,
  height: 1,
  empty: false,
  shapes: 1,
  thinParts: 0,
  thin: new Uint8Array(1),
  loose: new Uint8Array(1),
  bounds: undefined,
  ...fields,
});

const limit = (code: string, fields: Partial<Limit> = {}): Limit => ({
  severity: "warning",
  code,
  message: `${code} message`,
  path: [],
  ...fields,
});

describe("drawingHints", () => {
  it("says when nothing is drawn, and nothing else", () => {
    expect(drawingHints(check({ empty: true, shapes: 0 }))).toEqual(["Nothing drawn yet."]);
  });

  it("says nothing about one solid shape", () => {
    expect(drawingHints(check({}))).toEqual([]);
  });

  it("points out thin parts and shapes that aren't joined", () => {
    expect(drawingHints(check({ thinParts: 1 }))).toEqual([
      expect.stringMatching(/^This part is very thin/),
    ]);
    expect(drawingHints(check({ thinParts: 3, shapes: 2 }))).toEqual([
      expect.stringMatching(/^Some parts are very thin/),
      expect.stringMatching(/^Parts aren't joined .*each separate shape becomes its own slab\.$/),
    ]);
  });
});

describe("limitHints", () => {
  it("names the structure a creature is too big to cross, once", () => {
    const bridge = { structure: { id: "bridge", name: "Wooden bridge" } };
    expect(
      limitHints([limit("portal_unusable", bridge), limit("portal_unusable", bridge)]),
    ).toEqual(["Too big to cross the wooden bridge."]);
  });

  it("puts every limit in the player's words, never a code", () => {
    const limits = [
      limit("portal_unusable"),
      limit("disconnected_region"),
      limit("no_walkable_area"),
      limit("spawn_not_walkable"),
      limit("no_spawn_point", { severity: "error" }),
      limit("no_water_exit"),
      limit("something_new"),
      limit("something_broken", { severity: "error" }),
    ];
    const hints = limitHints(limits);
    expect(hints).toHaveLength(limits.length);
    for (const [i, hint] of hints.entries()) {
      expect(hint).not.toContain((limits[i] as Diagnostic).code);
      expect(hint).toMatch(/^[A-Z].*\.$/);
    }
    expect(hints[4]).toBe("Has nowhere to appear in this world at this size, moving this way.");
    expect(hints[5]).toBe("Could get stuck in the water: some banks are too high to climb out.");
  });

  it("has nothing to say about a size that fits everywhere", () => {
    expect(limitHints([])).toEqual([]);
  });
});
