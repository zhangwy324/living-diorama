import type { Vec3 } from "@living-diorama/content-schema";
import type { NavigationOverlay, SceneData, SimulationSnapshot } from "@living-diorama/simulation";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { limitCamera } from "./camera";
import type { ImageReader } from "./body/pixels";
import { CreatureBodies, type AssemblyReader, type SpeciesResolver } from "./creatures";
import { PropIcons } from "./cue-icons";
import { CueVisibility } from "./cue-visibility";
import { DebugStats } from "./debug-stats";
import { createSkyLight, createSunLight, lightingAt, SUN_DIRECTION } from "./lighting";
import { SnapshotInterpolator } from "./interpolation";
import { createLayers, type ClipPlane, type LayerName, type SceneLayers } from "./layers";
import { createDebugOverlays, type DebugOverlays } from "./overlays";
import { followPixelRatio } from "./pixel-ratio";
import { PropEditing, type PropPick, type PropPreview } from "./prop-editing";
import { canvasEncoder, PropThumbnails } from "./prop-thumbnails";
import { loadGltf, PropSet, type AssetResolver, type ModelLoader } from "./props";
import { FrameThrottle } from "./throttle";
import { createWaterMaterial, type WaterMaterial } from "./water-material";
import type { PartMotionResolver, PartRoleResolver } from "./voxel/body";
import {
  VoxelThumbnails,
  type AssemblyThumbnailSource,
  type PartThumbnailSource,
} from "./voxel/thumbnails";
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
  readAssembly?: AssemblyReader;
  /** Part types' roles, for voxel bodies' tail anchors. Without it no part has a role. */
  partRole?: PartRoleResolver;
  /** Part types' motions, for voxel bodies' parts (ADR 0024 §8). Without it no part moves. */
  partMotion?: PartMotionResolver;
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
  /**
   * Resolves once the world's first props are placed, each model loaded or drawn as a fallback
   * block (at the latest after the load timeout), or once a `replaceProps` call overtook them.
   */
  readonly ready: Promise<void>;
  /**
   * Replaces the props, and the walkability and region graph of the debug overlays, from the
   * scene and navigation of a world rebuilt after a prop edit. Terrain, water and structures are
   * kept as first built, whatever `scene` says of them. Props already loaded are reused, and the
   * old props stay until the new ones are all placed. Safe to call any number of times: a later
   * call overtakes one still loading, which then resolves to false.
   */
  replaceProps(scene: SceneData, navigation?: NavigationOverlay): Promise<boolean>;
  /** The prop under the pointer, unless the terrain or a structure hides it there. */
  pickProp(pointer: ViewPointer): PropPick | undefined;
  /** The point of the terrain under the pointer, e.g. to drag a prop to; undefined off it. */
  pickGround(pointer: ViewPointer): Vec3 | undefined;
  /** Rings the placement with this ID, or none. The ring follows it through `replaceProps`. */
  selectProp(placementId: string | undefined): void;
  /**
   * Shows a see-through preview of a placement, or none, e.g. while a prop is dragged. Cheap to
   * call on every pointer move. The model is a prop model's asset ref, as in `SceneProp`.
   */
  previewProp(preview: PropPreview | undefined): void;
  /**
   * Hides the placement with this ID, or none, e.g. the original while its preview is dragged;
   * the one hidden before shows again. It stays hidden through `replaceProps` while it exists,
   * and is never picked.
   */
  hideProp(placementId: string | undefined): void;
  /**
   * A thumbnail of a prop model, e.g. for a tile of the editor's prop drawer: a PNG data URL of
   * the model with this asset ref (as in `SceneProp`), seen from above in a three-quarter view in
   * plain daylight on a transparent background, `size` device pixels square (rounded and capped
   * at `MAX_THUMBNAIL_SIZE`, 1024; pass the tile's CSS size × `devicePixelRatio` for a sharp one).
   * Drawn on first request and kept per model and size until `dispose`, so the cache grows only
   * with the refs and sizes asked for; a ref with no model gets the fallback block, drawn once per
   * size. Undefined once the view is disposed.
   */
  propThumbnail(model: string, size: number): Promise<string | undefined>;
  /**
   * A thumbnail of a voxel part alone, e.g. for a tile of the Studio's parts tray: a PNG data URL
   * of the part at rest, drawn like `propThumbnail` (the same view, daylight and sizes) with the
   * material voxel creatures have in the world. Drawn a few a frame, so many asked for at once
   * don't stall one, and kept per `id@version` and size until `dispose` (ADR 0023 §20).
   * Undefined once disposed.
   */
  partThumbnail(source: PartThumbnailSource, size: number): Promise<string | undefined>;
  /** As `partThumbnail`, of a whole voxel assembly in its rest pose, by its `id@version`. */
  assemblyThumbnail(source: AssemblyThumbnailSource, size: number): Promise<string | undefined>;
  dispose(): void;
}

/** A pointer position in CSS pixels of the page, as `clientX` and `clientY` of a pointer event. */
export interface ViewPointer {
  clientX: number;
  clientY: number;
}

