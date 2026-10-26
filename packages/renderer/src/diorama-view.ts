import type { SceneData, SimulationSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { limitCamera } from "./camera";
import { CreatureSprites, type ImageLoader, type SpeciesResolver } from "./creatures";
import { SnapshotInterpolator } from "./interpolation";
import { createLayers, type ClipPlane, type LayerName, type SceneLayers } from "./layers";
import { loadGltf, loadProps, type AssetResolver, type ModelLoader } from "./props";
import { createWaterMaterial, type WaterMaterial } from "./water-material";
import { baseMeshes, structureMeshes, terrainMesh, waterSurfaceMeshes } from "./world-meshes";

/** Horizontal field of view kept constant, so the default view always spans the world's width. */
const HORIZONTAL_FOV = (40 * Math.PI) / 180;
const PITCH = (16 * Math.PI) / 180;
/** The default view looks this fraction of the world's depth behind its centre. */
const TARGET_DEPTH_OFFSET = 0.1;
/** Direction the sunlight comes from: high, from the front left. */
const SUN_DIRECTION = new THREE.Vector3(-30, 45, 28).normalize();

export interface DioramaViewOptions {
  /** Looks up asset refs (prop models). Without it every prop is drawn as a fallback. */
  resolveAsset?: AssetResolver;
  loadModel?: ModelLoader;
  /** Looks up species to draw creatures. Without it no creature is drawn. */
  resolveSpecies?: SpeciesResolver;
  loadImage?: ImageLoader;
}

export interface DioramaView {
  /** Hands the view the newest simulation snapshot; creatures are drawn interpolated (ADR 0007 §8). */
  pushSnapshot(snapshot: SimulationSnapshot): void;
  /** Animates back to the art-directed default framing. */
  resetCamera(): void;
  /** Clips a layer's materials with these planes; an empty list turns clipping off (ADR 0007 §4). */
  setClipping(layer: LayerName, planes: readonly ClipPlane[]): void;
  /** Resolves once every prop model is placed (or replaced by its fallback). */
  readonly ready: Promise<void>;
  dispose(): void;
}

const meanHeight = (scene: SceneData) =>
  scene.terrain.heights.reduce((sum, h) => sum + h, 0) / Math.max(1, scene.terrain.heights.length);

/** Default framing for a viewport aspect ratio: the full world width, seen slightly from above. */
export function defaultFraming(scene: SceneData, aspect: number) {
  const { min, max } = scene.bounds;
  const halfWidth = ((max.x - min.x) / 2) * 1.02;
  const vertical = 2 * Math.atan(Math.tan(HORIZONTAL_FOV / 2) / aspect);
  const distance = halfWidth / Math.tan(HORIZONTAL_FOV / 2);
  const target = new THREE.Vector3(
    (min.x + max.x) / 2,
    meanHeight(scene),
    (min.z + max.z) / 2 - (max.z - min.z) * TARGET_DEPTH_OFFSET,
  );
  const position = target
    .clone()
    .add(new THREE.Vector3(0, Math.sin(PITCH), Math.cos(PITCH)).multiplyScalar(distance));
  return { fov: THREE.MathUtils.radToDeg(vertical), position, target };
}

/** A sun whose shadow camera just covers the world's bounding box. */
export function createSun(scene: SceneData): THREE.DirectionalLight {
  const { min, max } = scene.bounds;
  const box = new THREE.Box3(
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  );
  const { center, radius } = box.getBoundingSphere(new THREE.Sphere());
  const sun = new THREE.DirectionalLight("#fff3dc", 2.2);
  sun.position.copy(center).addScaledVector(SUN_DIRECTION, radius * 2);
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, {
    left: -radius,
    right: radius,
    top: radius,
    bottom: -radius,
    near: radius,
    far: radius * 3,
  });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  return sun;
}

export interface DioramaScene {
  world: THREE.Scene;
  layers: SceneLayers;
  water: WaterMaterial;
  creatures: CreatureSprites;
  /** Resolves once every prop model is placed. */
  ready: Promise<void>;
}

/** Builds the whole scene graph. Needs no WebGL, so it runs in tests. */
export function buildDioramaScene(
  scene: SceneData,
  options: DioramaViewOptions = {},
): DioramaScene {
  const world = new THREE.Scene();
  world.background = new THREE.Color("#cfe3ea");
  world.add(new THREE.HemisphereLight("#f4f7ff", "#5b6b3a", 1.1));
  const sun = createSun(scene);
  world.add(sun, sun.target);

  const layers = createLayers(world);
  const water = createWaterMaterial();
  const base = baseMeshes(scene, water.material);
  layers.terrain.add(terrainMesh(scene), base.soil);
  layers.water.add(
    ...waterSurfaceMeshes(scene, water.material),
    ...(base.water ? [base.water] : []),
  );
  layers.structures.add(structureMeshes(scene));
  const resolveAsset = options.resolveAsset ?? (() => undefined);
  const creatures = new CreatureSprites(layers.creatures, {
    resolveSpecies: options.resolveSpecies ?? (() => undefined),
    resolveAsset,
    loadImage: options.loadImage,
    ground: [layers.terrain.group, layers.structures.group],
  });
  const ready = loadProps(
    scene.props,
    resolveAsset,
    (objects) => layers.props.add(...objects),
    options.loadModel ?? loadGltf,
  );
  return { world, layers, water, creatures, ready };
}

export function createDioramaView(
  container: HTMLElement,
  scene: SceneData,
  options: DioramaViewOptions = {},
): DioramaView {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  const { world, layers, water, creatures, ready } = buildDioramaScene(scene, options);
  const snapshots = new SnapshotInterpolator();

  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(85);
  controls.minDistance = 8;
  controls.maxDistance = 220;

  let reset:
    | {
        from: THREE.Vector3;
        to: THREE.Vector3;
        fromTarget: THREE.Vector3;
        toTarget: THREE.Vector3;
        t: number;
      }
    | undefined;

  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.fov = defaultFraming(scene, camera.aspect).fov;
    camera.updateProjectionMatrix();
  };
  const frame = () => {
    const f = defaultFraming(scene, camera.aspect);
    camera.position.copy(f.position);
    controls.target.copy(f.target);
    controls.update();
  };
  resize();
  frame();
  const observer = new ResizeObserver(resize);
  observer.observe(container);

  controls.addEventListener("change", () => limitCamera(scene, camera.position, controls.target));

  const timer = new THREE.Timer();
  let raf = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    timer.update(now);
    water.update(timer.getElapsed());
    if (reset) {
      reset.t = Math.min(1, reset.t + 0.04);
      const e = 1 - (1 - reset.t) ** 3;
      camera.position.lerpVectors(reset.from, reset.to, e);
      controls.target.lerpVectors(reset.fromTarget, reset.toTarget, e);
      if (reset.t >= 1) reset = undefined;
    }
    controls.update();
    creatures.update(snapshots.sample(now), camera);
    renderer.render(world, camera);
  };
  raf = requestAnimationFrame(loop);

  return {
    pushSnapshot(snapshot) {
      snapshots.push(snapshot, performance.now());
    },
    resetCamera() {
      const f = defaultFraming(scene, camera.aspect);
      reset = {
        from: camera.position.clone(),
        to: f.position,
        fromTarget: controls.target.clone(),
        toTarget: f.target,
        t: 0,
      };
    },
    setClipping(layer, planes) {
      layers[layer].setClipping(planes);
    },
    ready,
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      timer.dispose();
      creatures.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
