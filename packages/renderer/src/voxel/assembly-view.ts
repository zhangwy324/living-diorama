import type {
  Quaternion,
  SocketProbe,
  SocketRef,
  VoxelAssembly,
  VoxelPart,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PreviewMotion } from "../body/preview";
import { createSkyLight, createSunLight, SUN_DIRECTION } from "../lighting";
import {
  locomotionMotion,
  locomotionTransform,
  placePivots,
  restingLocomotion,
  type LocomotionBody,
} from "../locomotion";
import { followPixelRatio } from "../pixel-ratio";
import { canvasEncoder } from "../prop-thumbnails";
import {
  ghostPlacement,
  partGeometry,
  socketKey,
  socketPoints,
  type SocketPoint,
} from "./assembly-points";
import {
  buildVoxelBody,
  createVoxelMaterial,
  skinVoxelBody,
  type PartRoleResolver,
  type VoxelBody,
} from "./body";
import { VoxelThumbnails } from "./thumbnails";

// The Creation Studio's assembly view (ADR 0023 §4, §13): one voxel assembly on a ground grid,
// lit like the body preview, seen through an orbit camera. It marks the sockets the Studio asks
// for, tints the selected parts, shows a see-through part at sockets, picks parts and sockets
// under the pointer and can walk the creature in place. It only draws: edits are the Studio's.

/** What is under the pointer: a marked socket, or a part instance. */
export type AssemblyPick =
  { kind: "socket"; instance: string; socket: string } | { kind: "part"; instance: string };

/** A part shown see-through where it would be placed, before it is (ADR 0023 §4). */
export interface AssemblyGhost {
  part: VoxelPart;
  /**
   * The sockets to show it at, e.g. a socket and its mirror pair's while Mirror is on. On the
   * mirrored socket of a pair the part is shown mirrored.
   */
  sockets: readonly SocketRef[];
  /** Its rest rotation, stored as on an instance; none by default. */
  rotation?: Quaternion;
}

export interface AssemblyViewOptions {
  /** Part types' roles, for the tail pivot of the test walk. */
  roleOf?: PartRoleResolver;
}

export interface AssemblyView {
  /**
   * Shows `assembly`, which must be valid (`VoxelAssemblySchema`), or nothing. The body is
   * rebuilt only when the object changes, so an unchanged snapshot costs nothing. Markers,
   * selection and ghost are kept by ID and follow the new body; IDs it lacks show nothing. The
   * camera keeps its direction and turns to the new body's centre, moving out if it grew.
   */
  setAssembly(assembly: VoxelAssembly | undefined): void;
  /** Marks these sockets, e.g. the free sockets the selected tray part fits; only they are picked. */
  setHighlightedSockets(sockets: readonly SocketRef[]): void;
  /** Tints these part instances, e.g. the selected one and its mirror twin. */
  setSelection(instances: readonly string[]): void;
  /**
   * Shows a part see-through at sockets, or none. A part already on one of those sockets is
   * hidden, with everything hanging from it, while the ghost is there, as a replacement would take
   * it away. It meshes the part anew, so call it when the part, sockets or rotation change, not on
   * every pointer move.
   */
  setGhost(ghost: AssemblyGhost | undefined): void;
  /**
   * What is under a pointer at `clientX`, `clientY` (CSS pixels of the page, as a pointer event
   * has them): a marked socket first, since markers are drawn over the body, else the nearest
   * part, else undefined. Ghosts are never picked.
   */
  pick(clientX: number, clientY: number): AssemblyPick | undefined;
  /**
   * The ray under a pointer at `clientX`, `clientY` in the body frame (metres, feet at y = 0,
   * facing +X), with the test walk's motion taken out: from the camera, along a unit vector. It is
   * `scoreSockets`' probe, e.g. to score sockets while a part is dragged (ADR 0023 §4); undefined
   * while the canvas has no size.
   */
  probe(clientX: number, clientY: number): SocketProbe | undefined;
  /**
   * Walks the creature in place with a locomotion profile (M16, ADR 0020 §8), as the body
   * preview's `setMotion` does; undefined stands it still.
   */
  setTestWalk(motion: PreviewMotion | undefined): void;
  /**
   * Thumbnails drawn with this view's renderer, e.g. for the parts tray, so the Studio needs no
   * second WebGL context. Freed with the view.
   */
  readonly thumbnails: VoxelThumbnails;
  /** Frees everything; every call after it does nothing, and `pick` and `probe` find nothing. */
  dispose(): void;
}

