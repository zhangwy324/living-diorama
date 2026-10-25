import type { PropPlacement } from "@living-diorama/content-schema";
import type { SceneData, SurfaceMesh } from "@living-diorama/simulation";
import * as THREE from "three";

// Static world geometry. A first pass pulled forward from roadmap M4 so the M2 layout can be
// judged in 3D; materials and props are placeholders.

const SOIL_TOP = new THREE.Color("#5c4130");
const SOIL_BOTTOM = new THREE.Color("#3b2a1e");
const WATER = "#4f8fc9";
const WOOD = "#9a6b3f";

/** Terrain triangles use the same fixed diagonal as the simulation (world-coordinates.md). */
export function terrainMesh(scene: SceneData): THREE.Mesh {
  const { columns, rows, cellSize, heights, colors } = scene.terrain;
  const { min } = scene.bounds;
  const positions = new Float32Array(columns * rows * 3);
  const vertexColors = new Float32Array(columns * rows * 3);
  const color = new THREE.Color();
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const k = j * columns + i;
      positions.set([min.x + i * cellSize, heights[k] ?? 0, min.z + j * cellSize], k * 3);
      color.set(colors[k] ?? "#ff00ff");
      vertexColors.set([color.r, color.g, color.b], k * 3);
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < columns - 1; i++) {
      const v00 = j * columns + i;
      const v10 = v00 + 1;
      const v01 = v00 + columns;
      const v11 = v01 + 1;
      // Split along v00–v11; both triangles wound so their normals point up.
      indices.push(v00, v11, v10, v00, v01, v11);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(vertexColors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, flatShading: true }),
  );
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return mesh;
}

/** The diorama's sides and bottom: soil walls under the terrain edge, and water cross-sections. */
export function baseMeshes(scene: SceneData): THREE.Object3D {
  const { columns, rows, cellSize, heights } = scene.terrain;
  const { min, max } = scene.bounds;
  const h = (i: number, j: number) => heights[j * columns + i] ?? 0;
  const soil = { positions: [] as number[], colors: [] as number[] };
  const water: number[] = [];
  const span = Math.max(1e-6, max.y - min.y);

  // Each side as (x, z, groundY, waterY) samples, ordered so quads face outward.
  const sides: { x: number; z: number; y: number; w: number }[][] = [
    Array.from({ length: columns }, (_, i) => ({
      x: min.x + i * cellSize,
      z: max.z,
      y: h(i, rows - 1),
      w: scene.edgeWater.south[i] ?? NaN,
    })),
    Array.from({ length: rows }, (_, j) => ({
      x: max.x,
      z: max.z - j * cellSize,
      y: h(columns - 1, rows - 1 - j),
      w: scene.edgeWater.east[rows - 1 - j] ?? NaN,
    })),
    Array.from({ length: columns }, (_, i) => ({
      x: max.x - i * cellSize,
      z: min.z,
      y: h(columns - 1 - i, 0),
      w: scene.edgeWater.north[columns - 1 - i] ?? NaN,
    })),
    Array.from({ length: rows }, (_, j) => ({
      x: min.x,
      z: min.z + j * cellSize,
      y: h(0, j),
      w: scene.edgeWater.west[j] ?? NaN,
    })),
  ];
  const shade = (y: number) => SOIL_BOTTOM.clone().lerp(SOIL_TOP, (y - min.y) / span);
  for (const side of sides) {
    for (let k = 0; k < side.length - 1; k++) {
      const a = side[k];
      const b = side[k + 1];
      if (!a || !b) continue;
      const quad = [
        [a.x, a.y, a.z],
        [a.x, min.y, a.z],
        [b.x, min.y, b.z],
        [a.x, a.y, a.z],
        [b.x, min.y, b.z],
        [b.x, b.y, b.z],
      ];
      for (const p of quad) {
        soil.positions.push(...(p as [number, number, number]));
        const c = shade(p[1] ?? min.y);
        soil.colors.push(c.r, c.g, c.b);
      }
      if (Number.isFinite(a.w) || Number.isFinite(b.w)) {
        const aw = Number.isFinite(a.w) ? a.w : a.y;
        const bw = Number.isFinite(b.w) ? b.w : b.y;
        water.push(
          a.x,
          aw,
          a.z,
          a.x,
          a.y,
          a.z,
          b.x,
          b.y,
          b.z,
          a.x,
          aw,
          a.z,
          b.x,
          b.y,
          b.z,
          b.x,
          bw,
          b.z,
        );
      }
    }
  }
  const group = new THREE.Group();
  const soilGeometry = new THREE.BufferGeometry();
  soilGeometry.setAttribute("position", new THREE.Float32BufferAttribute(soil.positions, 3));
  soilGeometry.setAttribute("color", new THREE.Float32BufferAttribute(soil.colors, 3));
  soilGeometry.computeVertexNormals();
  group.add(
    new THREE.Mesh(
      soilGeometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }),
    ),
  );

  const bottom = new THREE.Mesh(
    new THREE.PlaneGeometry(max.x - min.x, max.z - min.z),
    new THREE.MeshStandardMaterial({ color: SOIL_BOTTOM, side: THREE.DoubleSide }),
  );
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.set((min.x + max.x) / 2, min.y, (min.z + max.z) / 2);
  group.add(bottom);

  if (water.length > 0) {
    const waterGeometry = new THREE.BufferGeometry();
    waterGeometry.setAttribute("position", new THREE.Float32BufferAttribute(water, 3));
    waterGeometry.computeVertexNormals();
    group.add(new THREE.Mesh(waterGeometry, waterMaterial()));
  }
  return group;
}

