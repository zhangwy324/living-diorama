import type { SizeClass } from "@living-diorama/content-schema";
import {
  createMemoryWindowBus,
  openStudioChannel,
  serveStudio,
} from "@living-diorama/desktop-integration";
import type { Limit } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { DRAWN_SPECIES_DEFAULTS } from "./startup";
import {
  studioHandlers,
  type LibrarySnapshot,
  type StudioRequests,
  type StudioServices,
} from "./studio-protocol";

const bridge: Limit = {
  severity: "warning",
  code: "portal_unusable",
  message: "unusable",
  path: ["structures", 0, "connections", 0, "portal"],
  structure: { id: "bridge", name: "Wooden bridge" },
};

function connect(checkLimits: StudioServices["checkLimits"]) {
  const bus = createMemoryWindowBus();
  serveStudio<StudioRequests, LibrarySnapshot>(
    studioHandlers({ library: () => ({ species: [] }), checkLimits }),
    bus.connect("main"),
  );
  return openStudioChannel<StudioRequests, LibrarySnapshot>({ transport: bus.connect("studio") });
}

describe("the Studio's requests", () => {
  it("checks a size's limits with the capabilities every drawn species has", async () => {
    const checkLimits = vi.fn((sizeClass: SizeClass) =>
      Promise.resolve({ ok: true as const, value: sizeClass === "large" ? [bridge] : [] }),
    );
    const studio = connect(checkLimits);
    await expect(studio.request("limits", { sizeClass: "large" })).resolves.toEqual([bridge]);
    await expect(studio.request("limits", { sizeClass: "small" })).resolves.toEqual([]);
    expect(checkLimits).toHaveBeenCalledWith("large", DRAWN_SPECIES_DEFAULTS.capabilities);
  });

  it("passes a rejected query on as an error", async () => {
    const studio = connect(() =>
      Promise.resolve({
        ok: false,
        diagnostics: [
          { severity: "error", code: "unknown_size_class", message: "No size huge", path: [] },
        ],
      }),
    );
    await expect(studio.request("limits", { sizeClass: "huge" as SizeClass })).rejects.toThrow(
      "No size huge",
    );
  });

  it("answers with the library", async () => {
    const studio = connect(() => Promise.reject(new Error("unused")));
    await expect(studio.request("snapshot", undefined)).resolves.toEqual({ species: [] });
  });
});
