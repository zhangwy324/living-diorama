import type { NavigationOverlay, SceneData, SceneProp } from "@living-diorama/simulation";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { buildDioramaScene, createSun, defaultFraming } from "./index";
import { SceneLayer } from "./layers";
import { railingMeshes } from "./world-meshes";

const prop = (id: string, model: string, x: number, scale = 1): SceneProp => ({
  id,
  model,
  transform: { position: { x, y: 0, z: 0 }, rotationY: 0, scale },
  blockRadius: 0.5,
});

/** 4 × 2 m world at height 1, a water plane, a deck with one open edge, and three props. */
const scene: SceneData = {
  bounds: { min: { x: -2, y: -1, z: -1 }, max: { x: 2, y: 3, z: 1 } },
  terrain: {
    columns: 5,
    rows: 3,
    cellSize: 1,
    heights: Array<number>(15).fill(1),
    colors: Array<string>(15).fill("#7fae5a"),
  },
  surfaces: [
    {
      regionId: "river",
      kind: "water",
      mesh: { positions: [-2, 0.5, 0, 2, 0.5, 0, 0, 0.5, 1], indices: [0, 2, 1] },
    },
    {
      regionId: "deck",
      kind: "land",
      structureId: "bridge",
      mesh: { positions: [0, 1.2, -1, 1, 1.2, -1, 0, 1.2, 1], indices: [0, 2, 1] },
      openEdges: [
        [
          { x: 0, y: 1.2, z: -1 },
          { x: 0, y: 1.2, z: 1 },
        ],
      ],
    },
  ],
  edgeWater: {
    north: Array<number>(5).fill(NaN),
    south: [NaN, NaN, 1.5, NaN, NaN],
    west: Array<number>(3).fill(NaN),
    east: Array<number>(3).fill(NaN),
  },
  props: [prop("a", "test:pine", -1, 2), prop("b", "test:pine", 1), prop("c", "test:gone", 0)],
  spawnPoints: [],
};

const pine = () => {
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.ConeGeometry(0.5, 1), new THREE.MeshStandardMaterial()));
  return model;
};

const instanceMatrix = (mesh: THREE.InstancedMesh, i: number) => {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  return m;
};

const meshesIn = (root: THREE.Object3D) => {
  const found: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) found.push(o);
  });
  return found;
};

describe("defaultFraming", () => {
  it("narrows the vertical field of view for a strip so the full width stays in view", () => {
    const strip = defaultFraming(scene, 1920 / 220);
    const expanded = defaultFraming(scene, 16 / 9);
    expect(strip.fov).toBeLessThan(expanded.fov / 3);
    // Both look at the same point, from the south (+Z) and above.
    expect(strip.target.equals(expanded.target)).toBe(true);
    expect(strip.position.z).toBeGreaterThan(strip.target.z);
    expect(strip.position.y).toBeGreaterThan(strip.target.y);
  });

  it("looks at the mean terrain height, a little behind the world's centre", () => {
    const { target } = defaultFraming(scene, 2);
    expect(target.toArray()).toEqual([0, 1, -0.2]);
  });
});

describe("createSun", () => {
  it("fits its shadow camera around the whole world", () => {
    const sun = createSun(scene);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    sun.shadow.updateMatrices(sun);
    const camera = sun.shadow.camera;
    camera.updateProjectionMatrix();
    const { min, max } = scene.bounds;
    for (const x of [min.x, max.x])
      for (const y of [min.y, max.y])
        for (const z of [min.z, max.z]) {
          const p = new THREE.Vector3(x, y, z).project(camera);
          for (const c of p.toArray()) expect(Math.abs(c)).toBeLessThanOrEqual(1);
        }
  });
});

