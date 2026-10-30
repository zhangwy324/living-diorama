// @vitest-environment jsdom
import type { VoxelAssembly } from "@living-diorama/content-schema";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { StudioSpecies } from "../studio-protocol";
import { copyName, copyRequest } from "./edit-copy";
import { MyCreatures } from "./MyCreatures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ASSEMBLY = { parts: {}, instances: [] } as unknown as VoxelAssembly;

const species = (n: number, body: "voxel" | "drawn"): StudioSpecies => ({
  speciesId: `user:${n}`,
  libraryId: String(n),
  name: `Creature ${n}`,
  sizeClass: "medium",
  createdAt: "2026-10-30T12:00:00.000Z",
  body,
  available: true,
  limits: [],
  inWorld: 1,
});

describe("Edit a copy", () => {
  it("names the copy after the original, within the name field's 40 characters", () => {
    expect(copyName("Pebble")).toBe("Pebble copy");
    expect(copyName("  Mossy Pebble ")).toBe("Mossy Pebble copy");
    const long = copyName("A".repeat(40));
    expect(long).toHaveLength(40);
    expect(long.endsWith(" copy")).toBe(true);
  });

  it("fetches the species' assembly and makes a load request under the given key", async () => {
    const fetch = vi.fn(() => Promise.resolve({ assembly: ASSEMBLY }));
    const request = await copyRequest(fetch, { speciesId: "user:1", name: "Pebble" }, 7);
    expect(fetch).toHaveBeenCalledWith("user:1");
    expect(request).toEqual({ key: 7, assembly: ASSEMBLY, name: "Pebble copy" });
  });

  it("passes a failed fetch on, so the Studio can say what went wrong", async () => {
    const fetch = () => Promise.reject(new Error("unknown_species"));
    await expect(copyRequest(fetch, { speciesId: "user:9", name: "Gone" }, 1)).rejects.toThrow(
      "unknown_species",
    );
  });

  it("is offered for voxel species only, and asks for the species pressed", async () => {
    const onEditCopy = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <MyCreatures
          library={{
            species: [species(1, "drawn"), species(2, "voxel")],
            creatures: 2,
            maxCreatures: 20,
          }}
          thumbnail={() => undefined}
          open={true}
          onToggle={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
          onDelete={() => {}}
          onEditCopy={onEditCopy}
        />,
      ),
    );
    const buttons = [...container.querySelectorAll("button[title='Edit a copy']")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Edit a copy of Creature 2",
    ]);
    await act(async () => (buttons[0] as HTMLButtonElement).click());
    expect(onEditCopy).toHaveBeenCalledWith(expect.objectContaining({ speciesId: "user:2" }));
    await act(async () => root.unmount());
  });
});
