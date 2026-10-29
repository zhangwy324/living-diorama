import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { PropIcons, frameIcon, iconStage } from "./cue-icons";

/** A bush-like model: a box on a stem, away from the origin, with a clipped material. */
function model() {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: "#3c8a3c" });
  material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)];
  const crown = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), material);
  crown.position.set(5, 1.5, -3);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1), [material]);
  stem.position.set(5, 0.5, -3);
  group.add(crown, stem);
  return { group, material, crown, stem };
}

/** Stands in for a WebGL renderer, recording what is drawn where. */
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
  };
  return {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    drawn,
    setClearColor,
    target: () => target,
  };
}

describe("prop icons", () => {
  it("draws a model only once asked for, then finds it by any of its placements", () => {
    const icons = new PropIcons();
    icons.add(model().group, ["bush-1", "bush-2"]);
    icons.add(model().group, ["rock-1"]);
    const { renderer, drawn, setClearColor, target } = fakeRenderer();
    // Nothing asked for, nothing drawn: no tree or rock is drawn just for being loaded.
    icons.render(renderer);
    expect(drawn).toHaveLength(0);
    expect(icons.icon("bush-1")).toBeUndefined();
    icons.render(renderer);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.target).not.toBeNull();
    const picture = icons.icon("bush-1");
    expect(picture).toBe(drawn[0]!.target!.texture);
    expect(icons.icon("bush-2")).toBe(picture);
    expect(icons.icon("mushroom-1")).toBeUndefined();
    expect(icons.icon(undefined)).toBeUndefined();
    // The renderer is left drawing to the screen again, with its clear colour back.
    expect(target()).toBeNull();
    expect(setClearColor).toHaveBeenLastCalledWith(new THREE.Color("#123456"), 1);
    // Each model is drawn once; the rock only once it is asked for.
    icons.icon("bush-2");
    icons.render(renderer);
    expect(drawn).toHaveLength(1);
    expect(icons.icon("rock-1")).toBeUndefined();
    icons.render(renderer);
    expect(drawn).toHaveLength(2);
  });

  it("frees its pictures on dispose", () => {
    const icons = new PropIcons();
    icons.add(model().group, ["bush-1"]);
    const { renderer, drawn } = fakeRenderer();
    icons.icon("bush-1");
    icons.render(renderer);
    const disposed = vi.fn();
    // The renderer frees a render target's texture with the target.
    drawn[0]!.target!.addEventListener("dispose", disposed);
    icons.dispose();
    expect(disposed).toHaveBeenCalled();
    expect(icons.icon("bush-1")).toBeUndefined();
  });

  it("stages a copy that shares the geometry, without the props' clipping planes", () => {
    const { group, material, crown, stem } = model();
    const { scene, dispose } = iconStage(group);
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    expect(meshes.map((m) => m.geometry)).toEqual([crown.geometry, stem.geometry]);
    const copies = meshes.flatMap((m) =>
      Array.isArray(m.material) ? m.material : [m.material as THREE.Material],
    );
    for (const copy of copies) {
      expect(copy).not.toBe(material);
      expect(copy.clippingPlanes).toBeNull();
    }
    expect(material.clippingPlanes).toHaveLength(1);
    // The model itself is left as it was.
    expect(group.children).toEqual([crown, stem]);
    const freed = vi.fn();
    material.addEventListener("dispose", freed);
    dispose();
    expect(freed).not.toHaveBeenCalled();
  });

  it("frames the model whole and centred, from above", () => {
    const bounds = new THREE.Box3(new THREE.Vector3(4, 0, -4), new THREE.Vector3(6, 2, -2));
    const camera = frameIcon(bounds);
    const corner = new THREE.Vector3();
    let widest = 0;
    for (let k = 0; k < 8; k++) {
      corner.set(k & 1 ? 6 : 4, k & 2 ? 2 : 0, k & 4 ? -2 : -4).project(camera);
      for (const v of [corner.x, corner.y]) {
        expect(Math.abs(v)).toBeLessThan(1);
        widest = Math.max(widest, Math.abs(v));
      }
      expect(Math.abs(corner.z)).toBeLessThan(1);
    }
    // It fills the picture but for a small margin.
    expect(widest).toBeGreaterThan(0.85);
    const centre = bounds.getCenter(new THREE.Vector3()).project(camera);
    expect(centre.x).toBeCloseTo(0, 6);
    expect(camera.position.y).toBeGreaterThan(1);
  });
});
