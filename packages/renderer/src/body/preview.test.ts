import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pixels } from "./pixels";
import { createBodyPreview, type BodyPreview } from "./preview";

// The preview without WebGL or a DOM: three's renderer and the browser's frame loop, resize
// observer and window are faked, and each rendered frame's scene is kept.

const rendered: THREE.Scene[] = [];

vi.mock("three", async (importOriginal) => {
  const three = await importOriginal<typeof import("three")>();
  class FakeRenderer {
    domElement = { style: {}, remove() {} };
    outputColorSpace = "";
    render(scene: THREE.Scene) {
      rendered.push(scene);
    }
    setSize() {}
    setPixelRatio() {}
    dispose() {}
    forceContextLoss() {}
  }
  return { ...three, WebGLRenderer: FakeRenderer };
});

let frames: FrameRequestCallback[] = [];
let now = 0;
/** Runs the frame loop for `count` frames of 1/60 s. */
const runFrames = (count: number) => {
  for (let i = 0; i < count; i++) {
    now += 1000 / 60;
    const due = frames;
    frames = [];
    for (const frame of due) frame(now);
  }
};

beforeEach(() => {
  rendered.length = 0;
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("window", {
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  });
});

afterEach(() => vi.unstubAllGlobals());

/** A filled `size` px square, opaque green. */
function square(size: number): Pixels {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) data.set([60, 140, 60, 255], i * 4);
  return { width: size, height: size, data };
}

/** The scenes drawn so far, in the order they were first drawn: one per preview. */
const scenes = () => [...new Set(rendered)];

/** The body's mesh and its tint in `scene`, the latest drawn by default. */
function drawn(scene = rendered.at(-1)) {
  const meshes: THREE.Mesh[] = [];
  scene?.traverse((object) => {
    if (object instanceof THREE.Mesh && object.parent instanceof THREE.Group) meshes.push(object);
  });
  const [body] = meshes;
  const tint = body?.children[0];
  return { body, tint };
}

describe("the body preview's highlights", () => {
  const container = { appendChild() {} } as unknown as HTMLElement;
  const pixels = square(20);
  const highlights = { thin: new Uint8Array(20 * 20).fill(1) };
  let preview: BodyPreview;

  beforeEach(() => {
    preview = createBodyPreview(container);
  });
  afterEach(() => preview.dispose());

  it("builds the tint but doesn't show it at first", () => {
    preview.setDrawing(pixels, highlights);
    runFrames(1);
    const { body, tint } = drawn();
    expect(body).toBeDefined();
    expect(tint).toBeInstanceOf(THREE.Mesh);
    expect(tint?.visible).toBe(false);
  });

  it("shows and hides the tint at once, on the same body", () => {
    preview.setDrawing(pixels, highlights);
    // An odd number: the idle preview draws every other frame from the first, so the next one
    // is skipped unless something changed.
    runFrames(11);
    const before = drawn();
    const count = rendered.length;

    preview.setHighlightsShown(true);
    runFrames(1);
    // A frame is drawn for the change, of the same meshes.
    expect(rendered.length).toBe(count + 1);
    const after = drawn();
    expect(after.body).toBe(before.body);
    expect(after.tint).toBe(before.tint);
    expect(after.tint?.visible).toBe(true);

    preview.setHighlightsShown(false);
    runFrames(1);
    expect(drawn().tint?.visible).toBe(false);
  });

  it("doesn't restart the motion", () => {
    // Two previews hopping in step; one of them shows its tint halfway.
    const control = createBodyPreview(container);
    for (const each of [preview, control]) {
      each.setDrawing(pixels, highlights);
      each.setMotion({ profile: "hop", submersion: 0, speed: 1 });
    }
    runFrames(20);
    preview.setHighlightsShown(true);
    runFrames(5);
    const [shown, hidden] = scenes().map((scene) => drawn(scene).body!.matrix);
    expect(shown!.equals(hidden!)).toBe(true);
    // And it moved, so the poses could tell a restart apart.
    expect(shown!.equals(new THREE.Matrix4().makeScale(1, 1, 0.4))).toBe(false);
    control.dispose();
  });

  it("keeps showing the tint on the next drawing", () => {
    preview.setHighlightsShown(true);
    preview.setDrawing(pixels, highlights);
    runFrames(1);
    expect(drawn().tint?.visible).toBe(true);
  });

  it("builds no tint without highlights, so showing it does nothing", () => {
    preview.setDrawing(pixels);
    preview.setHighlightsShown(true);
    runFrames(1);
    const { body, tint } = drawn();
    expect(body).toBeDefined();
    expect(tint).toBeUndefined();
  });
});
