/** RGBA pixels, rows top first. `ImageData` fits. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** Reads an image as pixels. Injectable, so bodies can be built in tests without a DOM. */
export type ImageReader = (url: string) => Promise<Pixels>;

/** Images are read at this size along their longer side (roadmap §2.6 R4). */
export const BODY_IMAGE_SIZE = 256;

/** A pixel at or above this alpha belongs to the drawing. */
export const ALPHA_THRESHOLD = 128;

export const readImage: ImageReader = async (url) => {
  const image = new Image();
  image.src = url;
  await image.decode();
  const longest = Math.max(image.naturalWidth, image.naturalHeight) || BODY_IMAGE_SIZE;
  const scale = BODY_IMAGE_SIZE / longest;
  const width = Math.max(1, Math.round((image.naturalWidth || longest) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || longest) * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas to read images with");
  context.drawImage(image, 0, 0, width, height);
  return context.getImageData(0, 0, width, height);
};

/** Whether the pixel at index `i` belongs to the drawing. */
export function isOpaque(pixels: Pixels, i: number): boolean {
  return (pixels.data[i * 4 + 3] ?? 0) >= ALPHA_THRESHOLD;
}

/** The indices of pixel `i`'s neighbours along rows and columns, and diagonally if asked. */
export function* neighbours(
  i: number,
  width: number,
  height: number,
  diagonals = false,
): Generator<number> {
  const x = i % width;
  const left = x > 0;
  const right = x < width - 1;
  const up = i >= width;
  const down = i < width * (height - 1);
  if (left) yield i - 1;
  if (right) yield i + 1;
  if (up) yield i - width;
  if (down) yield i + width;
  if (!diagonals) return;
  if (up && left) yield i - width - 1;
  if (up && right) yield i - width + 1;
  if (down && left) yield i + width - 1;
  if (down && right) yield i + width + 1;
}
