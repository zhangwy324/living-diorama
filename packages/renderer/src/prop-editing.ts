import type { Vec3 } from "@living-diorama/content-schema";
import type { SceneProp } from "@living-diorama/simulation";
import * as THREE from "three";
import { placementMatrix, type PropSet } from "./props";

// What the prop editor needs of the renderer (M17): picking a prop or a point on the ground under
// the pointer, marking the selected prop and previewing a placement while it is dragged. All of
// it only reads and draws; edits go to the simulation as commands, never through the renderer.

/** A prop under the pointer and where the ray met it. */
export interface PropPick {
  placementId: string;
  point: Vec3;
}

/** A placement to preview: which model, where, turned and scaled how, and what it blocks. */
export type PropPreview = Pick<SceneProp, "model" | "transform" | "blockRadius">;

/** The selection ring is this much wider than what the prop blocks, and at least `MIN_RING`. */
const RING_MARGIN = 1.5;
const MIN_RING = 1;
/** It floats this far above the prop's base, in metres. */
const RING_LIFT = 0.05;
const SELECTION = "#fff3a0";
/** How much of the scene shows through a preview. */
const PREVIEW_OPACITY = 0.55;

/**
 * Picking, the selection ring and the placement preview over a `PropSet`. `ground` is what
 * `pickGround` hits (the terrain); `occluders` hide props behind them from `pickProp` (the
 * terrain and structures). The ring and preview are added to `parent` and drawn unclipped.
 */
export class PropEditing {
  readonly #props: PropSet;
  readonly #ground: THREE.Object3D;
  readonly #occluders: readonly THREE.Object3D[];
  readonly #ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  #selected: string | undefined;
  #preview: PropPreview | undefined;
  /** The preview's model and its see-through copy, once loaded. */
  #ghost: { ref: string; group: THREE.Group; unitScale: (p: PropPreview) => number } | undefined;
  #generation = 0;
  #disposed = false;
  readonly #parent: THREE.Object3D;

  constructor(
    props: PropSet,
    ground: THREE.Object3D,
    occluders: readonly THREE.Object3D[],
    parent: THREE.Object3D,
  ) {
    this.#props = props;
    this.#ground = ground;
    this.#occluders = occluders;
    this.#parent = parent;
    const material = new THREE.MeshBasicMaterial({
      color: SELECTION,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.#ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 1, 48).rotateX(-Math.PI / 2), material);
    this.#ring.name = "prop-selection";
    this.#ring.renderOrder = 12;
    this.#ring.visible = false;
    parent.add(this.#ring);
  }

  /** The prop nearest along the ray, unless the terrain or a structure is nearer. */
  pickProp(raycaster: THREE.Raycaster): PropPick | undefined {
    const meshes = this.#props.meshes;
    const targets = [...meshes, ...this.#occluders];
    for (const target of targets) target.updateWorldMatrix(true, true);
    const [hit] = raycaster.intersectObjects(targets, true);
    if (!hit || !(hit.object instanceof THREE.InstancedMesh)) return undefined;
    const placementId = this.#props.placementAt(hit.object, hit.instanceId);
    if (placementId === undefined) return undefined;
    return { placementId, point: { x: hit.point.x, y: hit.point.y, z: hit.point.z } };
  }

  /** Where the ray meets the terrain, e.g. where a dragged prop would go; undefined off it. */
  pickGround(raycaster: THREE.Raycaster): Vec3 | undefined {
    this.#ground.updateWorldMatrix(true, false);
    const [hit] = raycaster.intersectObject(this.#ground, false);
    return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : undefined;
  }

  /** Rings the placement with this ID, or none; the ring follows it when the props change. */
  select(placementId: string | undefined): void {
    this.#selected = placementId;
    this.refresh();
  }

  get selected(): string | undefined {
    return this.#selected;
  }

  /** Moves the ring to the selected placement, hiding it when it is gone. */
  refresh(): void {
    const prop = this.#selected === undefined ? undefined : this.#props.placement(this.#selected);
    this.#ring.visible = prop !== undefined;
    if (!prop) return;
    const { x, y, z } = prop.transform.position;
    this.#ring.position.set(x, y + RING_LIFT, z);
    this.#ring.scale.setScalar(Math.max(MIN_RING, prop.blockRadius * RING_MARGIN));
  }

  /**
   * Shows a see-through copy of the model at the placement, or none. Cheap to call on every
   * pointer move: a preview of the same model only moves. Resolves once it shows; a later call
   * overtakes one still loading its model.
   */
  async preview(preview: PropPreview | undefined): Promise<void> {
    if (this.#disposed) return;
    const generation = ++this.#generation;
    this.#preview = preview;
    if (!preview) {
      this.#dropGhost();
      return;
    }
    if (this.#ghost?.ref !== preview.model) {
      const { model, unitScale } = await this.#props.model(preview.model);
      if (generation !== this.#generation || this.#disposed) return;
      this.#dropGhost();
      this.#ghost = { ref: preview.model, group: ghostOf(model), unitScale };
      this.#parent.add(this.#ghost.group);
    }
    const ghost = this.#ghost;
    if (!ghost) return;
    ghost.group.matrix.copy(placementMatrix(preview.transform, ghost.unitScale(preview)));
    ghost.group.matrixWorldNeedsUpdate = true;
  }

  /** The preview shown or loading, if any. */
  get previewed(): PropPreview | undefined {
    return this.#preview;
  }

  dispose(): void {
    this.#disposed = true;
    this.#dropGhost();
    this.#ring.geometry.dispose();
    this.#ring.material.dispose();
    this.#ring.removeFromParent();
  }

  #dropGhost(): void {
    if (!this.#ghost) return;
    // The ghost shares the model's geometry; only its material copies are its own.
    this.#ghost.group.traverse((object) => {
      if (object instanceof THREE.Mesh) (object.material as THREE.Material).dispose();
    });
    this.#ghost.group.removeFromParent();
    this.#ghost = undefined;
  }
}

/**
 * A see-through copy of `model`: its meshes, sharing their geometry, with material copies drawn
 * half transparent and casting no shadow. The group's matrix is set by hand.
 */
export function ghostOf(model: THREE.Object3D): THREE.Group {
  const group = new THREE.Group();
  group.name = "prop-preview";
  group.matrixAutoUpdate = false;
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const source = Array.isArray(object.material) ? object.material[0] : object.material;
    const material = (source as THREE.Material).clone();
    material.transparent = true;
    material.opacity = PREVIEW_OPACITY;
    material.depthWrite = false;
    material.clippingPlanes = null;
    const mesh = new THREE.Mesh(object.geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(object.matrixWorld);
    mesh.renderOrder = 12;
    group.add(mesh);
  });
  return group;
}
