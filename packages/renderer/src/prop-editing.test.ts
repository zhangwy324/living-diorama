import type { SceneData, SceneProp } from "@living-diorama/simulation";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pointerToNdc } from "./diorama-view";
import { ghostOf, PropEditing } from "./prop-editing";
import { SceneLayer } from "./layers";
import { PropSet, type AssetResolver } from "./props";
import { terrainRayHit } from "./terrain-ray";
import { terrainMesh } from "./world-meshes";

/** A square terrain of `size` samples a metre apart, centred on the origin, heights from `height`. */
const flatScene = (
  size: number,
  level: number,
  height: (x: number, z: number) => number = () => level,
  cellSize = 1,
): SceneData => {
  const half = ((size - 1) * cellSize) / 2;
  const heights: number[] = [];
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) heights.push(height(-half + i * cellSize, -half + j * cellSize));
  return {
    bounds: { min: { x: -half, y: -5, z: -half }, max: { x: half, y: 10, z: half } },
    terrain: {
      columns: size,
      rows: size,
      cellSize,
      heights,
      colors: Array<string>(size * size).fill("#7fae5a"),
    },
    surfaces: [],
    edgeWater: { north: [], south: [], west: [], east: [] },
    props: [],
    spawnPoints: [],
  };
};

const prop = (id: string, model: string, x: number, y = 1, scale = 1): SceneProp => ({
  id,
  model,
  transform: { position: { x, y, z: 0 }, rotationY: 0, scale },
  blockRadius: 0.5,
});

/** A model of two parts, so each placement is drawn by two instanced meshes. */
const pine = () => {
  const model = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  model.add(new THREE.Mesh(new THREE.ConeGeometry(0.5, 1), material));
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.4), material);
  stem.position.y = -0.6;
  model.add(stem);
  return model;
};

const rock = () =>
  new THREE.Mesh(new THREE.DodecahedronGeometry(0.4), new THREE.MeshStandardMaterial());

const resolve: AssetResolver = (ref) =>
  ref === "test:pine"
    ? { kind: "model", url: "pine.glb", scale: 3 }
    : ref === "test:rock"
      ? { kind: "model", url: "rock.glb" }
      : undefined;

/** Every geometry and material of a model, to watch for disposal. */
const resourcesOf = (model: THREE.Object3D) => {
  const resources = new Set<THREE.BufferGeometry | THREE.Material>();
  model.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      resources.add(o.geometry as THREE.BufferGeometry);
      resources.add(o.material as THREE.Material);
    }
  });
  return [...resources];
};

const watchDisposal = (targets: readonly THREE.EventDispatcher<{ dispose: object }>[]) => {
  const disposed = vi.fn();
  for (const target of targets) target.addEventListener("dispose", disposed);
  return disposed;
};

/** A ray straight down onto (x, z). */
const downAt = (x: number, z = 0) =>
  new THREE.Raycaster(new THREE.Vector3(x, 20, z), new THREE.Vector3(0, -1, 0));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

const setup = () => {
  const models = { pine: pine(), rock: rock() };
  const load = vi.fn(async (url: string) => (url === "pine.glb" ? models.pine : models.rock));
  const layer = new THREE.Group();
  const placed = vi.fn();
  const props = new PropSet({ add: (...o) => layer.add(...o) }, resolve, { load, placed });
  return { models, load, layer, placed, props };
};

