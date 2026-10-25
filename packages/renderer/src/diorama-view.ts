import type { SceneData } from "@living-diorama/simulation";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  baseMeshes,
  propMeshes,
  surfaceMeshes,
  terrainMesh,
  type PropPlaceholder,
} from "./world-meshes";

/** Horizontal field of view kept constant, so the default view always spans the world's width. */
const HORIZONTAL_FOV = (40 * Math.PI) / 180;
const PITCH = (16 * Math.PI) / 180;

export interface DioramaViewOptions {
  propPlaceholders?: Readonly<Record<string, PropPlaceholder>>;
}

export interface DioramaView {
  /** Animates back to the art-directed default framing. */
  resetCamera(): void;
  dispose(): void;
}

/** Default framing for a viewport aspect ratio: the full world width, seen slightly from above. */
export function defaultFraming(scene: SceneData, aspect: number) {
  const { min, max } = scene.bounds;
  const halfWidth = ((max.x - min.x) / 2) * 1.02;
  const vertical = 2 * Math.atan(Math.tan(HORIZONTAL_FOV / 2) / aspect);
  const distance = halfWidth / Math.tan(HORIZONTAL_FOV / 2);
  const target = new THREE.Vector3(0, 2.2, (min.z + max.z) / 2 - 4);
  const position = target
    .clone()
    .add(new THREE.Vector3(0, Math.sin(PITCH), Math.cos(PITCH)).multiplyScalar(distance));
  return { fov: THREE.MathUtils.radToDeg(vertical), position, target };
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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const world = new THREE.Scene();
  world.background = new THREE.Color("#cfe3ea");
  world.add(new THREE.HemisphereLight("#f4f7ff", "#5b6b3a", 1.1));
  const sun = new THREE.DirectionalLight("#fff3dc", 2.2);
  sun.position.set(-30, 45, 28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const { min, max } = scene.bounds;
  Object.assign(sun.shadow.camera, {
    left: -40,
    right: 40,
    top: 30,
    bottom: -30,
    near: 1,
    far: 140,
  });
  sun.shadow.bias = -0.0005;
  world.add(sun);

  world.add(terrainMesh(scene), baseMeshes(scene), surfaceMeshes(scene));
  world.add(propMeshes(scene.props, options.propPlaceholders ?? {}));

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

  // Keep panning inside the world's footprint.
  controls.addEventListener("change", () => {
    const t = controls.target;
    const clamped = t
      .clone()
      .set(
        THREE.MathUtils.clamp(t.x, min.x, max.x),
        THREE.MathUtils.clamp(t.y, min.y, max.y),
        THREE.MathUtils.clamp(t.z, min.z, max.z),
      );
    if (!clamped.equals(t)) {
      camera.position.add(clamped.clone().sub(t));
      t.copy(clamped);
    }
  });

  let raf = 0;
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (reset) {
      reset.t = Math.min(1, reset.t + 0.04);
      const e = 1 - (1 - reset.t) ** 3;
      camera.position.lerpVectors(reset.from, reset.to, e);
      controls.target.lerpVectors(reset.fromTarget, reset.toTarget, e);
      if (reset.t >= 1) reset = undefined;
    }
    controls.update();
    renderer.render(world, camera);
  };
  loop();

  return {
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
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
