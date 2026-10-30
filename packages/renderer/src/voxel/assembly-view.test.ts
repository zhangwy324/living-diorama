import { VoxelAssemblySchema, type VoxelAssembly } from "@living-diorama/content-schema";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssemblyView, type AssemblyView } from "./assembly-view";
import { creature } from "./test-creature";

// The assembly view without WebGL or a DOM: three's renderer and the browser's frame loop, resize
// observer and window are faked, and each rendered frame's scene is kept.

const rendered: THREE.Scene[] = [];
/** The canvas's place on the page, in CSS pixels. */
const RECT = { left: 100, top: 50, width: 400, height: 300 };

vi.mock("three", async (importOriginal) => {
  const three = await importOriginal<typeof import("three")>();
  class FakeRenderer {
    domElement = Object.assign(new EventTarget(), {
      style: {},
      remove() {},
      getBoundingClientRect: () => RECT,
      getRootNode: () => new EventTarget(),
      ownerDocument: new EventTarget(),
      setPointerCapture() {},
      releasePointerCapture() {},
    });
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

const container = { appendChild() {}, ownerDocument: {} } as unknown as HTMLElement;
const parsed = (): VoxelAssembly => VoxelAssemblySchema.parse(creature());

/** What the last frame drew on the creature's rig. */
function drawn() {
  const scene = rendered.at(-1)!;
  const skinned: THREE.SkinnedMesh[] = [];
  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => {
    if (o instanceof THREE.SkinnedMesh) skinned.push(o);
    else if (o instanceof THREE.Mesh) meshes.push(o);
  });
  const [body, tint] = skinned;
  const markers = meshes.filter((m) => m.geometry instanceof THREE.SphereGeometry);
  const ghosts = meshes.filter((m) => m.renderOrder === 1);
  return { body, tint, markers, ghosts, rig: body?.parent };
}

describe("the assembly view", () => {
  let view: AssemblyView;
  beforeEach(() => {
    view = createAssemblyView(container);
  });
  afterEach(() => view.dispose());

  it("rebuilds only for a new assembly, freeing the old body", () => {
    const geometries = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const skeletons = vi.spyOn(THREE.Skeleton.prototype, "dispose");
    const assembly = parsed();
    view.setAssembly(assembly);
    runFrames(1);
    const first = drawn();
    expect(first.body?.skeleton.bones).toHaveLength(assembly.instances.length);

    view.setAssembly(assembly);
    runFrames(1);
    expect(drawn().body).toBe(first.body);
    expect(geometries).not.toHaveBeenCalled();

    view.setAssembly(parsed());
    runFrames(1);
    expect(drawn().body).not.toBe(first.body);
    expect(geometries.mock.contexts).toEqual([first.body!.geometry]);
    expect(skeletons.mock.contexts).toEqual([first.body!.skeleton, first.tint!.skeleton]);

    view.setAssembly(undefined);
    runFrames(1);
    expect(drawn().body).toBeUndefined();
    geometries.mockRestore();
    skeletons.mockRestore();
  });

  it("marks the sockets asked for, on the body, and only those it has", () => {
    view.setAssembly(parsed());
    view.setHighlightedSockets([
      { instance: "torso", socket: "left" },
      { instance: "tail", socket: "b" },
      { instance: "torso", socket: "nope" },
    ]);
    runFrames(1);
    expect(drawn().markers).toHaveLength(2);
    // A new assembly without the tail keeps the marks it can.
    const tailless = creature();
    tailless.instances = tailless.instances.filter((i) => !/^(tail|fin)/.test(i.id));
    delete tailless.parts.tail;
    delete tailless.parts.fin;
    view.setAssembly(VoxelAssemblySchema.parse(tailless));
    runFrames(1);
    expect(drawn().markers).toHaveLength(1);
    view.setHighlightedSockets([]);
    runFrames(1);
    expect(drawn().markers).toHaveLength(0);
  });

  it("tints the selected parts only", () => {
    const assembly = parsed();
    view.setAssembly(assembly);
    runFrames(1);
    expect(drawn().tint?.visible).toBe(false);
    view.setSelection(["left-arm", "right-arm"]);
    runFrames(1);
    const { tint, body } = drawn();
    expect(tint?.visible).toBe(true);
    tint!.skeleton.bones.forEach((bone, i) => {
      const id = assembly.instances[i]!.id;
      const selected = id === "left-arm" || id === "right-arm";
      expect(bone.matrixWorld.equals(body!.skeleton.bones[i]!.matrixWorld), id).toBe(selected);
      expect(bone.matrixWorld.determinant() === 0, id).toBe(!selected);
    });
    view.setSelection(["gone"]);
    runFrames(1);
    expect(drawn().tint?.visible).toBe(false);
  });

  it("shows a ghost at each socket asked for and frees it when changed", () => {
    const assembly = parsed();
    view.setAssembly(assembly);
    view.setGhost({
      part: assembly.parts.arm!,
      sockets: [
        { instance: "torso", socket: "left" },
        { instance: "torso", socket: "right" },
        { instance: "torso", socket: "nope" },
      ],
    });
    runFrames(1);
    const { ghosts } = drawn();
    expect(ghosts).toHaveLength(2);
    expect(ghosts[0]!.geometry).not.toBe(ghosts[1]!.geometry);
    const geometries = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    view.setGhost(undefined);
    runFrames(1);
    expect(drawn().ghosts).toHaveLength(0);
    expect(geometries.mock.contexts).toEqual(ghosts.map((g) => g.geometry));
    geometries.mockRestore();
  });

  it("picks the body under the middle of the canvas, and nothing at its corner", () => {
    view.setAssembly(parsed());
    const middle = view.pick(RECT.left + RECT.width / 2, RECT.top + RECT.height / 2);
    expect(middle?.kind).toBe("part");
    expect(view.pick(RECT.left + 1, RECT.top + 1)).toBeUndefined();
  });

  it("walks in place while asked to, and stands still after", () => {
    view.setAssembly(parsed());
    view.setTestWalk({ profile: "walk", submersion: 0, speed: 0.6 });
    runFrames(10);
    const count = rendered.length;
    expect(drawn().rig!.matrix.equals(new THREE.Matrix4())).toBe(false);
    runFrames(5);
    // A walking creature is drawn every frame.
    expect(rendered.length).toBe(count + 5);
    view.setTestWalk(undefined);
    runFrames(1);
    expect(drawn().rig!.matrix.equals(new THREE.Matrix4())).toBe(true);
    const still = rendered.length;
    runFrames(5);
    // And a still one only when something changes.
    expect(rendered.length).toBe(still);
  });

  it("frees its materials and geometries on dispose", () => {
    const materials = vi.spyOn(THREE.Material.prototype, "dispose");
    const other = createAssemblyView(container);
    other.setAssembly(parsed());
    other.dispose();
    // The body's, the tint's, the ghost's, the markers', the grid's and the water's.
    expect(materials).toHaveBeenCalledTimes(6);
    materials.mockRestore();
  });
});
