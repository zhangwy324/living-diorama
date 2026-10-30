import {
  VoxelAssemblySchema,
  VoxelPartSchema,
  type VoxelAssemblyInput,
  type VoxelPartInput,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { MAX_THUMBNAIL_SIZE, type ThumbnailRenderer } from "../prop-thumbnails";
import { THUMBNAIL_BUDGET_MS, VoxelThumbnails, thumbnailKey } from "./thumbnails";

/** A box of `x × y × z` cubes of 5 cm in two colours, the bottom layer the second. */
function box(x: number, y: number, z: number, options: Partial<VoxelPartInput> = {}) {
  return {
    type: "test:torso",
    size: { x, y, z },
    step: 0.05,
    colors: ["#7fae5a", "#76563a"],
    voxels: voxels(x, y, z),
    attach: { x: x / 2, y: 0, z: z / 2 },
    sockets: [],
    ...options,
  } satisfies VoxelPartInput;
}

/** The runs of a box whose bottom row (y = 0) is colour 2 and the rest colour 1. */
function voxels(x: number, y: number, z: number): number[] {
  const runs: number[] = [];
  for (let k = 0; k < z; k++) runs.push(x, 2, x * (y - 1), 1);
  return runs;
}

const part = (input: VoxelPartInput = box(4, 3, 2)) => VoxelPartSchema.parse(input);

/** A torso with a leg hanging under it, as `VoxelAssemblySchema` accepts. */
function assembly() {
  const input: VoxelAssemblyInput = {
    parts: {
      torso: box(6, 3, 4, {
        sockets: [{ id: "hip", type: "test:hip", position: { x: 3, y: 1, z: 2 } }],
      }),
      leg: box(2, 3, 2, { type: "test:leg", attach: { x: 1, y: 2, z: 1 } }),
    },
    instances: [
      { id: "torso", part: "torso" },
      { id: "leg", part: "leg", parent: { instance: "torso", socket: "hip" } },
    ],
  };
  return VoxelAssemblySchema.parse(input);
}

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

const encoder = () =>
  vi.fn((pixels: Uint8ClampedArray, size: number) => `png:${size}:${pixels[0]}`);

/** The skinned meshes a drawn scene holds. */
const skinned = (scene: THREE.Scene) =>
  scene.children.filter((o): o is THREE.SkinnedMesh => o instanceof THREE.SkinnedMesh);

/** A scheduler that holds its turns until `run`, and a clock the test moves. */
function manualSchedule() {
  const turns: (() => void)[] = [];
  let time = 0;
  return {
    schedule: (draw: () => void) => void turns.push(draw),
    now: () => time,
    advance: (ms: number) => (time += ms),
    /** Runs every turn scheduled so far. */
    run: () => {
      for (const turn of turns.splice(0)) turn();
    },
    pending: () => turns.length,
  };
}

/** Thumbnails drawn with a fake renderer, on a manual schedule. */
function setup(encode = encoder()) {
  const fake = fakeRenderer();
  const clock = manualSchedule();
  const thumbnails = new VoxelThumbnails(fake.renderer, encode, clock);
  return { ...fake, clock, thumbnails, encode };
}

const legSource = (version = "1.0.0", leg = part()) => ({ id: "test:leg", version, part: leg });
const creatureSource = () => ({ id: "user:crab", version: "1.0.0", assembly: assembly() });

describe("voxel thumbnails", () => {
  it("draws a part once per size, as a prop thumbnail, and leaves the renderer as it was", async () => {
    const { drawn, setClearColor, readPixels, target, clock, thumbnails, encode } = setup();
    const first = thumbnails.part(legSource(), 64);
    expect(thumbnails.part(legSource(), 64.2)).toBe(first);
    // Nothing is drawn until the scheduled turn.
    expect(drawn).toHaveLength(0);
    clock.run();
    await expect(first).resolves.toBe("png:64:128");
    expect(drawn).toHaveLength(1);
    const drawnTo = drawn[0]!.target!;
    expect([drawnTo.width, drawnTo.height]).toEqual([64, 64]);
    expect(drawnTo.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(readPixels).toHaveBeenCalledWith(drawnTo, 0, 0, 64, 64, expect.any(Uint8Array));
    expect(encode).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 64);
    expect(target()).toBeNull();
    expect(setClearColor).toHaveBeenLastCalledWith(new THREE.Color("#123456"), 1);
  });

  it("keeps thumbnails by id@version and size, not by object", async () => {
    const { drawn, clock, thumbnails } = setup();
    const first = thumbnails.part(legSource(), 64);
    clock.run();
    await first;
    // Another object with the same ID and version is not drawn again.
    await expect(thumbnails.part(legSource("1.0.0", part()), 64)).resolves.toBe("png:64:128");
    expect(clock.pending()).toBe(0);
    expect(drawn).toHaveLength(1);
    // Another size or version is.
    const bigger = thumbnails.part(legSource(), 96);
    const newer = thumbnails.part(legSource("1.1.0"), 64);
    clock.run();
    await expect(bigger).resolves.toBe("png:96:128");
    await newer;
    expect(drawn).toHaveLength(3);
    expect(thumbnailKey("part", legSource(), 64)).toBe("part:test:leg@1.0.0:64");
  });

  it("keeps parts and assemblies apart, though their IDs match", async () => {
    const { drawn, clock, thumbnails } = setup();
    const lone = thumbnails.part({ id: "x:a", version: "1", part: part() }, 32);
    const whole = thumbnails.assembly({ id: "x:a", version: "1", assembly: assembly() }, 32);
    expect(whole).not.toBe(lone);
    clock.run();
    await Promise.all([lone, whole]);
    expect(drawn).toHaveLength(2);
  });

  it("draws queued thumbnails within a time budget a turn, at least one", async () => {
    const encode = encoder();
    const { drawn, clock, thumbnails } = setup(encode);
    // Each drawing takes 4 ms of the clock.
    encode.mockImplementation((pixels: Uint8ClampedArray, size: number) => {
      clock.advance(4);
      return `png:${size}:${pixels[0]}`;
    });
    const all = [1, 2, 3, 4, 5].map((v) => thumbnails.part(legSource(`${v}`), 16));
    expect(clock.pending()).toBe(1);
    // 4 ms, then 8 ms: past the budget after the second.
    expect(THUMBNAIL_BUDGET_MS).toBeGreaterThan(4);
    expect(THUMBNAIL_BUDGET_MS).toBeLessThanOrEqual(8);
    clock.run();
    expect(drawn).toHaveLength(2);
    expect(clock.pending()).toBe(1);
    clock.run();
    expect(drawn).toHaveLength(4);
    clock.run();
    expect(drawn).toHaveLength(5);
    expect(clock.pending()).toBe(0);
    await expect(Promise.all(all)).resolves.toHaveLength(5);

    // A drawing over the whole budget still draws, one a turn.
    encode.mockImplementation((_pixels: Uint8ClampedArray, size: number) => {
      clock.advance(50);
      return `png:${size}`;
    });
    void thumbnails.part(legSource("6"), 16);
    void thumbnails.part(legSource("7"), 16);
    clock.run();
    expect(drawn).toHaveLength(6);
    clock.run();
    expect(drawn).toHaveLength(7);
  });

  it("draws the part with the creatures' voxel material, its shader patch kept", async () => {
    const { drawn, clock, thumbnails } = setup();
    const thumbnail = thumbnails.part(legSource(), 32);
    clock.run();
    await thumbnail;
    const [mesh] = skinned(drawn[0]!.scene);
    expect(mesh).toBeDefined();
    const material = mesh!.material as THREE.MeshStandardMaterial;
    expect(material.vertexColors).toBe(true);
    expect(material.customProgramCacheKey()).toBe("living-diorama-voxel");
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    } as THREE.WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain("voxelSrgbToLinear");
    expect(drawn[0]!.scene.children.some((o) => o instanceof THREE.Light)).toBe(true);
  });

  it("frames a whole assembly by where its bones put its parts", async () => {
    const { drawn, clock, thumbnails } = setup();
    const creature = creatureSource();
    const thumbnail = thumbnails.assembly(creature, 48);
    expect(thumbnails.assembly(creature, 48)).toBe(thumbnail);
    clock.run();
    await expect(thumbnail).resolves.toBe("png:48:128");
    expect(drawn).toHaveLength(1);
    const [mesh] = skinned(drawn[0]!.scene);
    expect(mesh!.skeleton.bones).toHaveLength(2);
    // Torso 30 × 15 × 20 cm, its leg 5 cm below: the posed bounds in metres, not cube units.
    mesh!.computeBoundingBox();
    const size = mesh!.boundingBox!.getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(0.3, 2);
    expect(size.y).toBeCloseTo(0.2, 2);
    expect(size.z).toBeCloseTo(0.2, 2);
  });

  it("frees each body, skeleton and render target once read back", async () => {
    const targets = vi.spyOn(THREE.WebGLRenderTarget.prototype, "dispose");
    const geometries = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const skeletons = vi.spyOn(THREE.Skeleton.prototype, "dispose");
    const materials = vi.spyOn(THREE.Material.prototype, "dispose");
    const { drawn, clock, thumbnails } = setup();
    const thumbnail = thumbnails.part(legSource(), 32);
    clock.run();
    await thumbnail;
    const [mesh] = skinned(drawn[0]!.scene);
    expect(targets.mock.contexts).toEqual([drawn[0]!.target]);
    expect(geometries.mock.contexts).toEqual([mesh!.geometry]);
    expect(skeletons.mock.contexts).toEqual([mesh!.skeleton]);
    // The material copy drawn with is freed at once; the material itself on `dispose`.
    expect(materials.mock.contexts).toEqual([mesh!.material]);
    thumbnails.dispose();
    expect(materials).toHaveBeenCalledTimes(2);
    for (const spy of [targets, geometries, skeletons, materials]) spy.mockRestore();
  });

  it("rounds the size, caps it and rejects one below a pixel", async () => {
    const { drawn, clock, thumbnails } = setup();
    const thumbnail = thumbnails.part(legSource(), 1e6);
    clock.run();
    await thumbnail;
    expect(drawn[0]!.target!.width).toBe(MAX_THUMBNAIL_SIZE);
    await expect(thumbnails.part(legSource(), 0.4)).rejects.toThrow(RangeError);
    await expect(thumbnails.part(legSource(), NaN)).rejects.toThrow(RangeError);
  });

  it("forgets a thumbnail that failed, so it can be asked for again", async () => {
    const encode = encoder().mockImplementationOnce(() => {
      throw new Error("no canvas");
    });
    const { drawn, clock, thumbnails } = setup(encode);
    const failed = thumbnails.part(legSource(), 48);
    clock.run();
    await expect(failed).rejects.toThrow("no canvas");
    const again = thumbnails.part(legSource(), 48);
    clock.run();
    await expect(again).resolves.toBe("png:48:128");
    expect(drawn).toHaveLength(2);
  });

  it("resolves queued thumbnails to undefined on dispose and draws nothing after", async () => {
    const { drawn, clock, thumbnails } = setup();
    const queued = thumbnails.part(legSource(), 48);
    thumbnails.dispose();
    await expect(queued).resolves.toBeUndefined();
    clock.run();
    await expect(thumbnails.part(legSource(), 48)).resolves.toBeUndefined();
    await expect(thumbnails.assembly(creatureSource(), 48)).resolves.toBeUndefined();
    clock.run();
    expect(drawn).toHaveLength(0);
  });
});
