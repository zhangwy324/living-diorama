import { parseDrawing, SIZE_CLASSES } from "@living-diorama/content-schema";
import { expect, it } from "vitest";
import { sampleSpecies } from "./sample-species";

const SAMPLE_SPECIES = sampleSpecies();

it("has twenty valid drawings", () => {
  expect(SAMPLE_SPECIES).toHaveLength(20);
  for (const { name, drawing } of SAMPLE_SPECIES) {
    expect(parseDrawing(drawing, name)).toMatchObject({ ok: true });
  }
});

it("varies names, colours and sizes", () => {
  const names = new Set(SAMPLE_SPECIES.map(({ name }) => name));
  const palettes = new Set(
    SAMPLE_SPECIES.map(({ drawing }) => [...new Set(drawing.history.map((s) => s.color))].join()),
  );
  const sizes = new Set(SAMPLE_SPECIES.map(({ sizeClass }) => sizeClass));
  expect(names.size).toBe(20);
  expect(palettes.size).toBe(20);
  expect([...sizes].sort()).toEqual(Object.keys(SIZE_CLASSES).sort());
});
