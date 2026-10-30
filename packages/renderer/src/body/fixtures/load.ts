import edgeDetails from "./edge-details.png?inline";
import mossling from "./mossling.png?inline";
import noOutline from "./no-outline.png?inline";
import outline from "./outline.png?inline";
import separateShapes from "./separate-shapes.png?inline";
import thickOutline from "./thick-outline.png?inline";
import thinLimbs from "./thin-limbs.png?inline";
import type { Pixels } from "../pixels";

// The body fixtures for tests (see README.md): drawings made in the Creation Studio, and the
// drawn mossling the built-in pack had until M20, as the renderer reads it.

export interface Fixture {
  name: string;
  url: string;
  /** The colours the drawing was made with: its strokes' colours. */
  palette: string[];
}

export const STUDIO_FIXTURES: Fixture[] = [
  { name: "outline", url: outline, palette: ["#1e2a14", "#8a56b5"] },
  { name: "no-outline", url: noOutline, palette: ["#7a4a2a"] },
  { name: "thick-outline", url: thickOutline, palette: ["#f0a6c0", "#f2cf3c"] },
  { name: "edge-details", url: edgeDetails, palette: ["#1e2a14", "#3c7fc2", "#f2cf3c"] },
  { name: "thin-limbs", url: thinLimbs, palette: ["#1e2a14", "#7a4a2a", "#f0a6c0"] },
  {
    name: "separate-shapes",
    url: separateShapes,
    palette: ["#000000", "#8a8f86", "#f0a6c0", "#f2cf3c"],
  },
];

/** The drawn mossling of before M20, rasterised at 256 px as `readImage` reads it. */
export const MOSSLING = mossling;

/** Decodes an 8-bit RGBA, non-interlaced PNG data URL, as the Studio writes them. */
export async function decodePng(url: string): Promise<Pixels> {
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      [width, height] = [view.getUint32(offset + 8), view.getUint32(offset + 12)];
      if (chunk[8] !== 8 || chunk[9] !== 6 || chunk[12] !== 0) throw new Error("Not 8-bit RGBA");
    }
    if (type === "IDAT") idat.push(chunk);
    offset += length + 12;
  }
  const stream = new Blob(idat as BlobPart[])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = width * 4;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x] ?? 0;
      const a = x >= 4 ? (data[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (data[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (data[(y - 1) * stride + x - 4] ?? 0) : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter ?? 0] ?? 0;
      data[y * stride + x] = (value + predictor) & 255;
    }
  }
  return { width, height, data };
}