/** A pointer position in normalized device coordinates of `element`, from −1 to 1, y up. */
export function pointerToNdc(pointer: ViewPointer, element: Element): THREE.Vector2 {
  const rect = element.getBoundingClientRect();
  return new THREE.Vector2(
    ((pointer.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
    -((pointer.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
  );
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
  /** Pictures of the prop models for cue bubbles; drawn by `render` with the view's renderer. */
  propIcons: PropIcons;
  props: PropSet;
  /** Prop picking, selection and preview for the editor. */
  editing: PropEditing;
  /** As `DioramaView.ready`. */
  ready: Promise<void>;
  /**
   * Replaces the props, walkability and region graph from a rebuilt world, keeping terrain,
   * water and structures. Resolves to whether they were placed, false if a later call overtook.
   */
  replaceProps(scene: SceneData, navigation?: NavigationOverlay): Promise<boolean>;
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
  const terrain = terrainMesh(scene);
  layers.terrain.add(terrain, base.soil);
  layers.water.add(
    ...waterSurfaceMeshes(scene, water.material),
    ...(base.water ? [base.water] : []),
  );
  const structures = structureMeshes(scene);
  layers.structures.add(structures);
  const resolveAsset = options.resolveAsset ?? (() => undefined);
  const propIcons = new PropIcons();
  const props = new PropSet(layers.props, resolveAsset, {
    load: options.loadModel ?? loadGltf,
    placed: (models) => propIcons.place(models),
  });
  const editing = new PropEditing(props, { scene, occluders: [structures], layers }, world);
  const creatures = new CreatureBodies(layers.creatures, {
    resolveSpecies: options.resolveSpecies ?? (() => undefined),
    resolveAsset,
    readImage: options.readImage,
    readAssembly: options.readAssembly,
    partRole: options.partRole,
    partMotion: options.partMotion,
    // The terrain and structures hide the cues of creatures they hide; props never do (#93).
    visibility: new CueVisibility(scene, layers),
    propIcon: (placementId) => propIcons.icon(placementId),
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
  const ready = props.set(scene.props).then(() => undefined);
  const replaceProps = async (next: SceneData, navigation?: NavigationOverlay) => {
    // Overlays and the selection follow only the props actually placed, not an overtaken list.
    if (!(await props.set(next.props))) return false;
    overlays.setProps(next, navigation);
    editing.refresh();
    return true;
  };
  return {
    world,
    layers,
    water,
    creatures,
    overlays,
    propIcons,
    props,
    editing,
    ready,
    replaceProps,
    setTimeOfDay,
  };
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

  const {
    world,
    layers,
    water,
    creatures,
    overlays,
    propIcons,
    props,
    editing,
    ready,
    replaceProps: replaceSceneProps,
    setTimeOfDay,
  } = buildDioramaScene(scene, options);
  // Species sizes cap how high bank jumps arc.
  const snapshots = new SnapshotInterpolator(undefined, options.resolveSpecies);
  const stats = new DebugStats(container.ownerDocument);
  const thumbnails = new PropThumbnails(
    renderer,
    (ref) => props.model(ref),
    canvasEncoder(container.ownerDocument),
  );
  const voxelThumbnails = new VoxelThumbnails(renderer, canvasEncoder(container.ownerDocument));
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

  const raycaster = new THREE.Raycaster();
  const raycast = (pointer: ViewPointer) => {
    raycaster.setFromCamera(pointerToNdc(pointer, canvas), camera);
    return raycaster;
  };

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
    // Draws the pictures of prop models loaded since the last frame, for the cue bubbles.
    propIcons.render(renderer);
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
    async replaceProps(next, navigation) {
      const placed = await replaceSceneProps(next, navigation);
      if (placed) moved = true;
      return placed;
    },
    pickProp(pointer) {
      return editing.pickProp(raycast(pointer));
    },
    pickGround(pointer) {
      return editing.pickGround(raycast(pointer));
    },
    selectProp(placementId) {
      editing.select(placementId);
      moved = true;
    },
    hideProp(placementId) {
      props.hide(placementId);
      moved = true;
    },
    previewProp(preview) {
      void editing.preview(preview).then(() => (moved = true));
      moved = true;
    },
    propThumbnail(model, size) {
      return thumbnails.thumbnail(model, size);
    },
    partThumbnail(source, size) {
      return voxelThumbnails.part(source, size);
    },
    assemblyThumbnail(source, size) {
      return voxelThumbnails.assembly(source, size);
    },
    dispose() {
      cancelAnimationFrame(raf);
      thumbnails.dispose();
      voxelThumbnails.dispose();
      editing.dispose();
      props.dispose();
      container.ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("pointerenter", onPointerEnter);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      observer.disconnect();
      stopPixelRatio();
      controls.dispose();
      timer.dispose();
      creatures.dispose();
      propIcons.dispose();
      overlays.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      stats.element.remove();
    },
  };
}
