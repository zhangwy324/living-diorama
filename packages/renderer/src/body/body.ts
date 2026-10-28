import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { traceOutline, type Outline, type Point } from "./outline";
import type { Pixels } from "./pixels";
import { bodyColours } from "./textures";

// A solid body extruded from a drawing (ADR 0011, ADR 0017). The drawing faces +x, feet at y = 0.

/** Thickness as a share of the body's height. */
export const BODY_DEPTH = 0.4;
/** The fallback block's rounded edge, as a share of its height. */
const FALLBACK_RADIUS = 0.04;
const EMISSIVE_INTENSITY = 0.35;
const ROUGHNESS = 0.9;
/**
 * Bodies are drawn into the shadow map by their faces towards the sun. By default the far side is,
 * and next to the feet it is so close to the ground that the sun's bias leaves a lit gap there
 * (ADR 0011 §10). Bodies receive no shadows, so they can't shadow themselves with this.
 */
const SHADOW_SIDE = THREE.FrontSide;
const FALLBACK_COLOR = "#8f8a82";
const FALLBACK_ASPECT = 0.75;

export interface Body {
  geometry: THREE.BufferGeometry;
  /** One material for the front, back and walls: the extrusion's two groups share it. */
  material: THREE.Material;
  dispose(): void;
}

/** Builds a body `height` metres tall from a drawing, or nothing if it has no opaque shape. */
export function buildBody(pixels: Pixels, height: number): Body | undefined {
  const outline = traceOutline(pixels);
  if (!outline.shapes.length) return undefined;
  const geometry = bodyGeometry(outline, pixels, height);
  // Faces and walls read the same texture, so a wall takes the colour of the rim it runs back from.
  const map = bodyTexture(bodyColours(pixels), pixels.width, pixels.height);
  const material = new THREE.MeshStandardMaterial({
    map,
    emissive: "#ffffff",
    emissiveMap: map,
    emissiveIntensity: EMISSIVE_INTENSITY,
    roughness: ROUGHNESS,
    shadowSide: SHADOW_SIDE,
  });
  return {
    geometry,
    material,
    dispose() {
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}

/**
 * The extruded shapes with their holes, scaled to `height`, centred on x and z, feet at y = 0.
 * The walls run straight from the front face to the back, so the silhouette is the drawing's.
 */
export function bodyGeometry(
  outline: Outline,
  image: { width: number; height: number },
  height: number,
): THREE.BufferGeometry {
  // Built in pixels with y up, then scaled. The texture's rows are top first, so v = -y / height.
  const drawn = outline.bounds.maxY - outline.bounds.minY;
  const vectors = (loop: readonly Point[]) => loop.map(([x, y]) => new THREE.Vector2(x, -y));
  const shapes = outline.shapes.map(({ outer, holes }) => {
    const shape = new THREE.Shape(vectors(outer));
    shape.holes = holes.map((loop) => new THREE.Path(vectors(loop)));
    return shape;
  });
  const uv = (vertices: number[], index: number) =>
    new THREE.Vector2(
      (vertices[index * 3] ?? 0) / image.width,
      -(vertices[index * 3 + 1] ?? 0) / image.height,
    );
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: drawn * BODY_DEPTH,
    bevelEnabled: false,
    UVGenerator: {
      generateTopUV: (_geometry, vertices, a, b, c) => [a, b, c].map((i) => uv(vertices, i)),
      generateSideWallUV: (_geometry, vertices, a, b, c, d) =>
        [a, b, c, d].map((i) => uv(vertices, i)),
    },
  });
  geometry.computeBoundingBox();
  const box = geometry.boundingBox ?? new THREE.Box3();
  const centre = box.getCenter(new THREE.Vector3());
  geometry.translate(-centre.x, -box.min.y, -centre.z);
  const scale = height / (box.max.y - box.min.y);
  return geometry.scale(scale, scale, scale);
}

/** A neutral rounded block, shown while a drawing loads or if it fails. */
export function fallbackBody(height: number): Body {
  const geometry = new RoundedBoxGeometry(
    height * FALLBACK_ASPECT,
    height,
    height * BODY_DEPTH,
    2,
    height * FALLBACK_RADIUS,
  ).translate(0, height / 2, 0);
  const material = new THREE.MeshStandardMaterial({
    color: FALLBACK_COLOR,
    roughness: ROUGHNESS,
    shadowSide: SHADOW_SIDE,
  });
  return {
    geometry,
    material,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

function bodyTexture(colours: Uint8Array, width: number, height: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(colours, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
