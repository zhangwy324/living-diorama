import type { SceneProp } from "@living-diorama/simulation";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Props drawn from their model assets, instanced per model part (ADR 0007 §1–§2).

/** What the renderer needs to know about an asset ref. `AssetEntry` from extension-api fits. */
export interface RenderAsset {
  /** An image (a drawn species), a 3D model (a prop) or a voxel assembly as JSON (ADR 0022 §17). */
  kind: "image" | "model" | "voxel";
  url: string;
  /** Metres per model unit; 1 if omitted. */
  scale?: number;
}

export type AssetResolver = (ref: string) => RenderAsset | undefined;
export type ModelLoader = (url: string) => Promise<THREE.Object3D>;

export const loadGltf: ModelLoader = async (url) => (await new GLTFLoader().loadAsync(url)).scene;

const FALLBACK_COLOR = "#8f8a82";

/** A grey block standing in for a model that could not be loaded, sized by what it blocks. */
function fallbackModel(): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.DodecahedronGeometry(1, 0).translate(0, 0.6, 0).scale(1, 0.7, 1),
    new THREE.MeshStandardMaterial({ color: FALLBACK_COLOR, flatShading: true, roughness: 0.9 }),
  );
}

/**
 * Makes a model's standard materials non-metallic, in place. The scene has no environment map, so
 * a metallic surface reflects only direct light and its shaded sides render pure black. Low-poly
 * exports often keep glTF's default `metallicFactor` of 1, as the built-in props did (#201).
 */
export function matteModel(model: THREE.Object3D): void {
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    for (const material of [object.material].flat()) {
      if (material instanceof THREE.MeshStandardMaterial) material.metalness = 0;
    }
  });
}

/** A placement's transform as a matrix: where it stands, its turn, its scale times the model's. */
export function placementMatrix(transform: SceneProp["transform"], unitScale: number) {
  const { position, rotationY, scale } = transform;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY),
    new THREE.Vector3().setScalar(scale * unitScale),
  );
}

/** One instanced mesh per mesh in the model, with one instance per placement. */
export function instanceModel(
  model: THREE.Object3D,
  placements: readonly THREE.Matrix4[],
): THREE.InstancedMesh[] {
  model.updateMatrixWorld(true);
  const parts: THREE.InstancedMesh[] = [];
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const mesh = new THREE.InstancedMesh(object.geometry, object.material, placements.length);
    placements.forEach((placement, i) =>
      mesh.setMatrixAt(i, placement.clone().multiply(object.matrixWorld)),
    );
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parts.push(mesh);
  });
  return parts;
}

/**
 * A prop model ready to draw: the loaded model, or the shared fallback block when the ref has no
 * model asset or its model failed to load (`loaded` false).
 */
export interface PropModel {
  model: THREE.Object3D;
  loaded: boolean;
  /** Metres per model unit for a placement: the asset's scale, or the fallback's sizing. */
  unitScale(prop: Pick<SceneProp, "transform" | "blockRadius">): number;
}

/** Where props are added; a `SceneLayer` fits, so props take its clipping planes. */
export interface PropTarget {
  add(...objects: THREE.Object3D[]): void;
}

/** Hears, after each list of props is placed, of every loaded model and its placements' IDs. */
export type PropsPlaced = (
  models: readonly (readonly [THREE.Object3D, readonly string[]])[],
) => void;

/** A model load that has not settled after this long is drawn as the fallback block. */
export const MODEL_LOAD_TIMEOUT_MS = 10_000;

export interface PropSetOptions {
  load?: ModelLoader;
  /** Must not change the models it hears of; e.g. it draws their cue pictures. */
  placed?: PropsPlaced;
  /** How long a model may take to load before the fallback block stands in for it. */
  loadTimeoutMs?: number;
}

interface Part {
  mesh: THREE.InstancedMesh;
  /** The placement each instance draws. */
  ids: readonly string[];
}

