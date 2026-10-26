import type { Vec3 } from "@living-diorama/content-schema";
import type {
  NavigationOverlay,
  RouteLegSnapshot,
  SceneData,
  SimulationSnapshot,
} from "@living-diorama/simulation";
import * as THREE from "three";
import type { CreaturePose } from "./interpolation";
import { meshGeometry } from "./world-meshes";

// Debug overlays (ADR 0007 §10, roadmap M4 task 10): walkability, the region graph and portals,
// creature routes and the deck surfaces. All hidden until turned on.

/** Overlays float this far above the surface they mark, in metres. */
const LIFT = 0.04;
const WALKABLE = new THREE.Color("#3fd46b");
const BLOCKED = new THREE.Color("#e2483d");
const USABLE_PORTAL = "#38c9f2";
const UNUSABLE_PORTAL = "#ff3b8d";
const GRAPH = "#ffd84a";
const ROUTE = "#ff8a1f";
const DECK = "#ffffff";

/** Drawn over everything else, so lines stay visible behind hills. */
function onTop<T extends THREE.Material>(material: T): T {
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  return material;
}

const lifted = (p: Vec3) => new THREE.Vector3(p.x, p.y + LIFT, p.z);

/** Two triangles per cell, green where walkable and red where not. */
export function walkabilityMesh(navigation: NavigationOverlay): THREE.Mesh {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const region of navigation.regions) {
    for (const cell of region.cells) {
      const color = cell.walkable ? WALKABLE : BLOCKED;
      const [a, b, c, d] = cell.corners;
      for (const p of [a, c, b, a, d, c]) {
        positions.push(p.x, p.y + LIFT, p.z);
        colors.push(color.r, color.g, color.b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.35,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "walkability";
  return mesh;
}

/**
 * Portals as segments, cyan when usable and pink when not; graph nodes at region anchors, joined
 * through the middle of each usable portal.
 */
export function regionGraph(navigation: NavigationOverlay): THREE.Group {
  const group = new THREE.Group();
  group.name = "region-graph";
  const anchors = new Map(navigation.regions.map((r) => [r.regionId, lifted(r.anchor)]));
  const segments = (points: THREE.Vector3[], color: string) =>
    new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(points),
      onTop(new THREE.LineBasicMaterial({ color })),
    );

  const usable: THREE.Vector3[] = [];
  const unusable: THREE.Vector3[] = [];
  const edges: THREE.Vector3[] = [];
  for (const portal of navigation.portals) {
    const a = lifted(portal.a);
    const b = lifted(portal.b);
    (portal.usable ? usable : unusable).push(a, b);
    const from = anchors.get(portal.from);
    const to = anchors.get(portal.to);
    if (!portal.usable || !from || !to) continue;
    const middle = a.clone().lerp(b, 0.5);
    edges.push(from, middle, middle, to);
  }
  group.add(
    segments(edges, GRAPH),
    segments(usable, USABLE_PORTAL),
    segments(unusable, UNUSABLE_PORTAL),
  );

  const node = new THREE.SphereGeometry(0.25, 12, 8);
  const nodeMaterial = onTop(new THREE.MeshBasicMaterial({ color: GRAPH }));
  for (const anchor of anchors.values()) {
    const mesh = new THREE.Mesh(node, nodeMaterial);
    mesh.position.copy(anchor);
    group.add(mesh);
  }
  group.traverse((object) => (object.renderOrder = 10));
  return group;
}

/** Structure surfaces as wireframes, to check the visual geometry against the surface data. */
export function deckSurfaces(scene: SceneData): THREE.Group {
  const group = new THREE.Group();
  group.name = "deck-surfaces";
  const material = onTop(new THREE.MeshBasicMaterial({ color: DECK, wireframe: true }));
  for (const surface of scene.surfaces) {
    if (surface.structureId === undefined) continue;
    const mesh = new THREE.Mesh(meshGeometry(surface.mesh), material);
    mesh.position.y = LIFT / 2;
    mesh.renderOrder = 10;
    group.add(mesh);
  }
  return group;
}

/** One line per walking creature, from where it is drawn through its remaining waypoints. */
export class RouteLines {
  readonly group = new THREE.Group();
  readonly #material = onTop(new THREE.LineBasicMaterial({ color: ROUTE }));
  readonly #lines = new Map<string, THREE.Line>();
  #routes = new Map<string, RouteLegSnapshot[]>();

  constructor() {
    this.group.name = "routes";
  }

  /** Keeps the routes of the newest snapshot. */
  setRoutes(snapshot: SimulationSnapshot): void {
    this.#routes = new Map(snapshot.creatures.flatMap((c) => (c.route ? [[c.id, c.route]] : [])));
  }

  update(poses: readonly CreaturePose[]): void {
    const seen = new Set<string>();
    for (const pose of poses) {
      const points = this.#routes.get(pose.id)?.flatMap((leg) => leg.points) ?? [];
      if (points.length === 0) continue;
      seen.add(pose.id);
      let line = this.#lines.get(pose.id);
      if (!line) {
        line = new THREE.Line(new THREE.BufferGeometry(), this.#material);
        line.renderOrder = 11;
        line.frustumCulled = false;
        this.#lines.set(pose.id, line);
        this.group.add(line);
      }
      // The point count changes as waypoints are reached, so the geometry is rebuilt.
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints([
        lifted(pose.world),
        ...points.map(lifted),
      ]);
    }
    for (const [id, line] of this.#lines) {
      if (seen.has(id)) continue;
      line.geometry.dispose();
      line.removeFromParent();
      this.#lines.delete(id);
    }
  }

  get count(): number {
    return this.#lines.size;
  }
}

export interface DebugOverlays {
  group: THREE.Group;
  routes: RouteLines;
}

/** Every overlay in one hidden group. Without navigation data only routes and decks are drawn. */
export function createDebugOverlays(
  scene: SceneData,
  navigation: NavigationOverlay | undefined,
): DebugOverlays {
  const group = new THREE.Group();
  group.name = "debug-overlays";
  group.visible = false;
  const routes = new RouteLines();
  if (navigation) group.add(walkabilityMesh(navigation), regionGraph(navigation));
  group.add(deckSurfaces(scene), routes.group);
  return { group, routes };
}
