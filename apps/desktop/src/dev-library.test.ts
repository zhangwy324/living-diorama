import { parseDrawing } from "@living-diorama/content-schema";
import { describe, expect, it, vi } from "vitest";
import { SAMPLE_DRAWING, saveVoxelSample } from "./dev-library";
import type { SpeciesLibrary } from "./species-library";

it("ships a valid sample drawing", () => {
  expect(parseDrawing(SAMPLE_DRAWING).ok).toBe(true);
});

describe("the voxel sample", () => {
  const library = () =>
    ({
      saveVoxel: vi.fn(() =>
        Promise.resolve({ ok: true as const, value: { speciesId: "user:1" } }),
      ),
      addCreature: vi.fn(() => Promise.resolve({ ok: true as const, value: "creature-1" })),
    }) as unknown as SpeciesLibrary & {
      saveVoxel: ReturnType<typeof vi.fn>;
      addCreature: ReturnType<typeof vi.fn>;
    };

  it("saves the sample assembly with the plan's ways of moving and adds a creature", async () => {
    const lib = library();
    const saved = await saveVoxelSample(lib, "land+swim");
    expect(saved).toEqual({
      ok: true,
      value: { species: { speciesId: "user:1" }, creatureId: "creature-1" },
    });
    expect(lib.saveVoxel).toHaveBeenCalledWith(
      expect.objectContaining({ instances: expect.any(Array) }),
      "Voxel land+swim",
      { locomotion: { land: true, gait: "walk", swim: true } },
    );
    expect(lib.addCreature).toHaveBeenCalledWith("user:1");
  });

  it("refuses a plan it doesn't know", async () => {
    const lib = library();
    const saved = await saveVoxelSample(lib, "fly" as never);
    expect(saved.ok ? [] : saved.diagnostics.map((d) => d.code)).toEqual(["unknown_plan"]);
    expect(lib.saveVoxel).not.toHaveBeenCalled();
  });
});
