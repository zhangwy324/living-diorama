import { STROKE_POINT_STRIDE, type Drawing, type SizeClass } from "@living-diorama/content-schema";
import type { SpeciesLibrary } from "./species-library";

// A development-only console hook to the species library (ADR 0014), until the Studio (M11)
// gives it a UI. In the dev app's console:
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

/** Draws `drawing` to PNG bytes: each segment as wide as its pressure, the eraser cutting out. */
export async function rasterize(drawing: Drawing): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(drawing.canvas.width, drawing.canvas.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas");
  context.lineCap = "round";
  for (const { tool, color, width, points } of drawing.strokes) {
    context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = color;
    const at = (i: number) => points.slice(i, i + STROKE_POINT_STRIDE) as [number, number, number];
    for (let i = 0; i < points.length; i += STROKE_POINT_STRIDE) {
      const [x, y, pressure] = at(i);
      // A lone point is a dot: a zero-length segment with round caps.
      const [fromX, fromY] = i === 0 ? [x, y] : at(i - STROKE_POINT_STRIDE);
      context.lineWidth = width * pressure;
      context.beginPath();
      context.moveTo(fromX, fromY);
      context.lineTo(x, y);
      context.stroke();
    }
  }
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

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
