import type { Diagnostic } from "@living-diorama/content-schema";
import type { Limit } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { limitHints } from "./hints";

const limit = (code: string, fields: Partial<Limit> = {}): Limit => ({
  severity: "warning",
  code,
  message: `${code} message`,
  path: [],
  ...fields,
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
