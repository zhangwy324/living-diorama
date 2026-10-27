import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { traceOutline, type Outline } from "./outline";
import type { Pixels } from "./pixels";
import { capColours, sideColours } from "./textures";

// A solid body extruded from a drawing (ADR 0011). The drawing faces +x, feet at y = 0.

/** Thickness, including the rounded edges, as a share of the body's height. */
export const BODY_DEPTH = 0.4;
/** The rounded edge, as a share of the body's height. It grows outward from the outline. */
const BEVEL = 0.04;
const BEVEL_SEGMENTS = 3;
const EMISSIVE_INTENSITY = 0.35;
const ROUGHNESS = 0.9;
const FALLBACK_COLOR = "#8f8a82";
const FALLBACK_ASPECT = 0.75;

export interface Body {
  geometry: THREE.BufferGeometry;
  /** Front and back, then sides and rounded edges: the extrusion's two groups. */
  material: THREE.Material | THREE.Material[];
  dispose(): void;
}

/** Builds a body `height` metres tall from a drawing, or nothing if it has no opaque shape. */
export function buildBody(pixels: Pixels, height: number): Body | undefined {
  const outline = traceOutline(pixels);
  if (!outline.shapes.length) return undefined;
  const geometry = bodyGeometry(outline, pixels, height);
  const textures = [capColours(pixels), sideColours(pixels)].map((colours) =>
    bodyTexture(colours, pixels.width, pixels.height),
  );
  const material = textures.map(
    (map) =>
      new THREE.MeshStandardMaterial({
        map,
        emissive: "#ffffff",
        emissiveMap: map,
        emissiveIntensity: EMISSIVE_INTENSITY,
        roughness: ROUGHNESS,
      }),
  );
  return {
    geometry,
    material,
    dispose() {
      geometry.dispose();
      for (const m of material) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}

/** The extruded shapes, scaled to `height`, centred on x and z, feet at y = 0. */
export function bodyGeometry(
  outline: Outline,
  image: { width: number; height: number },
  height: number,
): THREE.BufferGeometry {
  // Built in pixels with y up, then scaled. The texture's rows are top first, so v = -y / height.
  const drawn = outline.bounds.maxY - outline.bounds.minY;
  const bevel = drawn * BEVEL;
  const shapes = outline.shapes.map(
    (loop) => new THREE.Shape(loop.map(([x, y]) => new THREE.Vector2(x, -y))),
  );
  const uv = (vertices: number[], index: number) =>
    new THREE.Vector2(
      (vertices[index * 3] ?? 0) / image.width,
      -(vertices[index * 3 + 1] ?? 0) / image.height,
    );
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: drawn * BODY_DEPTH - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: 0,
    bevelSegments: BEVEL_SEGMENTS,
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
    height * BEVEL,
  ).translate(0, height / 2, 0);
  const material = new THREE.MeshStandardMaterial({ color: FALLBACK_COLOR, roughness: ROUGHNESS });
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
