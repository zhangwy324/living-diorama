import type { SceneProp } from "@living-diorama/simulation";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// Props drawn from their model assets, instanced per model part (ADR 0007 §1–§2).

/** What the renderer needs to know about an asset ref. `AssetEntry` from extension-api fits. */
export interface RenderAsset {
  kind: "image" | "model";
  url: string;
  /** Metres per model unit; 1 if omitted. */
  scale?: number;
}

export type AssetResolver = (ref: string) => RenderAsset | undefined;
export type ModelLoader = (url: string) => Promise<THREE.Object3D>;

export const loadGltf: ModelLoader = async (url) => (await new GLTFLoader().loadAsync(url)).scene;

const FALLBACK_COLOR = "#8f8a82";

/** A grey block standing in for a model that could not be loaded, sized by what it blocks. */
function fallbackModel(): THREE.Object3D {
  return new THREE.Mesh(
    new THREE.DodecahedronGeometry(1, 0).translate(0, 0.6, 0).scale(1, 0.7, 1),
    new THREE.MeshStandardMaterial({ color: FALLBACK_COLOR, flatShading: true, roughness: 0.9 }),
  );
}

const placementMatrix = (prop: SceneProp, unitScale: number) => {
  const { position, rotationY, scale } = prop.transform;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(position.x, position.y, position.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY),
    new THREE.Vector3().setScalar(scale * unitScale),
  );
};

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
 * Loads each prop model once and adds its instances through `add` when ready. A model that has no
 * asset, is not a model, or fails to load is drawn as a fallback sized from each prop's
 * `blockRadius`, so a broken file never blanks the scene. Resolves when every model is placed.
 * `loaded` hears of each model that loaded, with the IDs of its placements, e.g. for its picture
 * in cue bubbles; it must not change the model.
 */
export async function loadProps(
  props: readonly SceneProp[],
  resolve: AssetResolver,
  add: (objects: THREE.Object3D[]) => void,
  load: ModelLoader = loadGltf,
  loaded?: (model: THREE.Object3D, placementIds: readonly string[]) => void,
): Promise<void> {
  const byModel = new Map<string, SceneProp[]>();
  for (const prop of props) byModel.set(prop.model, [...(byModel.get(prop.model) ?? []), prop]);
  await Promise.all(
    [...byModel].map(async ([ref, placements]) => {
      const asset = resolve(ref);
      let model: THREE.Object3D | undefined;
      if (asset?.kind === "model") {
        try {
          model = await load(asset.url);
        } catch (cause) {
          console.warn(`Could not load model ${ref} from ${asset.url}`, cause);
        }
      } else {
        console.warn(`No model asset for ${ref}`);
      }
      // blockRadius is in world metres, already scaled by the placement (ADR 0018 §3).
      const matrices = placements.map((p) =>
        placementMatrix(
          p,
          model ? (asset?.scale ?? 1) : Math.max(0.25, p.blockRadius) / p.transform.scale,
        ),
      );
      add(instanceModel(model ?? fallbackModel(), matrices));
      if (model)
        loaded?.(
          model,
          placements.map((p) => p.id),
        );
    }),
  );
}
