import type { NavigationOverlay, SceneData, SimulationSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { limitCamera } from "./camera";
import type { ImageReader } from "./body/pixels";
import { CreatureBodies, type SpeciesResolver } from "./creatures";
import { CueVisibility } from "./cue-visibility";
import { DebugStats } from "./debug-stats";
import { createSkyLight, createSunLight, lightingAt, SUN_DIRECTION } from "./lighting";
import { SnapshotInterpolator } from "./interpolation";
import { createLayers, type ClipPlane, type LayerName, type SceneLayers } from "./layers";
import { createDebugOverlays, type DebugOverlays } from "./overlays";
import { followPixelRatio } from "./pixel-ratio";
import { loadGltf, loadProps, type AssetResolver, type ModelLoader } from "./props";
import { FrameThrottle } from "./throttle";
import { createWaterMaterial, type WaterMaterial } from "./water-material";
import { baseMeshes, structureMeshes, terrainMesh, waterSurfaceMeshes } from "./world-meshes";

/** Horizontal field of view kept constant, so the default view always spans the world's width. */
const HORIZONTAL_FOV = (40 * Math.PI) / 180;
const PITCH = (16 * Math.PI) / 180;
/** The default view looks this fraction of the world's depth behind its centre. */
const TARGET_DEPTH_OFFSET = 0.1;

export interface DioramaViewOptions {
  /** Looks up asset refs (prop models). Without it every prop is drawn as a fallback. */
  resolveAsset?: AssetResolver;
  loadModel?: ModelLoader;
  /** Looks up species to draw creatures. Without it no creature is drawn. */
  resolveSpecies?: SpeciesResolver;
  readImage?: ImageReader;
  /** Walkability, region graph and portals for the debug overlays (ADR 0007 §10). */
  navigation?: NavigationOverlay;
}

/** Where the camera is and what it looks at, e.g. to keep one per window shape (ADR 0016 §6). */
export interface CameraState {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

export interface DioramaView {
  /**
   * Hands the view the newest simulation snapshot; creatures are drawn interpolated (ADR 0007 §8)
   * and the diorama is lit for its time of day (ADR 0018 §6).
   */
  pushSnapshot(snapshot: SimulationSnapshot): void;
  /** Forgets earlier snapshots after the world was replaced by a save, so none is blended from. */
  resetSnapshots(): void;
  /**
   * Shows or hides the debug overlays and stats. Routes, needs, knowledge and home appear only
   * once the simulation sends them, which its own `set_debug` command turns on.
   */
  setDebug(enabled: boolean): void;
  /** Animates back to the art-directed default framing. */
  resetCamera(): void;
  /** The camera's current state. */
  cameraState(): CameraState;
  /** Moves the camera to `state` at once, or to the default framing when it is undefined. */
  setCameraState(state: CameraState | undefined): void;
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

const boundingSphere = (scene: SceneData) => {
  const { min, max } = scene.bounds;
  const box = new THREE.Box3(
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  );
  return box.getBoundingSphere(new THREE.Sphere());
};

/**
 * Puts the sun (or moon) towards `direction` from the world's centre. The shadow camera is a
 * cube around the world's bounding sphere, so it covers the world from any direction.
 */
const aimSun = (sun: THREE.DirectionalLight, world: THREE.Sphere, direction: THREE.Vector3) => {
  sun.position.copy(world.center).addScaledVector(direction, world.radius * 2);
  sun.target.position.copy(world.center);
};

/** A sun whose shadow camera just covers the world's bounding box. */
export function createSun(
  scene: SceneData,
  sphere: THREE.Sphere = boundingSphere(scene),
): THREE.DirectionalLight {
  const { radius } = sphere;
  const sun = createSunLight();
  aimSun(sun, sphere, SUN_DIRECTION);
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
  creatures: CreatureBodies;
  overlays: DebugOverlays;
  /** Resolves once every prop model is placed. */
  ready: Promise<void>;
  /**
   * Lights the scene for `minutes` since local midnight; it starts in daylight. Returns whether
   * the light changed: it ignores non-finite minutes and changes only once per whole minute.
   */
  setTimeOfDay(minutes: number): boolean;
}

/** Builds the whole scene graph. Needs no WebGL, so it runs in tests. */
export function buildDioramaScene(
  scene: SceneData,
  options: DioramaViewOptions = {},
): DioramaScene {
  const world = new THREE.Scene();
  const background = new THREE.Color("#cfe3ea");
  world.background = background;
  const sky = createSkyLight();
  world.add(sky);
  const sphere = boundingSphere(scene);
  const sun = createSun(scene, sphere);
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
  const creatures = new CreatureBodies(layers.creatures, {
    resolveSpecies: options.resolveSpecies ?? (() => undefined),
    resolveAsset,
    readImage: options.readImage,
    // The terrain and structures hide the cues of creatures they hide; props never do (#93).
    visibility: new CueVisibility(scene, layers),
  });
  let shownMinute: number | undefined;
  const setTimeOfDay = (minutes: number) => {
    if (!Number.isFinite(minutes)) return false;
    const minute = Math.floor(minutes);
    if (minute === shownMinute) return false;
    shownMinute = minute;
    const light = lightingAt(minute);
    sun.color.copy(light.keyColor);
    sun.intensity = light.keyIntensity;
    sun.shadow.intensity = light.shadowIntensity;
    aimSun(sun, sphere, light.keyDirection);
    sky.color.copy(light.skyColor);
    sky.groundColor.copy(light.groundColor);
    sky.intensity = light.skyIntensity;
    background.copy(light.background);
    // Dark z's by day, light ones at night (#93); they switch halfway through dusk and dawn.
    creatures.setNight(light.night >= 0.5);
    return true;
  };
  const overlays = createDebugOverlays(scene, options.navigation);
  world.add(overlays.group);
  const ready = loadProps(
    scene.props,
    resolveAsset,
    (objects) => layers.props.add(...objects),
    options.loadModel ?? loadGltf,
  );
  return { world, layers, water, creatures, overlays, ready, setTimeOfDay };
}

export function createDioramaView(
  container: HTMLElement,
  scene: SceneData,
  options: DioramaViewOptions = {},
): DioramaView {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  const { world, layers, water, creatures, overlays, ready, setTimeOfDay } = buildDioramaScene(
    scene,
    options,
  );
  const snapshots = new SnapshotInterpolator();
  const stats = new DebugStats(container.ownerDocument);
  container.appendChild(stats.element);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = THREE.MathUtils.degToRad(85);
  controls.minDistance = 8;
  controls.maxDistance = 220;

  // Cue sprites are sized in CSS pixels of the view, and cues fade on real time (ADR 0018 §15).
  const cueView = { camera, heightPx: 1 };
  const creatureFrame = { time: 0, realTime: 0, view: cueView };

  let reset:
    | {
        from: THREE.Vector3;
        to: THREE.Vector3;
        fromTarget: THREE.Vector3;
        toTarget: THREE.Vector3;
        t: number;
      }
    | undefined;

  let height = 1;
  const resize = () => {
    const width = Math.max(1, container.clientWidth);
    height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height);
    camera.aspect = width / height;
    cueView.heightPx = height;
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
  // Sharp on every monitor, without drawing at 2× on a 100% one (issue #55).
  const stopPixelRatio = followPixelRatio(window, (ratio) => {
    renderer.setPixelRatio(ratio);
    renderer.render(world, camera);
  });
  // Resizing clears the canvas. Draw again before the browser paints, or a throttled loop would
  // leave it blank until its next frame, e.g. throughout a drag of the strip's height handle.
  const observer = new ResizeObserver(() => {
    resize();
    renderer.render(world, camera);
  });
  observer.observe(container);

  // Full frame rate while the pointer is over the view or the camera moves (ADR 0007 §11).
  let hovered = false;
  let interacting = false;
  let moved = false;
  const canvas = renderer.domElement;
  const onPointerEnter = () => (hovered = true);
  const onPointerLeave = () => (hovered = false);
  canvas.addEventListener("pointerenter", onPointerEnter);
  canvas.addEventListener("pointerleave", onPointerLeave);
  controls.addEventListener("start", () => (interacting = true));
  controls.addEventListener("end", () => (interacting = false));
  controls.addEventListener("change", () => {
    moved = true;
    limitCamera(scene, camera.position, controls.target);
  });

  const timer = new THREE.Timer();
  const throttle = new FrameThrottle();
  let raf = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    // Damping keeps moving the camera after a drag ends, so the frame after a change is full rate.
    const fullRate = hovered || interacting || moved || reset !== undefined;
    if (!throttle.due(now, fullRate)) return;
    moved = false;
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
    const poses = snapshots.sample(now);
    creatureFrame.time = timer.getElapsed();
    creatureFrame.realTime = now / 1000;
    creatures.update(poses, creatureFrame);
    if (overlays.group.visible) {
      overlays.routes.update(poses);
      // One screen pixel's height at one metre from the camera, so labels keep their pixel size.
      overlays.labels.update(
        poses,
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / height,
      );
      stats.frame(now, fullRate);
    }
    renderer.render(world, camera);
  };
  raf = requestAnimationFrame(loop);

  // Hidden pages are not rendered at all; the simulation keeps running in its worker.
  const onVisibilityChange = () => {
    cancelAnimationFrame(raf);
    if (!container.ownerDocument.hidden) raf = requestAnimationFrame(loop);
  };
  container.ownerDocument.addEventListener("visibilitychange", onVisibilityChange);

  return {
    pushSnapshot(snapshot) {
      // The water animates on render time, so it stops with the simulation.
      timer.setTimescale(snapshot.paused ? 0 : 1);
      snapshots.push(snapshot, performance.now());
      overlays.routes.setRoutes(snapshot);
      overlays.labels.setSnapshot(snapshot);
      // Relit only when the minute changes; the next frame is then drawn at full rate.
      if (setTimeOfDay(snapshot.timeOfDay)) moved = true;
      stats.snapshot(snapshot);
    },
    resetSnapshots() {
      snapshots.reset();
      stats.reset();
    },
    setDebug(enabled) {
      overlays.group.visible = enabled;
      stats.element.hidden = !enabled;
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
    cameraState() {
      return { position: camera.position.toArray(), target: controls.target.toArray() };
    },
    setCameraState(state) {
      reset = undefined;
      if (state) {
        camera.position.fromArray(state.position);
        controls.target.fromArray(state.target);
        controls.update();
      } else {
        frame();
      }
      moved = true;
    },
    setClipping(layer, planes) {
      layers[layer].setClipping(planes);
    },
    ready,
    dispose() {
      cancelAnimationFrame(raf);
      container.ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("pointerenter", onPointerEnter);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      observer.disconnect();
      stopPixelRatio();
      controls.dispose();
      timer.dispose();
      creatures.dispose();
      overlays.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      stats.element.remove();
    },
  };
}