const FOV = 30;
/** The camera's first direction: from the front-right of the creature (+X), a little above. */
const START_DIRECTION = new THREE.Vector3(1, 0.55, 1.1).normalize();
/** Room around the body when framed, as a share of its bounding radius. */
const FRAME_MARGIN = 1.25;
/** How close and far the camera may be, as multiples of the body's bounding radius. */
const MIN_DISTANCE = 1.2;
const MAX_DISTANCE = 12;
/** A body's bounding radius is taken as at least this, so a tiny one isn't framed in a speck. */
const MIN_RADIUS = 0.05;
/** The camera may go below the ground, to see a belly, but not right under it. */
const MAX_POLAR = 0.8 * Math.PI;
/** Ground grid: one line every quarter metre, so the size reads against it (as the preview). */
const GRID_SIZE = 6;
const GRID_DIVISIONS = 24;
const WATER_COLOUR = "#4f8fb0";
const WATER_OPACITY = 0.55;
/** A socket marker's radius, as a share of the camera's distance, so it keeps its size on screen. */
const MARKER_SCALE = 0.009;
/**
 * A marker's radius for picking, as a share of the camera's distance: larger than the dot drawn,
 * so a small dot is still easy to click.
 */
const MARKER_HIT_SCALE = 0.016;
const MARKER_COLOUR = "#2fc4ff";
const SELECTION_COLOUR = "#ffd84a";
const SELECTION_OPACITY = 0.45;
const GHOST_OPACITY = 0.5;

/**
 * A bone matrix that collapses its part to a point: so the selection tint leaves a part out, and
 * the body hides a part a ghost replaces.
 */
const COLLAPSED = new THREE.Matrix4().makeScale(0, 0, 0);

interface Built {
  assembly: VoxelAssembly;
  body: VoxelBody;
  mesh: THREE.SkinnedMesh;
  /** The selection tint: the body's geometry on a skeleton of its own. */
  tint: THREE.SkinnedMesh;
  sockets: Map<string, SocketPoint>;
  indexById: Map<string, number>;
  look: LocomotionBody;
  radius: number;
  /** Whether the bones changed since the body's bounds, which picking tests first, were taken. */
  boundsStale: boolean;
}

/**
 * Starts an assembly view in a canvas of its own inside `container`, filling it. Dragging orbits
 * the camera and the wheel zooms; the canvas is removed again on `dispose`.
 */