/**
 * The world's props, instanced per model part (ADR 0007 §1–§2), replaceable at any time with a
 * new list, e.g. after a prop edit, without touching the rest of the scene.
 *
 * Each model URL is loaded once and kept for the life of the set, so a replacement reuses the
 * models already loaded and swaps all props in one step: no frame lacks them. A ref that has no
 * model asset, or whose model fails to load, is drawn as a fallback block sized from each prop's
 * `blockRadius`, so a broken file never blanks the scene. So is one still loading after
 * `loadTimeoutMs`, so a load that never settles cannot hold up every later list; if it arrives
 * after all, later lists draw it.
 *
 * GPU resources: the instanced meshes of a replaced list are disposed; models and the fallback
 * block (geometries, materials, textures) are shared by every list and freed by `dispose`.
 */
export class PropSet {
  readonly #target: PropTarget;
  readonly #resolve: AssetResolver;
  readonly #load: ModelLoader;
  readonly #placed: PropsPlaced | undefined;
  readonly #timeoutMs: number;
  readonly #models = new Map<string, Promise<THREE.Object3D | undefined>>();
  /** The models that arrived, to free on `dispose`. */
  readonly #loaded = new Set<THREE.Object3D>();
  readonly #warned = new Set<string>();
  #fallback: THREE.Mesh | undefined;
  #parts: Part[] = [];
  #byMesh = new Map<THREE.Object3D, Part>();
  #byId = new Map<string, SceneProp>();
  #generation = 0;
  #disposed = false;
  #hidden: string | undefined;
  /** The instances drawn empty to hide `#hidden`, with the matrices they had. */
  #hiddenInstances: { mesh: THREE.InstancedMesh; index: number; matrix: THREE.Matrix4 }[] = [];

  constructor(target: PropTarget, resolve: AssetResolver, options: PropSetOptions = {}) {
    this.#target = target;
    this.#resolve = resolve;
    this.#load = options.load ?? loadGltf;
    this.#placed = options.placed;
    this.#timeoutMs = options.loadTimeoutMs ?? MODEL_LOAD_TIMEOUT_MS;
  }