function waterMaterial() {
  return new THREE.MeshStandardMaterial({
    color: WATER,
    transparent: true,
    opacity: 0.78,
    roughness: 0.25,
    side: THREE.DoubleSide,
  });
}

function meshGeometry(mesh: SurfaceMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.positions, 3));
  geometry.setIndex(mesh.indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Gives a surface mesh some thickness: the surface, a copy below it, and walls along its rim. */
function slabGeometry(mesh: SurfaceMesh, thickness: number): THREE.BufferGeometry {
  const count = mesh.positions.length / 3;
  const positions = [...mesh.positions];
  for (let v = 0; v < count; v++) {
    positions.push(
      mesh.positions[v * 3] ?? 0,
      (mesh.positions[v * 3 + 1] ?? 0) - thickness,
      mesh.positions[v * 3 + 2] ?? 0,
    );
  }
  const indices = [...mesh.indices];
  const edgeUse = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const tri = mesh.indices.slice(t, t + 3);
    indices.push(...tri.map((i) => i + count).reverse());
    tri.forEach((a, n) => {
      const b = tri[(n + 1) % 3] ?? a;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    });
  }
  for (const [key, uses] of edgeUse) {
    if (uses !== 1) continue;
    const [a = 0, b = 0] = key.split(",").map(Number);
    indices.push(a, b, b + count, a, b + count, a + count);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Region surfaces the terrain doesn't show: water planes and structure decks. */
export function surfaceMeshes(scene: SceneData): THREE.Object3D {
  const group = new THREE.Group();
  for (const surface of scene.surfaces) {
    if (surface.kind === "water") {
      group.add(new THREE.Mesh(meshGeometry(surface.mesh), waterMaterial()));
      continue;
    }
    const slab = new THREE.Mesh(
      slabGeometry(surface.mesh, 0.15),
      new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.8, side: THREE.DoubleSide }),
    );
    slab.castShadow = true;
    slab.receiveShadow = true;
    group.add(slab);
  }
  return group;
}

/** Placeholder look for a prop model until real assets exist (M4). */
export interface PropPlaceholder {
  shape: "conifer" | "broadleaf" | "rock" | "bush" | "mushroom";
  color: string;
}

function placeholderShape({ shape, color }: PropPlaceholder): THREE.Object3D {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 });
  const trunk = new THREE.MeshStandardMaterial({ color: "#6e4b2e", flatShading: true });
  const add = (geometry: THREE.BufferGeometry, mat: THREE.Material, y: number, sy = 1) => {
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.y = y;
    mesh.scale.y = sy;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  };
  switch (shape) {
    case "conifer":
      add(new THREE.CylinderGeometry(0.1, 0.14, 0.8, 6), trunk, 0.4);
      add(new THREE.ConeGeometry(0.95, 1.7, 7), material, 1.35);
      add(new THREE.ConeGeometry(0.7, 1.4, 7), material, 2.2);
      break;
    case "broadleaf":
      add(new THREE.CylinderGeometry(0.13, 0.18, 1.2, 6), trunk, 0.6);
      add(new THREE.IcosahedronGeometry(1.15, 0), material, 2, 0.85);
      break;
    case "rock":
      add(new THREE.DodecahedronGeometry(0.55, 0), material, 0.2, 0.65);
      break;
    case "bush":
      add(new THREE.IcosahedronGeometry(0.55, 0), material, 0.3, 0.7);
      break;
    case "mushroom":
      add(
        new THREE.CylinderGeometry(0.04, 0.05, 0.18, 6),
        new THREE.MeshStandardMaterial({ color: "#efe6d2" }),
        0.09,
      );
      add(new THREE.SphereGeometry(0.13, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), material, 0.17);
      break;
  }
  return group;
}

export function propMeshes(
  props: readonly PropPlacement[],
  placeholders: Readonly<Record<string, PropPlaceholder>>,
): THREE.Object3D {
  const group = new THREE.Group();
  const templates = new Map<string, THREE.Object3D>();
  for (const prop of props) {
    let template = templates.get(prop.model);
    if (!template) {
      template = placeholderShape(placeholders[prop.model] ?? { shape: "rock", color: "#ff00ff" });
      templates.set(prop.model, template);
    }
    const instance = template.clone();
    const { position, rotationY, scale } = prop.transform;
    instance.position.set(position.x, position.y, position.z);
    instance.rotation.y = rotationY;
    instance.scale.setScalar(scale);
    group.add(instance);
  }
  return group;
}
