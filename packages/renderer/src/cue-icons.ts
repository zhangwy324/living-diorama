import * as THREE from "three";

// Pictures of props for cue bubbles (issue #110): a hungry creature's bubble shows the food it
// heads for, drawn from that prop's own model. A model is drawn once, when a bubble first asks for
// it, into a small texture, in a fixed daylight of its own, so the picture reads the same by day
// and by night. The editor's prop thumbnails (`prop-thumbnails.ts`) are drawn the same way.

/** Prop pictures are this many pixels square. */
export const PROP_ICON_SIZE = 128;
/** The model is seen from this far above the horizontal (radians, ~35°)... */
const ICON_PITCH = 0.6;
/** ...and turned this far, for a three-quarter view (radians, ~30°). */
const ICON_YAW = 0.52;
/** A margin around the model, as a share of the picture. */
const ICON_MARGIN = 0.02;

interface PropIcon {
  /** The model, until it is drawn; then the picture alone is kept. */
  model: THREE.Object3D | undefined;
  target: THREE.WebGLRenderTarget | undefined;
}

/**
 * The picture of each prop model, found by the ID of any placement of it. Only models a bubble
 * asks for are drawn, so trees and rocks never are: `icon` asks, and the next `render` draws.
 * Until then, and for a placement of no loaded model, `icon` is undefined and the bubble shows its
 * neutral food icon.
 */
export class PropIcons {
  readonly #byPlacement = new Map<string, PropIcon>();
  /** One per model, kept when the props are replaced, so each model is drawn only once. */
  readonly #byModel = new Map<THREE.Object3D, PropIcon>();
  /** Models asked for and not drawn yet. */
  readonly #wanted = new Set<PropIcon>();

  /**
   * Sets the loaded models with the IDs of their placements, forgetting the placements known
   * before, e.g. when the props are replaced. The models' parts are only read.
   */
  place(models: readonly (readonly [THREE.Object3D, readonly string[]])[]): void {
    this.#byPlacement.clear();
    for (const [model, placementIds] of models) {
      let icon = this.#byModel.get(model);
      if (!icon) {
        icon = { model, target: undefined };
        this.#byModel.set(model, icon);
      }
      for (const id of placementIds) this.#byPlacement.set(id, icon);
    }
  }

  /** The picture of the placement's model once drawn; asking for one not drawn yet queues it. */
  icon(placementId: string | undefined): THREE.Texture | undefined {
    if (placementId === undefined) return undefined;
    const icon = this.#byPlacement.get(placementId);
    if (icon?.model) this.#wanted.add(icon);
    return icon?.target?.texture;
  }

