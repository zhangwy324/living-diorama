import type { Vec3 } from "@living-diorama/content-schema";
import * as THREE from "three";

// Scene layers with per-layer clipping planes (ADR 0007 §4, roadmap §1.5). Nothing clips in v1;
// the future cave cutaway sets planes on the terrain layer without touching the scene graph.

export const LAYER_NAMES = ["terrain", "water", "structures", "props", "creatures"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

/** A clipping plane as plain data: points with `normal · p + constant < 0` are cut away. */
export interface ClipPlane {
  normal: Vec3;
  constant: number;
}

export class SceneLayer {
  readonly group = new THREE.Group();
  #planes: THREE.Plane[] = [];

  constructor(readonly name: LayerName) {
    this.group.name = name;
  }

  /** Adds objects to the layer; their materials take the layer's clipping planes. */
  add(...objects: THREE.Object3D[]): void {
    for (const object of objects) {
      this.group.add(object);
      applyPlanes(object, this.#planes);
    }
  }

  setClipping(planes: readonly ClipPlane[]): void {
    this.#planes = planes.map(
      ({ normal, constant }) =>
        new THREE.Plane(new THREE.Vector3(normal.x, normal.y, normal.z), constant),
    );
    applyPlanes(this.group, this.#planes);
  }

  /** Whether the layer's clipping planes cut away `point`, in world space. Reads only. */
  isClipped(point: THREE.Vector3): boolean {
    for (const plane of this.#planes) if (plane.distanceToPoint(point) < 0) return true;
    return false;
  }
}

function applyPlanes(root: THREE.Object3D, planes: THREE.Plane[]): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials: THREE.Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) {
      // The plane count is compiled into the shader, so a change needs a recompile.
      if ((material.clippingPlanes?.length ?? 0) !== planes.length) material.needsUpdate = true;
      material.clippingPlanes = planes;
    }
  });
}

export type SceneLayers = Record<LayerName, SceneLayer>;

export function createLayers(scene: THREE.Scene): SceneLayers {
  const layers = Object.fromEntries(LAYER_NAMES.map((name) => [name, new SceneLayer(name)]));
  for (const layer of Object.values(layers)) scene.add(layer.group);
  return layers as SceneLayers;
}