  /**
   * Replaces every prop with `props` once all their models are loaded. Resolves to whether this
   * list was placed: false when a later call or `dispose` overtook it, which is safe to ignore.
   */
  async set(props: readonly SceneProp[]): Promise<boolean> {
    if (this.#disposed) return false;
    const generation = ++this.#generation;
    const byModel = new Map<string, SceneProp[]>();
    for (const prop of props) byModel.set(prop.model, [...(byModel.get(prop.model) ?? []), prop]);
    const groups = await Promise.all(
      [...byModel].map(async ([ref, placements]) => ({ placements, ...(await this.model(ref)) })),
    );
    if (generation !== this.#generation || this.#disposed) return false;

    const parts: Part[] = [];
    const loaded: (readonly [THREE.Object3D, readonly string[]])[] = [];
    for (const { placements, model, loaded: isLoaded, unitScale } of groups) {
      const ids = placements.map((p) => p.id);
      const matrices = placements.map((p) => placementMatrix(p.transform, unitScale(p)));
      for (const mesh of instanceModel(model, matrices)) parts.push({ mesh, ids });
      if (isLoaded) loaded.push([model, ids]);
    }
    this.#clear();
    this.#parts = parts;
    this.#byMesh = new Map(parts.map((part) => [part.mesh, part]));
    this.#byId = new Map(props.map((p) => [p.id, p]));
    if (parts.length > 0) this.#target.add(...parts.map((p) => p.mesh));
    // The props stand still, so their world matrices are set once, here, ready for picking.
    for (const { mesh } of parts) mesh.updateWorldMatrix(true, false);
    this.hide(this.#hidden);
    this.#placed?.(loaded);
    return true;
  }

  /**
   * Hides the placement with this ID, or none, e.g. while the editor drags its preview; the one
   * hidden before shows again. It stays hidden when the props are replaced, while it exists.
   */
  hide(placementId: string | undefined): void {
    for (const { mesh, index, matrix } of this.#hiddenInstances) {
      mesh.setMatrixAt(index, matrix);
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.#hiddenInstances = [];
    this.#hidden = placementId;
    if (placementId === undefined) return;
    const empty = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const { mesh, ids } of this.#parts) {
      const index = ids.indexOf(placementId);
      if (index < 0) continue;
      const matrix = new THREE.Matrix4();
      mesh.getMatrixAt(index, matrix);
      this.#hiddenInstances.push({ mesh, index, matrix });
      mesh.setMatrixAt(index, empty);
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** The placement hidden by `hide`, if any. */
  get hidden(): string | undefined {
    return this.#hidden;
  }

  /** The placed prop with this ID, if any. */
  placement(id: string): SceneProp | undefined {
    return this.#byId.get(id);
  }

  /** The instanced meshes drawing the props, e.g. to raycast them. */
  get meshes(): THREE.InstancedMesh[] {
    return this.#parts.map((p) => p.mesh);
  }

  /** The placement that instance `instanceId` of `object`, one of `meshes`, draws. */
  placementAt(object: THREE.Object3D, instanceId: number | undefined): string | undefined {
    if (instanceId === undefined) return undefined;
    return this.#byMesh.get(object)?.ids[instanceId];
  }

  /** The model for an asset ref, loading it on first use; the fallback block if there is none. */
  async model(ref: string): Promise<PropModel> {
    const asset = this.#resolve(ref);
    let model: THREE.Object3D | undefined;
    if (asset?.kind === "model") {
      let loading = this.#models.get(asset.url);
      if (!loading) {
        loading = this.#loadWithTimeout(ref, asset.url);
        this.#models.set(asset.url, loading);
      }
      model = await loading;
    } else if (!this.#warned.has(ref)) {
      this.#warned.add(ref);
      console.warn(`No model asset for ${ref}`);
    }
    if (model) {
      const scale = asset?.scale ?? 1;
      return { model, loaded: true, unitScale: () => scale };
    }
    this.#fallback ??= fallbackModel();
    return {
      model: this.#fallback,
      loaded: false,
      // blockRadius is in world metres, already scaled by the placement (ADR 0018 §3).
      unitScale: (p) => Math.max(0.25, p.blockRadius) / p.transform.scale,
    };
  }

  /** Loads a model, settling as undefined if it fails or takes longer than the timeout. */
  #loadWithTimeout(ref: string, url: string): Promise<THREE.Object3D | undefined> {
    return new Promise((resolve) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        console.warn(`Model ${ref} from ${url} took over ${this.#timeoutMs} ms; drawn as a block`);
        resolve(undefined);
      }, this.#timeoutMs);
      this.#load(url).then(
        (arrived) => {
          clearTimeout(timer);
          // One arriving after `dispose` is freed at once.
          if (this.#disposed) {
            disposeModel(arrived);
            resolve(undefined);
            return;
          }
          matteModel(arrived);
          this.#loaded.add(arrived);
          // Late: the lists placed meanwhile keep their block; later ones draw the model.
          if (timedOut) this.#models.set(url, Promise.resolve(arrived));
          resolve(arrived);
        },
        (cause: unknown) => {
          clearTimeout(timer);
          console.warn(`Could not load model ${ref} from ${url}`, cause);
          resolve(undefined);
        },
      );
    });
  }

  /** Removes the props and frees every GPU resource they hold, models included. */
  dispose(): void {
    this.#disposed = true;
    this.#clear();
    this.#byId.clear();
    this.#models.clear();
    for (const model of this.#loaded) disposeModel(model);
    this.#loaded.clear();
    if (this.#fallback) disposeModel(this.#fallback);
    this.#fallback = undefined;
  }

  #clear(): void {
    for (const { mesh } of this.#parts) {
      mesh.removeFromParent();
      // Frees the instance buffers; the geometry and material belong to the model.
      mesh.dispose();
    }
    this.#parts = [];
    this.#byMesh.clear();
    this.#hiddenInstances = [];
  }
}

/** Frees a model's geometries, materials and their textures. */
export function disposeModel(model: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry as THREE.BufferGeometry);
    for (const material of [object.material].flat()) materials.add(material as THREE.Material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) value.dispose();
    }
    material.dispose();
  }
}
