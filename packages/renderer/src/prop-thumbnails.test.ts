import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { PropModel } from "./props";
import {
  MAX_THUMBNAIL_SIZE,
  PropThumbnails,
  thumbnailPixels,
  type ThumbnailRenderer,
} from "./prop-thumbnails";

const bush = () => {
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
  return model;
};

/** Stands in for a WebGL renderer: records draws, and reads back every pixel as opaque grey. */
function fakeRenderer() {
  let target: THREE.WebGLRenderTarget | null = null;
  const drawn: { scene: THREE.Scene; target: THREE.WebGLRenderTarget | null }[] = [];
  const setClearColor = vi.fn();
  const renderer = {
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => (target = t),
    getClearColor: (out: THREE.Color) => out.set("#123456"),
    getClearAlpha: () => 1,
    setClearColor,
    clear: vi.fn(),
    render: (scene: THREE.Scene) => drawn.push({ scene, target }),
    readRenderTargetPixels: vi.fn(
      (
        _t: THREE.WebGLRenderTarget,
        _x: number,
        _y: number,
        w: number,
        h: number,
        out: Uint8Array,
      ) => {
        for (let i = 0; i < w * h * 4; i++) out[i] = i % 4 === 3 ? 255 : 128;
      },
    ),
  };
  return {
    renderer: renderer as unknown as ThumbnailRenderer,
    drawn,
    setClearColor,
    readPixels: renderer.readRenderTargetPixels,
    target: () => target,
  };
}

/** The models by ref; any other ref gets the fallback block, as `PropSet.model` gives. */
function models(byRef: Record<string, THREE.Object3D>) {
  const fallback = bush();
  return vi.fn(async (ref: string): Promise<PropModel> => ({
    model: byRef[ref] ?? fallback,
    loaded: ref in byRef,
    unitScale: () => 1,
  }));
}

const encoder = () =>
  vi.fn((pixels: Uint8ClampedArray, size: number) => `png:${size}:${pixels[0]}`);

describe("prop thumbnails", () => {
  it("draws each model once per size, as a cue bubble's picture, and frees the target", async () => {
    const { renderer, drawn, setClearColor, readPixels, target } = fakeRenderer();
    const model = models({ "test:bush": bush() });
    const encode = encoder();
    const thumbnails = new PropThumbnails(renderer, model, encode);

    const [first, again] = await Promise.all([
      thumbnails.thumbnail("test:bush", 64),
      thumbnails.thumbnail("test:bush", 64.2),
    ]);
    expect(first).toBe("png:64:128");
    expect(again).toBe(first);
    expect(drawn).toHaveLength(1);
    expect(model).toHaveBeenCalledTimes(1);
    const drawnTo = drawn[0]!.target!;
    expect([drawnTo.width, drawnTo.height]).toEqual([64, 64]);
    expect(drawnTo.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(readPixels).toHaveBeenCalledWith(drawnTo, 0, 0, 64, 64, expect.any(Uint8Array));
    expect(encode).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 64);
    // The renderer is left drawing to the screen again, with its clear colour back.
    expect(target()).toBeNull();
    expect(setClearColor).toHaveBeenLastCalledWith(new THREE.Color("#123456"), 1);
    // The staged copy of the model is lit and holds the model's mesh.
    expect(drawn[0]!.scene.children.some((o) => o instanceof THREE.Mesh)).toBe(true);

    // Kept: asking again draws nothing; another size is drawn anew.
    expect(await thumbnails.thumbnail("test:bush", 64)).toBe(first);
    expect(drawn).toHaveLength(1);
    expect(await thumbnails.thumbnail("test:bush", 96)).toBe("png:96:128");
    expect(drawn).toHaveLength(2);
  });

  it("frees each render target once read back", async () => {
    const { renderer, drawn } = fakeRenderer();
    const disposed = vi.spyOn(THREE.WebGLRenderTarget.prototype, "dispose");
    const thumbnails = new PropThumbnails(renderer, models({ "test:bush": bush() }), encoder());
    await thumbnails.thumbnail("test:bush", 32);
    expect(disposed.mock.contexts).toEqual([drawn[0]!.target]);
    disposed.mockRestore();
  });

  it("rounds the size, caps it and rejects one below a pixel", async () => {
    const { renderer, drawn } = fakeRenderer();
    const thumbnails = new PropThumbnails(renderer, models({ "test:bush": bush() }), encoder());
    await thumbnails.thumbnail("test:bush", 1e6);
    expect(drawn[0]!.target!.width).toBe(MAX_THUMBNAIL_SIZE);
    await expect(thumbnails.thumbnail("test:bush", 0.4)).rejects.toThrow(RangeError);
    await expect(thumbnails.thumbnail("test:bush", NaN)).rejects.toThrow(RangeError);
  });

  it("draws the fallback block once per size for every ref with no model", async () => {
    const { renderer, drawn } = fakeRenderer();
    const thumbnails = new PropThumbnails(renderer, models({}), encoder());
    expect(await thumbnails.thumbnail("test:gone", 48)).toBe("png:48:128");
    expect(await thumbnails.thumbnail("test:gone", 48)).toBe("png:48:128");
    expect(await thumbnails.thumbnail("test:lost", 48)).toBe("png:48:128");
    expect(drawn).toHaveLength(1);
    expect(await thumbnails.thumbnail("test:lost", 96)).toBe("png:96:128");
    expect(drawn).toHaveLength(2);
  });

  it("forgets a thumbnail that failed, so it can be asked for again", async () => {
    const { renderer, drawn } = fakeRenderer();
    const encode = encoder().mockImplementationOnce(() => {
      throw new Error("no canvas");
    });
    const thumbnails = new PropThumbnails(renderer, models({ "test:bush": bush() }), encode);
    await expect(thumbnails.thumbnail("test:bush", 48)).rejects.toThrow("no canvas");
    expect(await thumbnails.thumbnail("test:bush", 48)).toBe("png:48:128");
    expect(drawn).toHaveLength(2);
  });

  it("draws nothing once disposed, even for a model still loading", async () => {
    const { renderer, drawn } = fakeRenderer();
    let arrive: (model: PropModel) => void = () => undefined;
    const loading = new Promise<PropModel>((resolve) => (arrive = resolve));
    const thumbnails = new PropThumbnails(renderer, () => loading, encoder());
    const pending = thumbnails.thumbnail("test:bush", 48);
    thumbnails.dispose();
    arrive({ model: bush(), loaded: true, unitScale: () => 1 });
    expect(await pending).toBeUndefined();
    expect(await thumbnails.thumbnail("test:bush", 48)).toBeUndefined();
    expect(drawn).toHaveLength(0);
  });

  it("turns read-back pixels into an image's: top row first, edges unpremultiplied", () => {
    // 2 × 2: bottom row opaque red and clear; top row a half-covered white edge and opaque blue.
    const raw = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0, 188, 188, 188, 128, 0, 0, 255, 255]);
    expect([...thumbnailPixels(raw, 2)]).toEqual([
      // sRGB 188 is about half of white in linear light: at half coverage, white.
      255, 255, 255, 128, 0, 0, 255, 255, 255, 0, 0, 255, 0, 0, 0, 0,
    ]);
  });
});
