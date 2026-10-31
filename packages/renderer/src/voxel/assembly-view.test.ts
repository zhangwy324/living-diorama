import {
  VoxelAssemblySchema,
  type PartMotion,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssemblyView, hiddenParts, type AssemblyView } from "./assembly-view";
import { buildVoxelBody } from "./body";
import { creature } from "../body/fixtures/voxel-creature";

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
/** The resize observers' callbacks, to resize the canvas. */
let resizers: ((entries: { contentRect: { width: number; height: number } }[]) => void)[] = [];
const resize = (width: number, height: number) =>
  resizers.forEach((callback) => callback([{ contentRect: { width, height } }]));
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
  resizers = [];
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => frames.push(frame));
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(
        callback: (entries: { contentRect: { width: number; height: number } }[]) => void,
      ) {
        resizers.push(callback);
      }
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

  it("picks sockets by a larger sphere than the dot it draws", () => {
    view.setAssembly(parsed());
    view.setHighlightedSockets([{ instance: "torso", socket: "left" }]);
    runFrames(1);
    const [marker] = drawn().markers;
    const shown = marker!.scale.x;
    const picked: number[] = [];
    const intersect = vi
      .spyOn(THREE.Raycaster.prototype, "intersectObjects")
      .mockImplementation((objects) => {
        picked.push(...objects.map((o) => o.scale.x));
        return [];
      });
    view.pick(...MIDDLE);
    intersect.mockRestore();
    expect(picked).toHaveLength(1);
    expect(picked[0]! / shown).toBeCloseTo(0.016 / 0.009);
    // Drawn at its own size again.
    expect(marker!.scale.x).toBe(shown);
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

/** A probe's ray as three.js vectors. */
const ray = (probe: { origin: THREE.Vector3Like; direction: THREE.Vector3Like }) =>
  new THREE.Ray(new THREE.Vector3().copy(probe.origin), new THREE.Vector3().copy(probe.direction));
const MIDDLE = [RECT.left + RECT.width / 2, RECT.top + RECT.height / 2] as const;
const RIGHT_EDGE = [RECT.left + RECT.width, RECT.top + RECT.height / 2] as const;

describe("the assembly view's probe, ghost and life cycle", () => {
  it("probes from the camera in the body frame, however the walk moves the body", () => {
    const view = createAssemblyView(container);
    view.setAssembly(parsed());
    const still = ray(view.probe(...MIDDLE)!);
    expect(still.direction.length()).toBeCloseTo(1, 9);
    view.setTestWalk({ profile: "walk", submersion: 0, speed: 0.6 });
    runFrames(10);
    const rig = drawn().rig!.matrix;
    expect(rig.equals(new THREE.Matrix4())).toBe(false);
    const walking = ray(view.probe(...MIDDLE)!);
    // The same world ray, taken into the moved body's frame.
    const expected = still.clone().applyMatrix4(rig.clone().invert());
    expect(walking.origin.distanceTo(expected.origin)).toBeLessThan(1e-9);
    expect(walking.direction.distanceTo(expected.direction)).toBeLessThan(1e-9);
    view.dispose();
  });

  /** The angle between the probes through the middle and the right edge: half the view's width. */
  const halfWidth = (view: AssemblyView) =>
    ray(view.probe(...MIDDLE)!).direction.angleTo(ray(view.probe(...RIGHT_EDGE)!).direction);
  const halfWidthAt = (aspect: number) =>
    Math.atan(Math.tan(THREE.MathUtils.degToRad(15)) * aspect);

  it("takes its first shape from the container, frames on the first resize, then keeps the fit", () => {
    const wide = { ...container, clientWidth: 800, clientHeight: 200 } as unknown as HTMLElement;
    const shaped = createAssemblyView(wide);
    expect(halfWidth(shaped)).toBeCloseTo(halfWidthAt(4), 6);
    shaped.dispose();

    const view = createAssemblyView(container);
    view.setAssembly(parsed());
    const distance = () => ray(view.probe(...MIDDLE)!).origin.length();
    const square = distance();
    // A tall, narrow canvas needs the camera further out to see the body whole.
    resize(100, 400);
    expect(halfWidth(view)).toBeCloseTo(halfWidthAt(0.25), 6);
    const narrow = distance();
    expect(narrow).toBeGreaterThan(square * 1.5);
    // Later resizes keep the body's share of the view: back to square, back to the square fit.
    resize(400, 400);
    expect(distance()).toBeCloseTo(square, 9);
    view.dispose();
  });

  it("pulls back along the camera's own line when the canvas narrows later", () => {
    const view = createAssemblyView(container);
    view.setAssembly(parsed());
    resize(400, 400);
    const before = ray(view.probe(...MIDDLE)!);
    // A side panel opens: the canvas is half as wide.
    resize(200, 400);
    const after = ray(view.probe(...MIDDLE)!);
    expect(after.origin.length()).toBeGreaterThan(before.origin.length() * 1.5);
    // Same orbit: the camera looks the same way.
    expect(after.direction.distanceTo(before.direction)).toBeLessThan(1e-9);
    expect(halfWidth(view)).toBeCloseTo(halfWidthAt(0.5), 6);
    view.dispose();
  });

  it("hides the part a ghost would replace, and what hangs from it, while it is there", () => {
    const view = createAssemblyView(container);
    const assembly = parsed();
    view.setAssembly(assembly);
    view.setSelection(["left-arm"]);
    view.setGhost({
      part: assembly.parts.arm!,
      sockets: [{ instance: "torso", socket: "left" }],
      rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
    });
    runFrames(1);
    const { body, tint } = drawn();
    const collapsed = (bones: THREE.Bone[]) =>
      bones.flatMap((bone, i) =>
        bone.matrixWorld.determinant() === 0 ? [assembly.instances[i]!.id] : [],
      );
    expect(collapsed(body!.skeleton.bones)).toEqual(["left-arm", "left-hand"]);
    // The hidden part's tint goes with it.
    expect(tint!.visible).toBe(false);
    view.setGhost(undefined);
    runFrames(1);
    expect(collapsed(drawn().body!.skeleton.bones)).toEqual([]);
    expect(drawn().tint!.visible).toBe(true);

    // Hidden parts can't be picked: the right arm and hand, here, are seen and picked until a
    // ghost takes their place, and found again once it goes.
    const picked = () => {
      const found = new Set<string>();
      for (let x = 0; x <= RECT.width; x += 20) {
        for (let y = 0; y <= RECT.height; y += 20) {
          const pick = view.pick(RECT.left + x, RECT.top + y);
          if (pick?.kind === "part") found.add(pick.instance);
        }
      }
      return found;
    };
    const right = (found: Set<string>) => [...found].filter((id) => id.startsWith("right-"));
    expect(right(picked())).not.toEqual([]);
    view.setGhost({ part: assembly.parts.arm!, sockets: [{ instance: "torso", socket: "right" }] });
    expect(right(picked())).toEqual([]);
    view.setGhost(undefined);
    expect(right(picked())).not.toEqual([]);
    view.dispose();
  });

  it("does nothing once disposed", () => {
    const view = createAssemblyView(container);
    const assembly = parsed();
    view.setAssembly(assembly);
    view.dispose();
    const count = rendered.length;
    view.setAssembly(parsed());
    view.setHighlightedSockets([{ instance: "torso", socket: "left" }]);
    view.setSelection(["torso"]);
    view.setGhost({ part: assembly.parts.arm!, sockets: [{ instance: "torso", socket: "left" }] });
    view.setTestWalk({ profile: "walk", submersion: 0, speed: 1 });
    expect(view.pick(...MIDDLE)).toBeUndefined();
    expect(view.probe(...MIDDLE)).toBeUndefined();
    view.dispose();
    runFrames(3);
    expect(rendered.length).toBe(count);
  });
});

describe("the parts a ghost replaces", () => {
  it("are those on its sockets and their subtrees", () => {
    const assembly = parsed();
    const built = { assembly, body: buildVoxelBody(assembly) };
    const ids = (hidden: Set<number>) => [...hidden].map((i) => assembly.instances[i]!.id);
    expect(ids(hiddenParts(built, undefined))).toEqual([]);
    expect(
      ids(
        hiddenParts(built, {
          sockets: [
            { instance: "torso", socket: "right" },
            { instance: "tail", socket: "a" },
          ],
        }),
      ),
    ).toEqual(["right-arm", "right-hand", "fin-a"]);
    // A free socket hides nothing.
    const freed = creature();
    freed.instances = freed.instances.filter((i) => i.id !== "fin-b");
    const fewer = VoxelAssemblySchema.parse(freed);
    expect(
      hiddenParts(
        { assembly: fewer, body: buildVoxelBody(fewer) },
        { sockets: [{ instance: "tail", socket: "b" }] },
      ).size,
    ).toBe(0);
  });
});

describe("the assembly view's moving parts (ADR 0024 §7)", () => {
  const MOTIONS: Record<string, PartMotion> = {
    "test:arm": "swing",
    "test:tail": "wag",
    "test:fin": "paddle",
  };
  const motionOf = (type: string) => MOTIONS[type];
  const WALK = { profile: "walk", submersion: 0, speed: 0.6 } as const;
  let view: AssemblyView;
  beforeEach(() => {
    view = createAssemblyView(container, { motionOf });
  });
  afterEach(() => view.dispose());

  /** The instances whose drawn bone isn't at its rest pose in `assembly`'s body. */
  const moved = (
    assembly: VoxelAssembly,
    {
      bones = drawn().body!.skeleton.bones,
      rest = buildVoxelBody(assembly).bones,
    }: { bones?: THREE.Bone[]; rest?: readonly THREE.Matrix4[] } = {},
  ) => {
    return bones.flatMap((bone, i) =>
      bone.matrixWorld.equals(rest[i]!) ? [] : [assembly.instances[i]!.id],
    );
  };

  it("moves the parts in the test walk, and only those with a motion", () => {
    const assembly = parsed();
    view.setAssembly(assembly);
    view.setTestWalk(WALK);
    runFrames(20);
    // The arms swing, the hands with them, the tail wags with the fins on it; the torso, moved
    // by the whole-body walk, and the fins' paddle, which is for water, add none of their own.
    expect(moved(assembly)).toEqual([
      "left-arm",
      "right-arm",
      "left-hand",
      "right-hand",
      "tail",
      "fin-a",
      "fin-b",
    ]);
    // And keep moving, frame to frame.
    const before = drawn().body!.skeleton.bones.map((bone) => bone.matrixWorld.clone());
    runFrames(3);
    const after = drawn().body!.skeleton.bones;
    expect(before[1]!.equals(after[1]!.matrixWorld)).toBe(false);
  });

  it("keeps the parts at rest out of the test walk, as Build mode places and picks them", () => {
    const assembly = parsed();
    view.setAssembly(assembly);
    runFrames(5);
    expect(moved(assembly)).toEqual([]);
    view.setTestWalk(WALK);
    runFrames(20);
    expect(moved(assembly)).not.toEqual([]);
    view.setTestWalk(undefined);
    runFrames(1);
    expect(moved(assembly)).toEqual([]);
    // Picked at rest: the bounds and skeleton picking reads are taken afresh.
    expect(view.pick(...MIDDLE)?.kind).toBe("part");
  });

  it("still idles with no profile to play: blinks and flicks need no walk", () => {
    const assembly = parsed();
    view.setAssembly(assembly);
    view.setTestWalk({ profile: undefined, submersion: 0, speed: 0 });
    // The tail flicks about every 7 s.
    const rest = buildVoxelBody(assembly).bones;
    let flicked = false;
    for (let i = 0; i < 60 * 16 && !flicked; i++) {
      runFrames(1);
      flicked = moved(assembly, { rest }).includes("tail");
    }
    expect(flicked).toBe(true);
    // The whole body stands still.
    expect(drawn().rig!.matrix.equals(new THREE.Matrix4())).toBe(true);
  });

  it("tints and collapses over the posed parts", () => {
    const assembly = parsed();
    view.setAssembly(assembly);
    view.setSelection(["left-arm", "right-arm"]);
    view.setGhost({ part: assembly.parts.fin!, sockets: [{ instance: "tail", socket: "a" }] });
    view.setTestWalk(WALK);
    runFrames(20);
    const { body, tint } = drawn();
    expect(tint!.visible).toBe(true);
    const rest = buildVoxelBody(assembly).bones;
    assembly.instances.forEach(({ id }, i) => {
      const drawnBone = body!.skeleton.bones[i]!.matrixWorld;
      const tinted = tint!.skeleton.bones[i]!.matrixWorld;
      if (id === "fin-a") {
        // Replaced by the ghost: collapsed, posed or not.
        expect(drawnBone.determinant(), id).toBe(0);
      } else {
        expect(drawnBone.determinant(), id).not.toBe(0);
      }
      const selected = id === "left-arm" || id === "right-arm";
      if (selected) {
        // The tint sits on the posed arm, not where it rests.
        expect(tinted.equals(drawnBone), id).toBe(true);
        expect(tinted.equals(rest[i]!), id).toBe(false);
      } else {
        expect(tinted.determinant(), id).toBe(0);
      }
    });
  });

  it("builds the rig anew for a new assembly, and walks it", () => {
    const first = parsed();
    view.setAssembly(first);
    view.setTestWalk(WALK);
    runFrames(10);
    const old = drawn().body!;
    // An edit: the right arm, its hand and a fin gone.
    const edited = creature();
    edited.instances = edited.instances.filter(
      ({ id }) => !["right-arm", "right-hand", "fin-b"].includes(id),
    );
    const next = VoxelAssemblySchema.parse(edited);
    view.setAssembly(next);
    runFrames(10);
    const { body } = drawn();
    expect(body).not.toBe(old);
    expect(body!.skeleton.bones).toHaveLength(next.instances.length);
    expect(moved(next, { bones: body!.skeleton.bones })).toEqual([
      "left-arm",
      "left-hand",
      "tail",
      "fin-a",
    ]);
  });

  it("moves no part without a motion resolver", () => {
    const plain = createAssemblyView(container);
    const assembly = parsed();
    plain.setAssembly(assembly);
    plain.setTestWalk(WALK);
    runFrames(20);
    expect(moved(assembly)).toEqual([]);
    expect(drawn().rig!.matrix.equals(new THREE.Matrix4())).toBe(false);
    plain.dispose();
  });
});
