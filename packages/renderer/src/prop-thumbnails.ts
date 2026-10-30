import * as THREE from "three";
import { drawIcon, type IconRenderer } from "./cue-icons";
import type { PropModel } from "./props";

// Thumbnails of prop models for the editor's prop drawer (ADR 0021): the same three-quarter
// picture in plain daylight as a cue bubble's prop picture (`cue-icons.ts`), read back from the
// GPU as an image the app can show in a tile. No icon files are authored.

/** What thumbnails use of a renderer. A `THREE.WebGLRenderer` fits. */
export type ThumbnailRenderer = IconRenderer & Pick<THREE.WebGLRenderer, "readRenderTargetPixels">;

/**
 * Turns a thumbnail's pixels into an image URL: `pixels` are `size` × `size` RGBA in sRGB, top row
 * first, with straight (not premultiplied) alpha, as `ImageData` holds them.
 */
export type ThumbnailEncoder = (pixels: Uint8ClampedArray, size: number) => string;

/** The largest thumbnail drawn, in pixels square. */
export const MAX_THUMBNAIL_SIZE = 1024;

/** Encodes thumbnails as PNG data URLs through a 2D canvas of `document`. */
export function canvasEncoder(document: Document): ThumbnailEncoder {
  return (pixels, size) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2D canvas context to encode a prop thumbnail");
    const image = context.createImageData(size, size);
    image.data.set(pixels);
    context.putImageData(image, 0, 0);
    return canvas.toDataURL("image/png");
  };
}

/** Linear value of each 8-bit sRGB value. */
const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const c = i / 255;
  return c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

/** The sRGB value, 0 to 1, of a linear one. */
const linearToSrgb = (c: number) => (c < 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * A thumbnail's pixels as read from its render target (bottom row first, colour premultiplied by
 * the coverage the multisampling gives a model's edges) turned into an image's: top row first,
 * with straight alpha, so edges show no dark fringe on a light tile. The colour is unpremultiplied
 * in linear light, where the samples were averaged.
 */
export function thumbnailPixels(raw: Uint8Array, size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4);
  const row = size * 4;
  for (let y = 0; y < size; y++) {
    const from = (size - 1 - y) * row;
    const to = y * row;
    for (let x = 0; x < row; x += 4) {
      const alpha = raw[from + x + 3] ?? 0;
      out[to + x + 3] = alpha;
      if (alpha === 0) continue;
      for (let c = 0; c < 3; c++) {
        const value = raw[from + x + c] ?? 0;
        out[to + x + c] =
          alpha === 255
            ? value
            : Math.round(
                linearToSrgb(Math.min(1, (SRGB_TO_LINEAR[value] ?? 0) / (alpha / 255))) * 255,
              );
      }
    }
  }
  return out;
}

/**
 * Thumbnails of prop models by asset ref and size, drawn with the view's renderer when first
 * asked for and kept as image URLs, so each model is drawn once per size. The models come from the
 * view's `PropSet`, so a model already loaded for the world is not loaded again. A ref with no
 * model, or whose model failed to load, gets a thumbnail of the fallback block, which is not kept,
 * so a later call draws the model if it has arrived since.
 *
 * GPU resources: each thumbnail's render target is freed as soon as it is read back; the models
 * belong to the `PropSet`. `dispose` forgets the thumbnails, and thumbnails still being drawn
 * resolve to undefined.
 */
export class PropThumbnails {
  readonly #renderer: ThumbnailRenderer;
  readonly #model: (ref: string) => Promise<PropModel>;
  readonly #encode: ThumbnailEncoder;
  readonly #cache = new Map<string, Promise<string | undefined>>();
  #disposed = false;

  constructor(
    renderer: ThumbnailRenderer,
    model: (ref: string) => Promise<PropModel>,
    encode: ThumbnailEncoder,
  ) {
    this.#renderer = renderer;
    this.#model = model;
    this.#encode = encode;
  }

  /**
   * An image URL of the model with this asset ref, `size` pixels square (rounded, at most
   * `MAX_THUMBNAIL_SIZE`), on a transparent background; undefined once disposed.
   */
  thumbnail(ref: string, size: number): Promise<string | undefined> {
    if (!(size >= 1)) return Promise.reject(new RangeError(`Bad thumbnail size ${size}`));
    const pixels = Math.min(MAX_THUMBNAIL_SIZE, Math.round(size));
    const key = `${pixels}:${ref}`;
    let thumbnail = this.#cache.get(key);
    if (!thumbnail) {
      thumbnail = this.#draw(ref, pixels, key);
      this.#cache.set(key, thumbnail);
    }
    return thumbnail;
  }

  async #draw(ref: string, size: number, key: string): Promise<string | undefined> {
    let model: PropModel;
    try {
      model = await this.#model(ref);
    } catch (cause) {
      this.#cache.delete(key);
      throw cause;
    }
    if (this.#disposed) return undefined;
    // The fallback block stands in for now; a later call tries the model again.
    if (!model.loaded) this.#cache.delete(key);
    const target = new THREE.WebGLRenderTarget(size, size, {
      samples: 4,
      // Stored in sRGB, so the picture reads back as an image's bytes without banding.
      colorSpace: THREE.SRGBColorSpace,
    });
    try {
      drawIcon(this.#renderer, model.model, target);
      const raw = new Uint8Array(size * size * 4);
      this.#renderer.readRenderTargetPixels(target, 0, 0, size, size, raw);
      return this.#encode(thumbnailPixels(raw, size), size);
    } catch (cause) {
      this.#cache.delete(key);
      throw cause;
    } finally {
      target.dispose();
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#cache.clear();
  }
}