  /** Draws the models asked for since the last call. Cheap when there are none. */
  render(renderer: THREE.WebGLRenderer): void {
    if (this.#wanted.size === 0) return;
    for (const icon of this.#wanted) {
      if (!icon.model) continue;
      const target = iconTarget();
      drawIcon(renderer, icon.model, target);
      icon.target = target;
      icon.model = undefined;
    }
    this.#wanted.clear();
  }

  dispose(): void {
    for (const icon of this.#byModel.values()) icon.target?.dispose();
    this.#byModel.clear();
    this.#byPlacement.clear();
    this.#wanted.clear();
  }
}

/** What `drawIcon` uses of a renderer. A `THREE.WebGLRenderer` fits. */
export type IconRenderer = Pick<
  THREE.WebGLRenderer,
  | "getRenderTarget"
  | "setRenderTarget"
  | "getClearColor"
  | "getClearAlpha"
  | "setClearColor"
  | "clear"
  | "render"
>;

/**
 * Draws a picture of `model` into `target` on a clear background, as `iconStage` stages it, and
 * leaves the renderer drawing where it did, with its clear colour back. The model is only read.
 */
export function drawIcon(
  renderer: IconRenderer,
  model: THREE.Object3D,
  target: THREE.WebGLRenderTarget,
): void {
  const previous = renderer.getRenderTarget();
  const clearColor = renderer.getClearColor(new THREE.Color());
  const clearAlpha = renderer.getClearAlpha();
  const { scene, camera, dispose } = iconStage(model);
  try {
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
  } finally {
    dispose();
    renderer.setRenderTarget(previous);
    renderer.setClearColor(clearColor, clearAlpha);
  }
}

function iconTarget(): THREE.WebGLRenderTarget {
  // Multisampled for smooth edges, half float so dark colours don't band in the linear target,
  // mipmapped as the bubble shows it a few times smaller.
  const target = new THREE.WebGLRenderTarget(PROP_ICON_SIZE, PROP_ICON_SIZE, {
    samples: 4,
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
  });
  target.texture.name = "cue:prop-icon";
  return target;
}

/**
 * A scene holding a copy of `model`'s meshes, sharing their geometry (and a skinned mesh's
 * skeleton, posed as it is), with material copies free of any clipping planes but keeping their
 * shader patches, lit in plain daylight, and a camera framing it in a three-quarter view from
 * slightly above. `dispose` frees the material copies only.
 */
export function iconStage(model: THREE.Object3D): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  dispose: () => void;
} {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight("#f4f8ff", "#8a8070", 2.2));
  const key = new THREE.DirectionalLight("#fff4e2", 2);
  // From above and in front, beside the camera, so the faces it sees are lit.
  key.position.set(-0.2, 1, 1);
  // A fill from the right, so no face it sees is black.
  const fill = new THREE.DirectionalLight("#e8f0ff", 1);
  fill.position.set(1, 0.3, 0.4);
  scene.add(key, fill);
  const copies: THREE.Material[] = [];
  const copy = (material: THREE.Material) => {
    const c = material.clone();
    c.clippingPlanes = null;
    // `clone` drops these, e.g. a voxel body's colour and occlusion decoding (`voxel/body.ts`).
    c.onBeforeCompile = material.onBeforeCompile;
    c.customProgramCacheKey = material.customProgramCacheKey;
    copies.push(c);
    return c;
  };
  const bounds = new THREE.Box3();
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = Array.isArray(object.material)
      ? object.material.map(copy)
      : copy(object.material as THREE.Material);
    const mesh =
      object instanceof THREE.SkinnedMesh
        ? skinnedCopy(object, material)
        : new THREE.Mesh(object.geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(object.matrixWorld);
    mesh.matrixWorld.copy(object.matrixWorld);
    scene.add(mesh);
    let box: THREE.Box3 | null;
    if (mesh instanceof THREE.SkinnedMesh) {
      // Its vertices where its bones put them, not where its geometry holds them.
      mesh.computeBoundingBox();
      box = mesh.boundingBox;
    } else {
      const geometry = object.geometry as THREE.BufferGeometry;
      geometry.computeBoundingBox();
      box = geometry.boundingBox;
    }
    if (box) bounds.union(box.clone().applyMatrix4(object.matrixWorld));
  });
  const camera = frameIcon(bounds);
  return { scene, camera, dispose: () => copies.forEach((m) => m.dispose()) };
}

/** A skinned mesh of `source`'s geometry and skeleton, bound as it is, drawn with `material`. */
function skinnedCopy(
  source: THREE.SkinnedMesh,
  material: THREE.Material | THREE.Material[],
): THREE.SkinnedMesh {
  const mesh = new THREE.SkinnedMesh(source.geometry, material);
  mesh.bindMode = source.bindMode;
  mesh.bind(source.skeleton, source.bindMatrix);
  mesh.frustumCulled = false;
  return mesh;
}

/** An orthographic camera seeing `bounds` whole and centred, from `ICON_PITCH` and `ICON_YAW`. */
export function frameIcon(bounds: THREE.Box3): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  if (bounds.isEmpty()) return camera;
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3()).length();
  const direction = new THREE.Vector3(
    Math.sin(ICON_YAW) * Math.cos(ICON_PITCH),
    Math.sin(ICON_PITCH),
    Math.cos(ICON_YAW) * Math.cos(ICON_PITCH),
  );
  camera.position.copy(center).addScaledVector(direction, size * 2);
  camera.lookAt(center);
  camera.updateMatrixWorld(true);
  // The box's corners in the camera's view, to fit the picture to the model's outline.
  const view = camera.matrixWorldInverse;
  const corner = new THREE.Vector3();
  const fit = new THREE.Box3();
  for (let k = 0; k < 8; k++) {
    corner.set(
      k & 1 ? bounds.max.x : bounds.min.x,
      k & 2 ? bounds.max.y : bounds.min.y,
      k & 4 ? bounds.max.z : bounds.min.z,
    );
    fit.expandByPoint(corner.applyMatrix4(view));
  }
  const half = (Math.max(fit.max.x - fit.min.x, fit.max.y - fit.min.y) / 2) * (1 + 2 * ICON_MARGIN);
  const midX = (fit.min.x + fit.max.x) / 2;
  const midY = (fit.min.y + fit.max.y) / 2;
  camera.left = midX - half;
  camera.right = midX + half;
  camera.top = midY + half;
  camera.bottom = midY - half;
  camera.near = Math.max(0.001, -fit.max.z - 1);
  camera.far = -fit.min.z + 1;
  camera.updateProjectionMatrix();
  return camera;
}