describe("buildDioramaScene", () => {
  const build = () => {
    const load = vi.fn(async (url: string) => {
      if (url === "pine.glb") return pine();
      throw new Error("missing");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const built = buildDioramaScene(scene, {
      resolveAsset: (ref) =>
        ref === "test:pine" ? { kind: "model", url: "pine.glb", scale: 3 } : undefined,
      loadModel: load,
    });
    return { ...built, load, warn };
  };

  it("puts each part of the world in its layer and shares one water material", async () => {
    const { layers, water, ready } = build();
    await ready;
    expect(meshesIn(layers.terrain.group)).toHaveLength(3); // terrain, soil walls, bottom
    const waterMeshes = meshesIn(layers.water.group);
    expect(waterMeshes).toHaveLength(2); // the river plane and its cross-section on the south side
    for (const mesh of waterMeshes) expect(mesh.material).toBe(water.material);
    // The deck slab, its posts and its rails.
    expect(meshesIn(layers.structures.group)).toHaveLength(3);
  });

  it("loads each model once, instances it with the asset's scale and falls back for the rest", async () => {
    const { layers, ready, load, warn } = build();
    await ready;
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("No model asset for test:gone");

    // Models are added as they finish loading, so find each by its material.
    const parts = meshesIn(layers.props.group) as THREE.InstancedMesh[];
    const isFallback = (m: THREE.InstancedMesh) =>
      (m.material as THREE.MeshStandardMaterial).flatShading;
    const pines = parts.find((m) => !isFallback(m));
    const fallback = parts.find(isFallback);
    expect(pines!.count).toBe(2);
    const scaleOf = (m: THREE.Matrix4) => new THREE.Vector3().setFromMatrixScale(m).x;
    expect(scaleOf(instanceMatrix(pines!, 0))).toBeCloseTo(6); // placement 2 × asset 3
    expect(scaleOf(instanceMatrix(pines!, 1))).toBeCloseTo(3);
    // The fallback is sized from the prop's blockRadius (0.5 m).
    expect(fallback!.count).toBe(1);
    expect(scaleOf(instanceMatrix(fallback!, 0))).toBeCloseTo(0.5);
  });

  it("applies a layer's clipping planes to its materials, including props added later", async () => {
    const { layers, ready } = build();
    layers.props.setClipping([{ normal: { x: 0, y: 0, z: 1 }, constant: 0 }]);
    await ready;
    for (const mesh of meshesIn(layers.props.group)) {
      expect((mesh.material as THREE.Material).clippingPlanes).toHaveLength(1);
    }
    for (const mesh of meshesIn(layers.terrain.group)) {
      expect((mesh.material as THREE.Material).clippingPlanes ?? []).toHaveLength(0);
    }
    layers.props.setClipping([]);
    for (const mesh of meshesIn(layers.props.group)) {
      expect((mesh.material as THREE.Material).clippingPlanes).toHaveLength(0);
    }
  });
});

describe("replaceProps", () => {
  const navigation = (walkable: boolean): NavigationOverlay => ({
    profileKey: "test",
    regions: [
      {
        regionId: "meadow",
        anchor: { x: 0, y: 1, z: 0 },
        cells: [
          {
            walkable,
            corners: [
              { x: 0, y: 1, z: 0 },
              { x: 1, y: 1, z: 0 },
              { x: 1, y: 1, z: 1 },
              { x: 0, y: 1, z: 1 },
            ],
          },
        ],
      },
    ],
    portals: [],
  });

  it("swaps props and navigation overlays, keeping the terrain, water and structures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const model = pine();
    const load = vi.fn(async () => model);
    const built = buildDioramaScene(scene, {
      resolveAsset: (ref) => (ref === "test:pine" ? { kind: "model", url: "pine.glb" } : undefined),
      loadModel: load,
      navigation: navigation(true),
    });
    await built.ready;
    const kept = [built.layers.terrain, built.layers.water, built.layers.structures].map((l) => [
      ...l.group.children,
    ]);
    const walkability = built.overlays.group.getObjectByName("walkability") as THREE.Mesh;
    const walkabilityFreed = vi.fn();
    walkability.geometry.addEventListener("dispose", walkabilityFreed);
    built.editing.select("b");

    const moved = { ...scene, props: [prop("b", "test:pine", -1.5), prop("d", "test:pine", 1.5)] };
    expect(await built.replaceProps(moved, navigation(false))).toBe(true);

    expect(load).toHaveBeenCalledTimes(1);
    expect(
      [built.layers.terrain, built.layers.water, built.layers.structures].map((l) => [
        ...l.group.children,
      ]),
    ).toEqual(kept);
    const [instances] = meshesIn(built.layers.props.group) as THREE.InstancedMesh[];
    expect(meshesIn(built.layers.props.group)).toHaveLength(1);
    expect(instances!.count).toBe(2);
    // The new walkability replaces the old, which is freed.
    expect(walkabilityFreed).toHaveBeenCalled();
    const redrawn = built.overlays.group.getObjectByName("walkability") as THREE.Mesh;
    expect(redrawn).not.toBe(walkability);
    expect(built.overlays.group.getObjectsByProperty("name", "walkability")).toHaveLength(1);
    // The selection ring followed the moved prop.
    expect(built.world.getObjectByName("prop-selection")!.position.x).toBeCloseTo(-1.5);

    // Without navigation the overlays drop walkability and the graph.
    await built.replaceProps(moved);
    expect(built.overlays.group.getObjectByName("walkability")).toBeUndefined();
    expect(built.overlays.group.getObjectByName("region-graph")).toBeUndefined();
  });
});

describe("railingMeshes", () => {
  it("puts posts at most 1.2 m apart, shared where edges meet, and two rails per edge", () => {
    const corner = { x: 0, y: 1, z: 0 };
    const [posts, rails] = railingMeshes(
      [
        [{ x: -3, y: 1, z: 0 }, corner],
        [corner, { x: 0, y: 1, z: 1 }],
      ],
      new THREE.MeshStandardMaterial(),
    );
    // 3 m edge: 4 posts; 1 m edge: 2 posts; one shared at the corner.
    expect(posts!.count).toBe(5);
    expect(rails!.count).toBe(4);
  });
});

it("SceneLayer recompiles materials only when the plane count changes", () => {
  const layer = new SceneLayer("terrain");
  const material = new THREE.MeshStandardMaterial();
  layer.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
  const version = material.version;
  layer.setClipping([]);
  expect(material.version).toBe(version);
  layer.setClipping([{ normal: { x: 1, y: 0, z: 0 }, constant: 2 }]);
  expect(material.version).toBe(version + 1);
});
