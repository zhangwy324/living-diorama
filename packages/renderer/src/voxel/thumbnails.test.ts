import {
  VoxelAssemblySchema,
  VoxelPartSchema,
  type VoxelAssemblyInput,
  type VoxelPartInput,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { MAX_THUMBNAIL_SIZE, type ThumbnailRenderer } from "../prop-thumbnails";
import { VoxelThumbnails } from "./thumbnails";

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

describe("voxel thumbnails", () => {
  it("draws a part once per size, as a prop thumbnail, and leaves the renderer as it was", () => {
    const { renderer, drawn, setClearColor, readPixels, target } = fakeRenderer();
    const encode = encoder();
    const thumbnails = new VoxelThumbnails(renderer, encode);
    const leg = part();

    const first = thumbnails.part(leg, 64);
    expect(first).toBe("png:64:128");
    expect(thumbnails.part(leg, 64.2)).toBe(first);
    expect(drawn).toHaveLength(1);
    const drawnTo = drawn[0]!.target!;
    expect([drawnTo.width, drawnTo.height]).toEqual([64, 64]);
    expect(drawnTo.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(readPixels).toHaveBeenCalledWith(drawnTo, 0, 0, 64, 64, expect.any(Uint8Array));
    expect(encode).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 64);
    expect(target()).toBeNull();
    expect(setClearColor).toHaveBeenLastCalledWith(new THREE.Color("#123456"), 1);

    // Another size, or an equal copy of the part, is drawn anew.
    expect(thumbnails.part(leg, 96)).toBe("png:96:128");
    expect(drawn).toHaveLength(2);
    thumbnails.part(part(), 64);
    expect(drawn).toHaveLength(3);
  });

  it("draws the part with the creatures' voxel material, its shader patch kept", () => {
    const { renderer, drawn } = fakeRenderer();
    new VoxelThumbnails(renderer, encoder()).part(part(), 32);
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

  it("frames a whole assembly by where its bones put its parts", () => {
    const { renderer, drawn } = fakeRenderer();
    const thumbnails = new VoxelThumbnails(renderer, encoder());
    const creature = assembly();
    expect(thumbnails.assembly(creature, 48)).toBe("png:48:128");
    expect(thumbnails.assembly(creature, 48)).toBe("png:48:128");
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

  it("frees each body, skeleton and render target once read back", () => {
    const { renderer, drawn } = fakeRenderer();
    const targets = vi.spyOn(THREE.WebGLRenderTarget.prototype, "dispose");
    const geometries = vi.spyOn(THREE.BufferGeometry.prototype, "dispose");
    const skeletons = vi.spyOn(THREE.Skeleton.prototype, "dispose");
    const materials = vi.spyOn(THREE.Material.prototype, "dispose");
    const thumbnails = new VoxelThumbnails(renderer, encoder());
    thumbnails.part(part(), 32);
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

  it("rounds the size, caps it and throws for one below a pixel", () => {
    const { renderer, drawn } = fakeRenderer();
    const thumbnails = new VoxelThumbnails(renderer, encoder());
    thumbnails.part(part(), 1e6);
    expect(drawn[0]!.target!.width).toBe(MAX_THUMBNAIL_SIZE);
    expect(() => thumbnails.part(part(), 0.4)).toThrow(RangeError);
    expect(() => thumbnails.part(part(), NaN)).toThrow(RangeError);
  });

  it("forgets a thumbnail that failed, so it can be asked for again", () => {
    const { renderer, drawn } = fakeRenderer();
    const encode = encoder().mockImplementationOnce(() => {
      throw new Error("no canvas");
    });
    const thumbnails = new VoxelThumbnails(renderer, encode);
    const leg = part();
    expect(() => thumbnails.part(leg, 48)).toThrow("no canvas");
    expect(thumbnails.part(leg, 48)).toBe("png:48:128");
    expect(drawn).toHaveLength(2);
  });

  it("draws nothing once disposed", () => {
    const { renderer, drawn } = fakeRenderer();
    const thumbnails = new VoxelThumbnails(renderer, encoder());
    const leg = part();
    thumbnails.part(leg, 48);
    thumbnails.dispose();
    expect(thumbnails.part(leg, 48)).toBeUndefined();
    expect(thumbnails.assembly(assembly(), 48)).toBeUndefined();
    expect(drawn).toHaveLength(1);
  });
});
