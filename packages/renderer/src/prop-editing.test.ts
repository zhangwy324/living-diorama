import type { SceneProp } from "@living-diorama/simulation";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pointerToNdc } from "./diorama-view";
import { PropEditing } from "./prop-editing";
import { PropSet, type AssetResolver } from "./props";

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
  const props = new PropSet({ add: (...o) => layer.add(...o) }, resolve, load, placed);
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
      (url) =>
        url === "rock.glb" ? Promise.resolve(rock()) : new Promise((resolve) => (arrive = resolve)),
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
  /** A flat terrain at height 1 over x and z in −5..5, with a world group to draw into. */
  const setupEditing = async (props: SceneProp[]) => {
    const { props: set, models } = setup();
    const terrain = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10).rotateX(-Math.PI / 2).translate(0, 1, 0),
      new THREE.MeshBasicMaterial(),
    );
    const world = new THREE.Group();
    const editing = new PropEditing(set, terrain, [terrain], world);
    await set.set(props);
    return { set, models, terrain, world, editing };
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
