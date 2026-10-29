import { BODY_THICKNESS, DRAWING_SIZE, type DrawingBounds } from "@living-diorama/content-schema";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { traceOutline, type Outline, type Point } from "./outline";
import type { Pixels } from "./pixels";
import { bodyColours } from "./textures";

// A solid body extruded from a drawing (ADR 0011, ADR 0017). The drawing faces +x, feet at y = 0.

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
  /** How the drawing's pixels lie on the body, for its anchors (ADR 0020 §10). */
  drawing: DrawingFrame;
  dispose(): void;
}

/** Where the drawing lies on its body. */
export interface DrawingFrame {
  /** The drawn shape's bounds, in drawing pixels. */
  bounds: DrawingBounds;
  /**
   * Where a point on the drawing, in its pixels, lies on the body: in metres, the feet at the
   * origin, facing +X, on the middle plane between front and back. Writes into `out`.
   */
  toBody(point: { x: number; y: number }, out: THREE.Vector3): THREE.Vector3;
}

/**
 * Builds a body `height` metres tall from a drawing, `thickness` of its height deep, or nothing if
 * the drawing has no opaque shape.
 */
export function buildBody(
  pixels: Pixels,
  height: number,
  thickness: number = BODY_THICKNESS.default,
): Body | undefined {
  const outline = traceOutline(pixels);
  if (!outline.shapes.length) return undefined;
  const { geometry, drawing } = extrude(outline, pixels, height, thickness);
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
    drawing,
    dispose() {
      geometry.dispose();
      material.dispose();
      map.dispose();
    },
  };
}

/**
 * The extruded shapes with their holes, scaled to `height` and `thickness` of it deep, centred on
 * x and z, feet at y = 0. The walls run straight from the front face to the back, so the
 * silhouette is the drawing's.
 */
export function bodyGeometry(
  outline: Outline,
  image: { width: number; height: number },
  height: number,
  thickness: number = BODY_THICKNESS.default,
): THREE.BufferGeometry {
  return extrude(outline, image, height, thickness).geometry;
}

function extrude(
  outline: Outline,
  image: { width: number; height: number },
  height: number,
  thickness: number,
): { geometry: THREE.BufferGeometry; drawing: DrawingFrame } {
  // Built in pixels with y up, then scaled. The texture's rows are top first, so v = -y / height.
  const drawn = outline.bounds.maxY - outline.bounds.minY;
  const shapes = outline.shapes.map(({ outer, holes, traced }) => {
    // three's triangulation can, rarely, cover a hole of a simplified shape; the traced loops
    // follow pixel edges and triangulate as they should.
    const loops = triangulates(outer, holes) ? { outer, holes } : traced;
    const contour = vectors(loops.outer);
    // Counter-clockwise, so ExtrudeGeometry reverses it and puts every hole the other way round.
    if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
    const shape = new THREE.Shape(contour);
    shape.holes = loops.holes.map((loop) => new THREE.Path(vectors(loop)));
    return shape;
  });
  const uv = (vertices: number[], index: number) =>
    new THREE.Vector2(
      (vertices[index * 3] ?? 0) / image.width,
      -(vertices[index * 3 + 1] ?? 0) / image.height,
    );
  const geometry = new THREE.ExtrudeGeometry(shapes, {
    depth: drawn * thickness,
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
  // Kept, since moving the geometry updates its bounding box in place.
  const bottom = box.min.y;
  geometry.translate(-centre.x, -bottom, -centre.z);
  const scale = height / (box.max.y - box.min.y);
  geometry.scale(scale, scale, scale);
  const { minX, minY, maxX, maxY } = outline.bounds;
  const drawing: DrawingFrame = {
    bounds: { left: minX, top: minY, right: maxX, bottom: maxY },
    // As the geometry was moved and scaled; the drawing's y runs down, the body's up.
    toBody: (point, out) => out.set((point.x - centre.x) * scale, (-point.y - bottom) * scale, 0),
  };
  return { geometry, drawing };
}

/** A loop in the extrusion's plane: y up. */
const vectors = (loop: readonly Point[]) => loop.map(([x, y]) => new THREE.Vector2(x, -y));

/**
 * Whether three triangulates the shape exactly: its triangles add up to the shape's area, the
 * holes' taken from the outer loop's. Loops don't cross (`traceOutline`), so any other total
 * means a triangle covers a hole or misses part of the shape.
 */
export function triangulates(
  outer: readonly Point[],
  holes: readonly (readonly Point[])[],
): boolean {
  // Oriented as ExtrudeGeometry orients them: the outer loop clockwise, the holes not.
  const contour = vectors(outer);
  if (!THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
  const paths = holes.map((loop) => {
    const path = vectors(loop);
    return THREE.ShapeUtils.isClockWise(path) ? path.reverse() : path;
  });
  const area = (loop: THREE.Vector2[]) => Math.abs(THREE.ShapeUtils.area(loop));
  const expected = area(contour) - paths.reduce((sum, path) => sum + area(path), 0);
  // It drops a last point repeating the first, so the faces index the loops it was given.
  const given = [[...contour], ...paths.map((path) => [...path])];
  const faces = THREE.ShapeUtils.triangulateShape(given[0] ?? [], given.slice(1));
  const points = given.flat();
  const total = faces.reduce((sum, face) => {
    const corners = face.map((i) => points[i] ?? new THREE.Vector2());
    return sum + area(corners);
  }, 0);
  return Math.abs(total - expected) <= 1e-6 * Math.max(1, expected);
}

/** A neutral rounded block `thickness` of its height deep, shown while a drawing loads or fails. */
export function fallbackBody(height: number, thickness: number = BODY_THICKNESS.default): Body {
  const geometry = new RoundedBoxGeometry(
    height * FALLBACK_ASPECT,
    height,
    height * thickness,
    2,
    height * FALLBACK_RADIUS,
  ).translate(0, height / 2, 0);
  const material = new THREE.MeshStandardMaterial({
    color: FALLBACK_COLOR,
    roughness: ROUGHNESS,
    shadowSide: SHADOW_SIDE,
  });
  // The block stands in for a drawing filling its height: anchors land roughly where they will.
  const scale = height / DRAWING_SIZE;
  const width = DRAWING_SIZE * FALLBACK_ASPECT;
  const drawing: DrawingFrame = {
    bounds: { left: 0, top: 0, right: width, bottom: DRAWING_SIZE },
    toBody: (point, out) =>
      out.set((point.x - width / 2) * scale, (DRAWING_SIZE - point.y) * scale, 0),
  };
  return {
    geometry,
    material,
    drawing,
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