describe("PropSet", () => {
  it("replaces the props, reusing loaded models and freeing only the old instances", async () => {
    const { models, load, layer, placed, props } = setup();
    expect(await props.set([prop("a", "test:pine", -1), prop("b", "test:pine", 1)])).toBe(true);
    const first = props.meshes;
    expect(first).toHaveLength(2); // two parts of one model
    expect(first[0]!.count).toBe(2);
    const instancesFreed = watchDisposal(first);
    const modelFreed = watchDisposal(resourcesOf(models.pine));

    expect(
      await props.set([prop("a", "test:pine", 0), prop("c", "test:rock", 1), prop("d", "x", 2)]),
    ).toBe(true);
    // Both old instanced meshes are freed and gone; the shared model is kept.
    expect(instancesFreed).toHaveBeenCalledTimes(2);
    expect(modelFreed).not.toHaveBeenCalled();
    for (const mesh of first) expect(mesh.parent).toBeNull();
    // Pine (2 parts), rock and the fallback block.
    expect(layer.children).toHaveLength(4);
    expect(load).toHaveBeenCalledTimes(2);
    expect(props.placement("a")!.transform.position.x).toBe(0);
    expect(props.placement("b")).toBeUndefined();
    // Cue pictures hear of the loaded models only, never the fallback.
    expect(placed).toHaveBeenLastCalledWith([
      [models.pine, ["a"]],
      [models.rock, ["c"]],
    ]);
  });

  it("keeps the old props until every new model is loaded, so none ever goes missing", async () => {
    const layer = new THREE.Group();
    let arrive: (model: THREE.Object3D) => void = () => undefined;
    const props = new PropSet(
      { add: (...o) => layer.add(...o) },
      (ref) => ({ kind: "model", url: `${ref}.glb` }),
      {
        load: (url) =>
          url === "rock.glb"
            ? Promise.resolve(rock())
            : new Promise((resolve) => (arrive = resolve)),
      },
    );
    await props.set([prop("a", "rock", 0)]);
    const [old] = layer.children;
    const placing = props.set([prop("a", "rock", 1), prop("s", "slow", 0)]);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(layer.children).toEqual([old]);
    arrive(pine());
    expect(await placing).toBe(true);
    expect(old!.parent).toBeNull();
    expect(layer.children).toHaveLength(3);

    // A model arriving after dispose is freed at once and never placed.
    const late = props.set([prop("t", "late", 0)]);
    props.dispose();
    const model = rock();
    const freed = watchDisposal(resourcesOf(model));
    arrive(model);
    expect(await late).toBe(false);
    expect(freed).toHaveBeenCalledTimes(2);
  });

  it("lets a later list overtake one still loading, and stays bounded over many calls", async () => {
    const { layer, props } = setup();
    const first = props.set([prop("a", "test:pine", 0)]);
    const second = props.set([prop("b", "test:rock", 0)]);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(props.placement("a")).toBeUndefined();
    expect(layer.children).toHaveLength(1);

    const freed = vi.fn();
    for (let i = 0; i < 50; i++) {
      for (const mesh of props.meshes) mesh.addEventListener("dispose", freed);
      await props.set([prop("a", "test:pine", i * 0.01), prop("b", "test:rock", 1)]);
    }
    // One rock part at first, then two pine parts and a rock each round, all freed but the last.
    expect(freed).toHaveBeenCalledTimes(1 + 49 * 3);
    expect(layer.children).toHaveLength(3);
  });

  it("draws a model that never loads as a block after the timeout, and the model once it comes", async () => {
    const layer = new THREE.Group();
    let arrive: (model: THREE.Object3D) => void = () => undefined;
    const load = vi.fn(() => new Promise<THREE.Object3D>((resolve) => (arrive = resolve)));
    const props = new PropSet(
      { add: (...o) => layer.add(...o) },
      () => ({ kind: "model", url: "stuck.glb" }),
      { load, loadTimeoutMs: 5 },
    );
    expect(await props.set([prop("a", "stuck", 0)])).toBe(true);
    const isFallback = (m: THREE.InstancedMesh) =>
      (m.material as THREE.MeshStandardMaterial).flatShading;
    expect(props.meshes.map(isFallback)).toEqual([true]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("took over 5 ms"));
    // A list placed before it arrives keeps the block; one after draws the model, unloaded again.
    const model = rock();
    arrive(model);
    await Promise.resolve();
    expect(await props.set([prop("a", "stuck", 1)])).toBe(true);
    expect(props.meshes.map(isFallback)).toEqual([false]);
    expect(props.meshes[0]!.geometry).toBe(model.geometry);
    expect(load).toHaveBeenCalledTimes(1);
    // A late model is freed with the set like any other.
    const freed = watchDisposal(resourcesOf(model));
    props.dispose();
    expect(freed).toHaveBeenCalledTimes(2);
  });

  it("hides a placement until shown again, through replacements", async () => {
    const { props } = setup();
    await props.set([prop("a", "test:pine", -1), prop("b", "test:pine", 1)]);
    const scaleAt = (i: number) => {
      const m = new THREE.Matrix4();
      props.meshes[0]!.getMatrixAt(i, m);
      return Math.round(new THREE.Vector3().setFromMatrixScale(m).x * 1000) / 1000;
    };
    props.hide("b");
    expect([scaleAt(0), scaleAt(1)]).toEqual([3, 0]);
    // Replaced, "b" moved: still hidden. Hiding another shows "b" again.
    await props.set([prop("b", "test:pine", 2), prop("a", "test:pine", -1)]);
    expect([scaleAt(0), scaleAt(1)]).toEqual([0, 3]);
    props.hide("a");
    expect([scaleAt(0), scaleAt(1)]).toEqual([3, 0]);
    props.hide(undefined);
    expect([scaleAt(0), scaleAt(1)]).toEqual([3, 3]);
    expect(props.hidden).toBeUndefined();
    // A gone placement hides nothing, and shows when it is back.
    props.hide("c");
    await props.set([prop("c", "test:pine", 0)]);
    expect(scaleAt(0)).toBe(0);
  });

  it("makes loaded models non-metallic, so their shaded sides are never black", async () => {
    const { models, props } = setup();
    for (const material of [...resourcesOf(models.pine), ...resourcesOf(models.rock)]) {
      if (material instanceof THREE.MeshStandardMaterial) material.metalness = 1;
    }
    await props.set([prop("a", "test:pine", 0), prop("b", "test:rock", 1)]);
    for (const mesh of props.meshes) {
      expect((mesh.material as THREE.MeshStandardMaterial).metalness).toBe(0);
    }
  });

  it("warns once per ref without a model asset", async () => {
    const { props } = setup();
    await props.set([prop("a", "test:gone", 0)]);
    await props.set([prop("a", "test:gone", 1)]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("No model asset for test:gone");
  });

  it("frees the instances, every model and the fallback on dispose", async () => {
    const { models, layer, props } = setup();
    await props.set([prop("a", "test:pine", 0), prop("b", "test:rock", 1), prop("c", "x", 2)]);
    const fallback = props.meshes.find(
      (m) => (m.material as THREE.MeshStandardMaterial).flatShading,
    )!;
    const freed = watchDisposal([
      ...props.meshes,
      ...resourcesOf(models.pine),
      ...resourcesOf(models.rock),
      fallback.geometry,
      fallback.material as THREE.Material,
    ]);
    props.dispose();
    // 4 instanced meshes, pine (2 geometries, 1 material), rock (1 + 1), fallback (1 + 1).
    expect(freed).toHaveBeenCalledTimes(4 + 3 + 2 + 2);
    expect(layer.children).toHaveLength(0);
    expect(await props.set([prop("a", "test:pine", 0)])).toBe(false);
  });
});

describe("PropEditing", () => {
  /**
   * A flat terrain at height 1 over x and z in −5..5, structures (none unless given), layers to
   * clip with, and a world group to draw into.
   */
  const setupEditing = async (
    props: SceneProp[],
    structures: THREE.Object3D = new THREE.Group(),
  ) => {
    const { props: set, models } = setup();
    const layers = {
      terrain: new SceneLayer("terrain"),
      structures: new SceneLayer("structures"),
      props: new SceneLayer("props"),
    };
    layers.structures.add(structures);
    const world = new THREE.Group();
    const editing = new PropEditing(
      set,
      { scene: flatScene(11, 1), occluders: [structures], layers },
      world,
    );
    await set.set(props);
    return { set, models, world, editing, layers };
  };

  it("picks the prop under the ray, unless the terrain hides it", async () => {
    const { editing } = await setupEditing([
      prop("left", "test:pine", -2),
      prop("right", "test:pine", 2),
      prop("buried", "test:rock", 0, -3),
    ]);
    expect(editing.pickProp(downAt(-2))?.placementId).toBe("left");
    const right = editing.pickProp(downAt(2));
    expect(right?.placementId).toBe("right");
    // The cone's tip: half its 1 m height × asset scale 3 above y = 1.
    expect(right!.point.y).toBeCloseTo(2.5, 1);
    expect(editing.pickProp(downAt(0))).toBeUndefined();
    expect(editing.pickProp(downAt(4))).toBeUndefined();
  });

  it("lets a structure hide a prop, unless the structure is clipped away there", async () => {
    // A deck 4 m up over x in −3..−1, above the left pine's tip at 2.5 m.
    const deck = new THREE.Mesh(new THREE.BoxGeometry(2, 0.2, 2), new THREE.MeshStandardMaterial());
    deck.position.set(-2, 4, 0);
    const { editing, layers } = await setupEditing(
      [prop("left", "test:pine", -2), prop("right", "test:pine", 2)],
      deck,
    );
    expect(editing.pickProp(downAt(-2))).toBeUndefined();
    expect(editing.pickProp(downAt(2))?.placementId).toBe("right");
    // Cut away everything above 3 m: the deck no longer hides the pine.
    layers.structures.setClipping([{ normal: { x: 0, y: -1, z: 0 }, constant: 3 }]);
    expect(editing.pickProp(downAt(-2))?.placementId).toBe("left");
  });

  it("never picks a hidden or clipped prop, but what lies behind it", async () => {
    const { editing, set, layers } = await setupEditing([
      prop("low", "test:rock", 0),
      prop("high", "test:rock", 0, 2.5),
    ]);
    expect(editing.pickProp(downAt(0))?.placementId).toBe("high");
    set.hide("high");
    expect(editing.pickProp(downAt(0))?.placementId).toBe("low");
    set.hide(undefined);
    // Cut away everything above 2 m.
    layers.props.setClipping([{ normal: { x: 0, y: -1, z: 0 }, constant: 2 }]);
    expect(editing.pickProp(downAt(0))?.placementId).toBe("low");
  });

  it("finds the ground under the ray, and nothing off it", async () => {
    const { editing } = await setupEditing([prop("a", "test:pine", 0)]);
    // Through the prop: the ground below it, for dropping a prop onto.
    const ground = editing.pickGround(downAt(0.2, -1));
    expect(ground!.x).toBeCloseTo(0.2);
    expect(ground!.y).toBeCloseTo(1);
    expect(ground!.z).toBeCloseTo(-1);
    expect(editing.pickGround(downAt(8))).toBeUndefined();
    const up = new THREE.Raycaster(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 1, 0));
    expect(editing.pickGround(up)).toBeUndefined();
  });

  it("skips ground clipped away", async () => {
    const { editing, layers } = await setupEditing([]);
    layers.terrain.setClipping([{ normal: { x: 1, y: 0, z: 0 }, constant: 0 }]);
    expect(editing.pickGround(downAt(1))).toBeDefined();
    expect(editing.pickGround(downAt(-1))).toBeUndefined();
  });

  it("rings the selected prop and follows it when the props are replaced", async () => {
    const { editing, set, world } = await setupEditing([prop("a", "test:pine", -2)]);
    const ring = world.getObjectByName("prop-selection")!;
    expect(ring.visible).toBe(false);
    editing.select("a");
    expect(ring.visible).toBe(true);
    expect(ring.position.x).toBeCloseTo(-2);
    await set.set([prop("a", "test:pine", 3)]);
    editing.refresh();
    expect(ring.position.x).toBeCloseTo(3);
    await set.set([]);
    editing.refresh();
    expect(ring.visible).toBe(false);
    expect(editing.selected).toBe("a");
    editing.select(undefined);
    expect(ring.visible).toBe(false);
  });

  it("previews a placement with see-through copies, moving it cheaply and freeing it", async () => {
    const { editing, world, models } = await setupEditing([]);
    await editing.preview(prop("p", "test:pine", 1));
    const ghost = world.getObjectByName("prop-preview")!;
    const meshes = ghost.children as THREE.Mesh[];
    expect(meshes).toHaveLength(2);
    const materials = meshes.map((m) => m.material as THREE.Material);
    for (const material of materials) {
      expect(material.transparent).toBe(true);
      expect(resourcesOf(models.pine)).not.toContain(material);
    }
    expect(meshes[0]!.geometry).toBe((models.pine.children[0] as THREE.Mesh).geometry);
    const at = () => new THREE.Vector3().setFromMatrixPosition(ghost.matrix);
    expect(at().x).toBeCloseTo(1);

    // The same model only moves; the asset's scale applies as for placed props.
    const moved = prop("p", "test:pine", -1);
    moved.transform.scale = 2;
    await editing.preview(moved);
    expect(world.getObjectByName("prop-preview")).toBe(ghost);
    expect(at().x).toBeCloseTo(-1);
    expect(new THREE.Vector3().setFromMatrixScale(ghost.matrix).x).toBeCloseTo(6);

    // Another model replaces it, freeing only the copies, never the model.
    const freed = watchDisposal([...materials, ...resourcesOf(models.pine)]);
    await editing.preview(prop("p", "test:rock", 0));
    expect(freed).toHaveBeenCalledTimes(2);
    expect(ghost.parent).toBeNull();
    await editing.preview(undefined);
    expect(world.getObjectByName("prop-preview")).toBeUndefined();
    expect(editing.previewed).toBeUndefined();
  });

  it("lets a later preview overtake one still loading its model", async () => {
    const { editing, world } = await setupEditing([]);
    const first = editing.preview(prop("p", "test:pine", 0));
    await editing.preview(undefined);
    await first;
    expect(world.getObjectByName("prop-preview")).toBeUndefined();
  });

  it("frees the ring and the preview on dispose", async () => {
    const { editing, world } = await setupEditing([]);
    await editing.preview(prop("p", "test:rock", 0));
    const ring = world.getObjectByName("prop-selection") as THREE.Mesh;
    const ghost = world.getObjectByName("prop-preview")!.children[0] as THREE.Mesh;
    const freed = watchDisposal([
      ring.geometry,
      ring.material as THREE.Material,
      ghost.material as THREE.Material,
    ]);
    editing.dispose();
    expect(freed).toHaveBeenCalledTimes(3);
    expect(world.children).toHaveLength(0);
  });
});

