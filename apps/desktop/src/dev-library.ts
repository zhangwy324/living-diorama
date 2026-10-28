import type { Drawing, SizeClass } from "@living-diorama/content-schema";
import { rasterize } from "./drawing";
import type { SpeciesLibrary } from "./species-library";

// A development-only console hook to the species library (ADR 0014), for checks the Studio (M11)
// doesn't cover. In the dev app's console:
//
//   await livingDiorama.library.saveSample("Puddle", "small")
//   await livingDiorama.library.addCreature(livingDiorama.library.list()[0].speciesId)

/** A round green critter with two eyes and a notch between its feet. */
export const SAMPLE_DRAWING: Drawing = {
  schemaVersion: 1,
  canvas: { width: 256, height: 256 },
  strokes: [
    { tool: "pen", color: "#5a8f3c", width: 150, points: [128, 145, 1] },
    { tool: "pen", color: "#5a8f3c", width: 60, points: [85, 80, 1, 128, 62, 0.9, 171, 80, 1] },
    { tool: "pen", color: "#1e2a14", width: 16, points: [104, 128, 1] },
    { tool: "pen", color: "#1e2a14", width: 16, points: [152, 128, 1] },
    { tool: "eraser", color: "#000000", width: 26, points: [128, 200, 1, 128, 225, 1] },
  ],
};

declare global {
  interface Window {
    livingDiorama?: { library?: unknown };
  }
}

/** Puts the library on `window.livingDiorama.library`, with `saveSample` to add a drawn species. */
export function installLibraryDevHook(library: SpeciesLibrary): void {
  window.livingDiorama = {
    ...window.livingDiorama,
    library: {
      ...library,
      saveSample: async (name = "Sample", sizeClass: SizeClass = "small") =>
        library.save(SAMPLE_DRAWING, await rasterize(SAMPLE_DRAWING), name, sizeClass),
    },
  };
}