export function createAssemblyView(
  container: HTMLElement,
  options: AssemblyViewOptions = {},
): AssemblyView {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.appendChild(canvas);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#cfe3ea");
  const sun = createSunLight();
  sun.position.copy(SUN_DIRECTION).multiplyScalar(10);
  scene.add(createSkyLight(), sun);
  const grid = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, "#8fa58a", "#a9bca3");
  scene.add(grid);
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(GRID_SIZE / 2, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: WATER_COLOUR,
      transparent: true,
      opacity: WATER_OPACITY,
      depthWrite: false,
    }),
  );
  water.visible = false;
  scene.add(water);
  // The creature and everything on it, moved as one by the test walk.
  const rig = new THREE.Group();
  rig.matrixAutoUpdate = false;
  scene.add(rig);
  const markers = new THREE.Group();
  const ghosts = new THREE.Group();
  rig.add(markers, ghosts);

  const material = createVoxelMaterial();
  const tintMaterial = new THREE.MeshBasicMaterial({
    color: SELECTION_COLOUR,
    transparent: true,
    opacity: SELECTION_OPACITY,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const ghostMaterial = createVoxelMaterial();
  ghostMaterial.transparent = true;
  ghostMaterial.opacity = GHOST_OPACITY;
  ghostMaterial.depthWrite = false;
  const markerGeometry = new THREE.SphereGeometry(1, 16, 12);
  const markerMaterial = new THREE.MeshBasicMaterial({
    color: MARKER_COLOUR,
    // Always seen, so a socket on the far side or inside a crease can still be clicked.
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  });

  // The container's shape if it has one yet, so the first body is framed for it.
  const { clientWidth, clientHeight } = container;
  const aspect = clientWidth > 0 && clientHeight > 0 ? clientWidth / clientHeight : 1;
  const camera = new THREE.PerspectiveCamera(FOV, aspect, 0.005, 100);
  camera.position.copy(START_DIRECTION).multiplyScalar(2);
  const controls = new OrbitControls(camera, canvas);
  controls.enablePan = false;
  controls.maxPolarAngle = MAX_POLAR;
  const thumbnails = new VoxelThumbnails(renderer, canvasEncoder(container.ownerDocument));

  let built: Built | undefined;
  let highlighted: readonly SocketRef[] = [];
  let selection: readonly string[] = [];
  let ghost: AssemblyGhost | undefined;
  let motion: PreviewMotion | undefined;
  let dirty = true;
  let disposed = false;
  /** Whether the canvas has had its size, so a body framed before it is framed again. */
  let sized = false;

  /** How far away the camera must be to see a ball of `radius` whole. */
  const fitDistance = (radius: number) => {
    const half = THREE.MathUtils.degToRad(FOV / 2);
    const horizontal = Math.atan(Math.tan(half) * camera.aspect);
    return (radius * FRAME_MARGIN) / Math.sin(Math.min(half, horizontal));
  };

  const frame = (next: Built, previous: Built | undefined) => {
    const { bounds } = next.body.measure;
    const centre = new THREE.Vector3(
      (bounds.min.x + bounds.max.x) / 2,
      (bounds.min.y + bounds.max.y) / 2,
      (bounds.min.z + bounds.max.z) / 2,
    );
    const offset = camera.position.clone().sub(controls.target);
    let distance = offset.length();
    if (!previous) distance = fitDistance(next.radius);
    else if (next.radius > previous.radius) distance = Math.max(distance, fitDistance(next.radius));
    controls.minDistance = next.radius * MIN_DISTANCE;
    controls.maxDistance = Math.max(next.radius * MAX_DISTANCE, distance);
    controls.target.copy(centre);
    camera.position.copy(centre).add(offset.setLength(distance));
    controls.update();
  };

  const clearGhosts = () => {
    for (const mesh of ghosts.children as THREE.Mesh[]) mesh.geometry.dispose();
    ghosts.clear();
  };

  const showMarkers = () => {
    markers.clear();
    if (!built) return;
    for (const ref of highlighted) {
      const point = built.sockets.get(socketKey(ref));
      if (!point) continue;
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.copy(point.position);
      marker.renderOrder = 2;
      marker.userData = { instance: point.instance, socket: point.socket } satisfies SocketRef;
      markers.add(marker);
    }
    scaleMarkers();
  };

  const scaleMarkers = (share = MARKER_SCALE) => {
    const scale = camera.position.distanceTo(controls.target) * share;
    for (const marker of markers.children) marker.scale.setScalar(scale);
  };

  /** Sets the body's and the tint's bones: hidden parts collapsed, the tint on selected ones. */
  const showBones = () => {
    if (!built) return;
    const { mesh, tint, body, indexById } = built;
    const hidden = hiddenParts(built, ghost);
    const chosen = new Set(selection.map((id) => indexById.get(id)));
    let tinted = false;
    body.bones.forEach((rest, i) => {
      const shown = !hidden.has(i);
      mesh.skeleton.bones[i]?.matrixWorld.copy(shown ? rest : COLLAPSED);
      const lit = shown && chosen.has(i);
      tinted ||= lit;
      tint.skeleton.bones[i]?.matrixWorld.copy(lit ? rest : COLLAPSED);
    });
    tint.visible = tinted;
    // Picking reads the bone matrices, and the bounds it keeps from them; rendering updates the
    // matrices itself.
    mesh.skeleton.update();
    built.boundsStale = true;
  };

  const showGhost = () => {
    clearGhosts();
    if (!built || !ghost) return;
    const geometries = new Map<boolean, THREE.BufferGeometry>();
    for (const at of ghost.sockets) {
      const placed = ghostPlacement(built.assembly, built.body, ghost.part, at, ghost.rotation);
      if (!placed) continue;
      const { mirrored } = placed.placement;
      let geometry = geometries.get(mirrored);
      // Each ghost mesh owns its geometry, so clearing frees each once.
      if (!geometry) geometries.set(mirrored, (geometry = partGeometry(ghost.part, mirrored)));
      else geometry = geometry.clone();
      const mesh = new THREE.Mesh(geometry, ghostMaterial);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(placed.matrix);
      mesh.renderOrder = 1;
      ghosts.add(mesh);
    }
  };

  const disposeBuilt = (old: Built) => {
    rig.remove(old.mesh, old.tint);
    old.mesh.skeleton.dispose();
    old.tint.skeleton.dispose();
    old.body.dispose();
  };

  // The test walk, as the body preview plays it (ADR 0020 §8–§10): the whole body about its
  // pivots, lowered by its submersion.
  const pose = restingLocomotion();
  const moveMatrix = new THREE.Matrix4();
  let travelled = 0;
  let clock = 0;
  const placeRig = (dt: number) => {
    if (!built || !motion) {
      rig.matrix.identity();
    } else {
      const { look } = built;
      travelled += motion.speed * dt;
      clock += dt;
      locomotionMotion(
        {
          profile: motion.profile,
          speed: motion.speed,
          travelled,
          time: clock,
          phase: 0,
          height: look.height,
        },
        pose,
      );
      const lift = locomotionTransform(pose, look, moveMatrix) - motion.submersion * look.height;
      rig.matrix.makeTranslation(0, lift, 0).multiply(moveMatrix);
    }
    rig.matrixWorldNeedsUpdate = true;
  };

  let last: number | undefined;
  let request = requestAnimationFrame(function loop(now) {
    request = requestAnimationFrame(loop);
    const elapsed = last === undefined ? 0 : Math.min((now - last) / 1000, 0.1);
    last = now;
    if (!dirty && !motion) return;
    dirty = false;
    placeRig(elapsed);
    scaleMarkers();
    renderer.render(scene, camera);
  });
  const onChange = () => {
    scaleMarkers();
    dirty = true;
  };
  controls.addEventListener("change", onChange);

  const resizer = new ResizeObserver(([entry]) => {
    const box = entry?.contentRect;
    if (!box || box.width === 0 || box.height === 0) return;
    renderer.setSize(box.width, box.height, false);
    camera.aspect = box.width / box.height;
    camera.updateProjectionMatrix();
    if (!sized && built) frame(built, undefined);
    sized = true;
    dirty = true;
  });
  resizer.observe(canvas);
  const stopPixelRatio = followPixelRatio(window, (ratio) => {
    renderer.setPixelRatio(ratio);
    dirty = true;
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  /** Aims `raycaster` through a pointer; false while the canvas has no size. */
  const aim = (clientX: number, clientY: number): boolean => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    return true;
  };
  const toBody = new THREE.Matrix4();
  const bodyRay = new THREE.Ray();

  return {
    thumbnails,
    setAssembly(assembly) {
      if (disposed || assembly === built?.assembly) return;
      const previous = built;
      if (!assembly) {
        if (previous) disposeBuilt(previous);
        built = undefined;
      } else {
        built = build(assembly, material, tintMaterial, options.roleOf);
        if (previous) disposeBuilt(previous);
        rig.add(built.mesh, built.tint);
        frame(built, previous);
      }
      showMarkers();
      showGhost();
      showBones();
      dirty = true;
    },
    setHighlightedSockets(sockets) {
      if (disposed) return;
      highlighted = sockets.map(({ instance, socket }) => ({ instance, socket }));
      showMarkers();
      dirty = true;
    },
    setSelection(instances) {
      if (disposed) return;
      selection = [...instances];
      showBones();
      dirty = true;
    },
    setGhost(next) {
      if (disposed) return;
      ghost = next && { ...next, sockets: [...next.sockets] };
      showGhost();
      showBones();
      dirty = true;
    },
    pick(clientX, clientY) {
      if (disposed || !built || !aim(clientX, clientY)) return undefined;
      if (built.boundsStale) {
        built.mesh.computeBoundingSphere();
        built.boundsStale = false;
      }
      // Picked at their hit size, then drawn at their own again.
      scaleMarkers(MARKER_HIT_SCALE);
      scene.updateMatrixWorld();
      const hit = pickAssembly(raycaster, built.mesh, built.assembly, markers);
      scaleMarkers();
      return hit;
    },
    probe(clientX, clientY) {
      if (disposed || !aim(clientX, clientY)) return undefined;
      // The rig is the scene's child, so its matrix is the body frame in the world.
      toBody.copy(rig.matrix).invert();
      const { origin, direction } = bodyRay.copy(raycaster.ray).applyMatrix4(toBody);
      return {
        origin: { x: origin.x, y: origin.y, z: origin.z },
        direction: { x: direction.x, y: direction.y, z: direction.z },
      };
    },
    setTestWalk(next) {
      if (disposed) return;
      motion = next && { ...next };
      travelled = 0;
      clock = 0;
      water.visible = (next?.submersion ?? 0) > 0;
      grid.visible = !water.visible;
      placeRig(0);
      dirty = true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(request);
      controls.removeEventListener("change", onChange);
      controls.dispose();
      resizer.disconnect();
      stopPixelRatio();
      thumbnails.dispose();
      clearGhosts();
      markers.clear();
      if (built) disposeBuilt(built);
      built = undefined;
      for (const each of [material, tintMaterial, ghostMaterial, markerMaterial]) each.dispose();
      markerGeometry.dispose();
      grid.dispose();
      water.geometry.dispose();
      water.material.dispose();
      renderer.dispose();
      // Frees the context now rather than whenever the canvas is collected.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

/** Builds the body of `assembly` with its selection tint, socket points and walk measurements. */
function build(
  assembly: VoxelAssembly,
  material: THREE.Material,
  tintMaterial: THREE.Material,
  roleOf: PartRoleResolver | undefined,
): Built {
  const body = buildVoxelBody(assembly, roleOf);
  const mesh = skinVoxelBody(body, material);
  const tint = skinVoxelBody(body, tintMaterial);
  tint.castShadow = false;
  tint.renderOrder = 1;
  tint.visible = false;
  const sockets = new Map(socketPoints(assembly, body).map((p) => [socketKey(p), p]));
  const { bounds, height, centerOfGravity, tail } = body.measure;
  const look: LocomotionBody = {
    height,
    minX: bounds.min.x,
    maxX: bounds.max.x,
    halfDepth: Math.max(0, bounds.max.z, -bounds.min.z),
    pivots: { centerOfGravity: new THREE.Vector3(), front: new THREE.Vector3() },
  };
  placePivots(
    look,
    new THREE.Vector3(centerOfGravity.x, centerOfGravity.y, centerOfGravity.z),
    new THREE.Vector3(tail.x, tail.y, tail.z),
  );
  const size = new THREE.Vector3(
    bounds.max.x - bounds.min.x,
    bounds.max.y - bounds.min.y,
    bounds.max.z - bounds.min.z,
  );
  return {
    assembly,
    body,
    mesh,
    tint,
    sockets,
    indexById: new Map(assembly.instances.map((instance, i) => [instance.id, i])),
    look,
    radius: Math.max(MIN_RADIUS, size.length() / 2),
    boundsStale: true,
  };
}

/**
 * What `raycaster` hits first: one of `markers` (meshes whose `userData` is their `SocketRef`),
 * whichever is nearest, else the part of `mesh` (a skinned voxel body of `assembly`, its skeleton
 * updated and world matrices current) whose face is nearest. A face's part is its vertices' skin
 * index, the instance's index in the assembly.
 */
export function pickAssembly(
  raycaster: THREE.Raycaster,
  mesh: THREE.SkinnedMesh,
  assembly: VoxelAssembly,
  markers: THREE.Object3D,
): AssemblyPick | undefined {
  const [marker] = raycaster.intersectObjects(markers.children, false);
  if (marker) {
    const { instance, socket } = marker.object.userData as SocketRef;
    return { kind: "socket", instance, socket };
  }
  const [hit] = raycaster.intersectObject(mesh, false);
  if (!hit?.face) return undefined;
  const index = mesh.geometry.getAttribute("skinIndex").getX(hit.face.a);
  const instance = assembly.instances[index];
  return instance && { kind: "part", instance: instance.id };
}

/**
 * The parts a ghost takes the place of, by index: those on the sockets it is shown at, and
 * everything hanging from them.
 */
export function hiddenParts(
  built: Pick<Built, "assembly" | "body">,
  ghost: Pick<AssemblyGhost, "sockets"> | undefined,
): Set<number> {
  const hidden = new Set<number>();
  if (!ghost) return hidden;
  const { assembly, body } = built;
  assembly.instances.forEach(({ parent }, i) => {
    const under = body.parents[i] ?? -1;
    // Parents come before their children, so a parent's state is known here.
    const replaced =
      parent !== undefined &&
      ghost.sockets.some((s) => s.instance === parent.instance && s.socket === parent.socket);
    if (replaced || hidden.has(under)) hidden.add(i);
  });
  return hidden;
}