it("pointerToNdc maps the element's corners to −1 and 1, y up", () => {
  const element = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
  } as unknown as Element;
  expect(pointerToNdc({ clientX: 100, clientY: 50 }, element).toArray()).toEqual([-1, 1]);
  expect(pointerToNdc({ clientX: 300, clientY: 150 }, element).toArray()).toEqual([1, -1]);
  expect(pointerToNdc({ clientX: 200, clientY: 100 }, element).toArray()).toEqual([0, 0]);
});

describe("terrainRayHit", () => {
  // Bumpy ground of 41 × 41 samples half a metre apart, with hills and hollows.
  const scene = flatScene(
    41,
    0,
    (x, z) => 1.5 * Math.sin(x * 0.7) * Math.cos(z * 0.5) + 0.2 * x,
    0.5,
  );
  const mesh = terrainMesh(scene);

  it("meets the terrain where a raycast of its mesh does", () => {
    const random = (() => {
      let seed = 7;
      return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    })();
    let hits = 0;
    for (let n = 0; n < 300; n++) {
      // From a camera-like height and distance, down and across the world at various angles.
      const origin = new THREE.Vector3(random() * 40 - 20, 3 + random() * 15, 12 + random() * 20);
      const target = new THREE.Vector3(random() * 24 - 12, random() * 2 - 1, random() * 24 - 12);
      const raycaster = new THREE.Raycaster(origin, target.sub(origin).normalize());
      const [expected] = raycaster.intersectObject(mesh, false);
      const hit = terrainRayHit(scene, raycaster.ray);
      expect(hit === undefined).toBe(expected === undefined);
      if (!hit || !expected) continue;
      hits++;
      expect(hit.distance).toBeCloseTo(expected.distance, 3);
    }
    expect(hits).toBeGreaterThan(200);
  });

  it("takes well under a millisecond per ray on a world the size of Woodland Hollow", () => {
    // About 100 × 60 m at half a metre a sample, seen from the strip's default camera.
    const big = flatScene(201, 0, (x, z) => Math.sin(x * 0.3) + Math.cos(z * 0.2), 0.5);
    const rays = Array.from({ length: 200 }, (_, n) => {
      const origin = new THREE.Vector3(0, 20, 90);
      const target = new THREE.Vector3(-50 + n / 2, 0, -50 + (n % 7) * 10);
      return new THREE.Ray(origin, target.sub(origin).normalize());
    });
    for (const ray of rays) terrainRayHit(big, ray);
    const start = performance.now();
    for (const ray of rays) terrainRayHit(big, ray);
    const perRay = (performance.now() - start) / rays.length;
    // About 4 µs on a desktop; the bound leaves room for slow CI runners.
    expect(perRay).toBeLessThan(0.5);
  });
});

it("ghostOf keeps one see-through copy per material of a multi-material mesh", () => {
  const geometry = new THREE.BoxGeometry();
  const materials = [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial()];
  const ghost = ghostOf(new THREE.Mesh(geometry, materials));
  const copies = (ghost.children[0] as THREE.Mesh).material as THREE.Material[];
  expect(copies).toHaveLength(2);
  for (const [i, copy] of copies.entries()) {
    expect(copy).not.toBe(materials[i]);
    expect(copy.transparent).toBe(true);
  }
});
