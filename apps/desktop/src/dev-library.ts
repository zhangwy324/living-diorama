import { formatDiagnostic, type Drawing, type SizeClass } from "@living-diorama/content-schema";
import { encodePng, paintStrokes } from "./drawing";
import { sampleSpecies } from "./sample-species";
import type { SpeciesLibrary } from "./species-library";

// A development-only console hook to the species library (ADR 0014), for checks the Studio (M11)
// doesn't cover. In the dev app's console:
//
//   await livingDiorama.library.saveSample("Puddle", "small")
//   await livingDiorama.library.addCreature(livingDiorama.library.list()[0].speciesId)
//   await livingDiorama.library.saveSamples()   // the twenty species measurements use

/** A round green critter with two eyes and a notch between its feet. */
export const SAMPLE_DRAWING: Drawing = {
  schemaVersion: 2,
  canvas: { width: 256, height: 256 },
  history: [
    { kind: "stroke", tool: "pen", color: "#5a8f3c", width: 150, points: [128, 145, 1] },
    {
      kind: "stroke",
      tool: "pen",
      color: "#5a8f3c",
      width: 60,
      points: [85, 80, 1, 128, 62, 0.9, 171, 80, 1],
    },
    { kind: "stroke", tool: "pen", color: "#1e2a14", width: 16, points: [104, 128, 1] },
    { kind: "stroke", tool: "pen", color: "#1e2a14", width: 16, points: [152, 128, 1] },
    {
      kind: "stroke",
      tool: "eraser",
      color: "#000000",
      width: 26,
      points: [128, 200, 1, 128, 225, 1],
    },
  ],
};

/**
 * Saves a drawing made by code: its strokes are painted once into the image the library keeps,
 * as a player's are in the Studio.
 */
async function saveDrawn(
  library: SpeciesLibrary,
  drawing: Drawing,
  name: string,
  sizeClass: SizeClass,
) {
  return library.save(drawing, await encodePng(paintStrokes(drawing.history)), name, sizeClass);
}

declare global {
  interface Window {
    livingDiorama?: { library?: unknown };
  }
}

/**
 * Saves the twenty sample species (ADR 0016 §11) one after another, so they list in order, and
 * resolves with the names that could not be saved and why.
 */
export async function saveSampleSpecies(library: SpeciesLibrary): Promise<string[]> {
  const failed: string[] = [];
  for (const { name, sizeClass, drawing } of sampleSpecies()) {
    const saved = await saveDrawn(library, drawing, name, sizeClass);
    if (!saved.ok) failed.push([name, ...saved.diagnostics.map(formatDiagnostic)].join(": "));
  }
  return failed;
}

/**
 * Puts the library on `window.livingDiorama.library`, with `saveSample` to add a drawn species
 * and `saveSamples` to add the twenty sample species.
 */
export function installLibraryDevHook(library: SpeciesLibrary): void {
  window.livingDiorama = {
    ...window.livingDiorama,
    library: {
      ...library,
      saveSample: (name = "Sample", sizeClass: SizeClass = "small") =>
        saveDrawn(library, SAMPLE_DRAWING, name, sizeClass),
      saveSamples: () => saveSampleSpecies(library),
    },
  };
}
