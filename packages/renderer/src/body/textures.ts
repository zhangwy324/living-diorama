import { nearest } from "./distance";
import { isOpaque, type Pixels } from "./pixels";

// The body's texture (ADR 0011 §5, ADR 0017): fully opaque RGBA, rows top first.

/**
 * The drawing, every pixel that isn't drawn taking the colour of the nearest drawn pixel (alpha at
 * least half, `isOpaque`). Faces show the drawing; a wall's texture coordinates sit on the outline,
 * so each point of a wall takes the colour of the drawn pixel nearest it: the rim's own colour.
 * Pixels are read un-premultiplied, as canvas `ImageData` holds them, and the barely visible edge
 * of a stroke never seeds a colour, so the walls don't speckle.
 */
export function bodyColours(pixels: Pixels): Uint8Array {
  const { width, height, data } = pixels;
  const drawn = new Uint8Array(width * height);
  for (let i = 0; i < drawn.length; i++) drawn[i] = isOpaque(pixels, i) ? 1 : 0;
  const { index } = nearest(drawn, width, height);
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < index.length; i++) {
    const seed = index[i] ?? -1;
    if (seed >= 0) out.set(data.subarray(seed * 4, seed * 4 + 3), i * 4);
    out[i * 4 + 3] = 255;
  }
  return out;
}
