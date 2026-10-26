import type { Vec3 } from "@living-diorama/content-schema";
import type { SceneData, SurfaceMesh } from "@living-diorama/simulation";
import * as THREE from "three";

// Static world geometry, built from the simulation's SceneData (ADR 0005 §9, ADR 0007 §3).

const SOIL_TOP = new THREE.Color("#5c4130");
const SOIL_BOTTOM = new THREE.Color("#3b2a1e");
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

/**
 * The diorama's base: soil walls under the terrain edge and a bottom (`soil`), plus the water's
 * cross-sections where the river meets an edge (`water`, if any).
 */
export function baseMeshes(
  scene: SceneData,
  waterMaterial: THREE.Material,
): { soil: THREE.Object3D; water?: THREE.Mesh } {
  const { columns, rows, cellSize, heights } = scene.terrain;
  const { min, max } = scene.bounds;
  const h = (i: number, j: number) => heights[j * columns + i] ?? 0;
  const soil = { positions: [] as number[], colors: [] as number[] };
  const waterSides: number[] = [];
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
        waterSides.push(
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

  if (waterSides.length === 0) return { soil: group };
  const waterGeometry = new THREE.BufferGeometry();
  waterGeometry.setAttribute("position", new THREE.Float32BufferAttribute(waterSides, 3));
  waterGeometry.computeVertexNormals();
  return { soil: group, water: new THREE.Mesh(waterGeometry, waterMaterial) };
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

/** Water region surfaces, all sharing the one water material. */
export function waterSurfaceMeshes(scene: SceneData, waterMaterial: THREE.Material): THREE.Mesh[] {
  return scene.surfaces
    .filter((s) => s.kind === "water")
    .map((s) => new THREE.Mesh(meshGeometry(s.mesh), waterMaterial));
}

const DECK_THICKNESS = 0.15;
const RAIL_HEIGHTS = [0.35, 0.65];
const POST_HEIGHT = 0.72;
const POST_SPACING = 1.2;

/**
 * Structure surfaces: each a slab drawn from its walkable surface mesh, so the visuals cannot drift
 * from it (roadmap risk R2), with posts and rails along its open edges.
 */
export function structureMeshes(scene: SceneData): THREE.Object3D {
  const group = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({
    color: WOOD,
    roughness: 0.8,
    side: THREE.DoubleSide,
  });
  const edges: [Vec3, Vec3][] = [];
  for (const surface of scene.surfaces) {
    if (surface.structureId === undefined) continue;
    const slab = new THREE.Mesh(slabGeometry(surface.mesh, DECK_THICKNESS), wood);
    slab.castShadow = true;
    slab.receiveShadow = true;
    group.add(slab);
    edges.push(...(surface.openEdges ?? []));
  }
  if (edges.length > 0) group.add(...railingMeshes(edges, wood));
  return group;
}

/** Posts at each open edge's ends and at most POST_SPACING apart, joined by rails. */
export function railingMeshes(
  edges: readonly [Vec3, Vec3][],
  material: THREE.Material,
): THREE.InstancedMesh[] {
  const v = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
  const posts = new Map<string, THREE.Vector3>();
  const addPost = (p: THREE.Vector3) =>
    posts.set(
      p
        .toArray()
        .map((c) => c.toFixed(3))
        .join(),
      p,
    );
  const rails: THREE.Matrix4[] = [];
  const unitX = new THREE.Vector3(1, 0, 0);
  for (const [a, b] of edges) {
    const from = v(a);
    const to = v(b);
    const span = to.clone().sub(from);
    const length = span.length();
    if (length === 0) continue;
    const count = Math.ceil(length / POST_SPACING);
    for (let k = 0; k <= count; k++) addPost(from.clone().lerp(to, k / count));
    const rotation = new THREE.Quaternion().setFromUnitVectors(unitX, span.clone().normalize());
    for (const height of RAIL_HEIGHTS) {
      const middle = from
        .clone()
        .lerp(to, 0.5)
        .add(new THREE.Vector3(0, height, 0));
      rails.push(new THREE.Matrix4().compose(middle, rotation, new THREE.Vector3(length, 1, 1)));
    }
  }
  const postMatrices = [...posts.values()].map((p) =>
    // From the slab's underside to POST_HEIGHT above the deck.
    new THREE.Matrix4().makeTranslation(p.x, p.y + (POST_HEIGHT - DECK_THICKNESS) / 2, p.z),
  );
  const instanced = (geometry: THREE.BufferGeometry, matrices: THREE.Matrix4[]) => {
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  };
  return [
    instanced(new THREE.BoxGeometry(0.09, POST_HEIGHT + DECK_THICKNESS, 0.09), postMatrices),
    // Slightly longer than the edge so rails meet where edges turn.
    instanced(new THREE.BoxGeometry(1.03, 0.05, 0.05), rails),
  ];
}
