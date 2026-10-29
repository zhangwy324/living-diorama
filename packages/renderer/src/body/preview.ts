import { BODY_THICKNESS, defaultAnchor, type Anchors } from "@living-diorama/content-schema";
import * as THREE from "three";
import { createSkyLight, createSunLight, SUN_DIRECTION } from "../lighting";
import {
  locomotionMotion,
  locomotionTransform,
  placePivots,
  restingLocomotion,
  type LocomotionBody,
} from "../locomotion";
import { followPixelRatio } from "../pixel-ratio";
import { FrameThrottle } from "../throttle";
import { buildBody, type Body } from "./body";
import type { Pixels } from "./pixels";

// The Creation Studio's live preview (ADR 0015 §7): one body, built like the diorama's and lit
// like it, turning slowly over a ground grid. Its WebGL context lives until `dispose`. It can play
// a way of moving in place, with the diorama's locomotion profiles (ADR 0020 §8, §12).

/** A way of moving for the preview to play in place (ADR 0020 §8, §9). */
export interface PreviewMotion {
  /** The animation profile, e.g. "walk", "hop" or "swim". An unknown one plays no motion. */
  profile: string;
  /**
   * How far the body sits below a water surface, as a share of its height. Above 0 the ground
   * grid gives way to a water surface.
   */
  submersion: number;
  /**
   * Metres per second to move at, in place. At `FULL_MOTION_SPEED` or more a profile plays in
   * full; 0 shows only what it does at rest (a swimmer's bob).
   */
  speed: number;
}

/** Masks the size of the drawing, 1 where a part should be highlighted (see `checkBody`). */
export interface BodyHighlights {
  /** Parts too thin to read as solid. */
  thin?: Uint8Array;
  /** Shapes not joined to the largest one. */
  loose?: Uint8Array;
}

export interface BodyPreview {
  /** Shows the body built from `pixels`, or nothing. Highlights tint parts of it. */
  setDrawing(pixels: Pixels | undefined, highlights?: BodyHighlights): void;
  /** The body's height in metres: its size class's. */
  setHeight(height: number): void;
  /** The body's depth as a share of its height. It changes at once, without a rebuild. */
  setThickness(thickness: number): void;
  /** While true nothing turns or renders, e.g. while a stroke is drawn, so drawing stays smooth. */
  setPaused(paused: boolean): void;
  /** Plays a way of moving in place, at its speed; undefined stands still. */
  setMotion(motion: PreviewMotion | undefined): void;
  /**
   * The body's anchors in drawing pixels, as pivots for its motion (ADR 0020 §10); one left out
   * sits where `defaultAnchor` puts it.
   */
  setAnchors(anchors: Anchors): void;
  dispose(): void;
}

const WATER_COLOUR = "#4f8fb0";
const WATER_OPACITY = 0.55;

/** Radians per second. */
const TURN_SPEED = 0.35;
const FOV = 30;
const PITCH = (12 * Math.PI) / 180;
/**
 * The view's height in metres for a body `h` tall: √h scaled so a large body fills about three
 * quarters of it and a tiny one a quarter. Bigger sizes look bigger, and every size stays visible.
 */
const sizedView = (h: number) => 1.66 * Math.sqrt(h);
/** Room around a body, as a share of its height and of its widest reach while it turns. */
const HEIGHT_MARGIN = 1.15;
const REACH_MARGIN = 2.2;
/** Ground grid: one line every quarter metre, so the size reads against it. */
const GRID_SIZE = 6;
const GRID_DIVISIONS = 24;
const THIN_COLOUR = [255, 150, 60] as const;
const LOOSE_COLOUR = [90, 170, 255] as const;
const HIGHLIGHT_OPACITY = 0.55;

/**
 * Starts a preview in a canvas of its own inside `container`, filling it. The canvas is removed
 * again on `dispose`, since a canvas whose context was lost can't get a new one.
 */
export function createBodyPreview(container: HTMLElement): BodyPreview {
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
  const turntable = new THREE.Group();
  scene.add(turntable);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 50);
  let height = 1;
  let thickness: number = BODY_THICKNESS.default;
  /** The body's extent from its axis at a height of 1, before the depth is scaled. */
  let extent = { x: 0.25, z: 0.5 };
  /** How far the body reaches from its axis while turning, at a height of 1. */
  const reach = () => Math.hypot(extent.x, extent.z * thickness);
  // Wide or tall drawings get more room, so a turning body never leaves the view.
  const frame = () => {
    const view = Math.max(
      sizedView(height),
      height * HEIGHT_MARGIN,
      (height * reach() * REACH_MARGIN) / Math.min(1, camera.aspect),
    );
    // `view` is what fits at the body's nearest point while it turns, which is closest.
    const distance = view / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) + height * reach();
    // Feet low in the view, but a body much smaller than the view not lost at its bottom.
    const target = new THREE.Vector3(0, Math.min(view * 0.42, height * 0.6), 0);
    camera.position
      .copy(target)
      .add(new THREE.Vector3(0, Math.sin(PITCH), Math.cos(PITCH)).multiplyScalar(distance));
    camera.lookAt(target);
  };
  frame();

  let body:
    { body: Body; mesh: THREE.Mesh; highlight?: Highlight; look: LocomotionBody } | undefined;
  const clearBody = () => {
    if (!body) return;
    turntable.clear();
    body.body.dispose();
    body.highlight?.dispose();
    body = undefined;
  };

  let anchors: Anchors = {};
  let motion: PreviewMotion | undefined;
  const cogOnBody = new THREE.Vector3();
  const tailOnBody = new THREE.Vector3();
  const placeAnchors = () => {
    if (!body) return;
    const { drawing } = body.body;
    drawing.toBody(
      anchors.centerOfGravity ?? defaultAnchor("centerOfGravity", drawing.bounds),
      cogOnBody,
    );
    drawing.toBody(anchors.tail ?? defaultAnchor("tail", drawing.bounds), tailOnBody);
    placePivots(body.look, cogOnBody, tailOnBody);
  };

  // The body is built 1 tall and the turntable scaled to its height, so the pose is worked out in
  // the body's own units; the gait's stride and the distance moved are in metres.
  const pose = restingLocomotion();
  const moveMatrix = new THREE.Matrix4();
  const depthMatrix = new THREE.Matrix4();
  let travelled = 0;
  let clock = 0;
  const placeBody = (dt: number) => {
    if (!body) return;
    const { mesh, look } = body;
    look.halfDepth = Math.max(0, extent.z * thickness);
    let lift = 0;
    if (motion) {
      travelled += motion.speed * dt;
      clock += dt;
      locomotionMotion(
        { profile: motion.profile, speed: motion.speed, travelled, time: clock, phase: 0, height },
        pose,
      );
      lift = locomotionTransform(pose, look, moveMatrix) - motion.submersion;
    } else {
      moveMatrix.identity();
    }
    mesh.matrix
      .makeTranslation(0, lift, 0)
      .multiply(moveMatrix)
      .multiply(depthMatrix.makeScale(1, 1, thickness));
    mesh.matrixWorldNeedsUpdate = true;
  };

  let paused = false;
  let dirty = true;
  let angle = 0;
  let last: number | undefined;
  const throttle = new FrameThrottle();
  let request = requestAnimationFrame(function loop(now) {
    request = requestAnimationFrame(loop);
    const elapsed = last === undefined ? 0 : Math.min((now - last) / 1000, 0.1);
    last = now;
    if (paused) return;
    angle += elapsed * TURN_SPEED;
    // A moving body is drawn at the display rate, so its steps stay smooth.
    if (!throttle.due(now, motion !== undefined) && !dirty) return;
    dirty = false;
    turntable.rotation.y = angle;
    placeBody(elapsed);
    renderer.render(scene, camera);
  });

  const resizer = new ResizeObserver(([entry]) => {
    const box = entry?.contentRect;
    if (!box || box.width === 0 || box.height === 0) return;
    renderer.setSize(box.width, box.height, false);
    camera.aspect = box.width / box.height;
    camera.updateProjectionMatrix();
    frame();
    dirty = true;
  });
  resizer.observe(canvas);
  // Sharp on every monitor the Studio is moved to (issue #55).
  const stopPixelRatio = followPixelRatio(window, (ratio) => {
    renderer.setPixelRatio(ratio);
    dirty = true;
  });

  return {
    setDrawing(pixels, highlights = {}) {
      clearBody();
      dirty = true;
      // Built as deep as it is tall and scaled to the thickness, so the slider needn't rebuild it.
      // Walls are straight and their normals and texture coordinates don't depend on depth, so
      // the scaled body is the one buildBody would make at that thickness.
      const built = pixels && buildBody(pixels, 1, 1);
      if (!pixels || !built) return;
      const mesh = new THREE.Mesh(built.geometry, built.material);
      // Placed by `placeBody`, which composes the depth, the motion and its lift.
      mesh.matrixAutoUpdate = false;
      turntable.add(mesh);
      const highlight = createHighlight(pixels, highlights);
      if (highlight) mesh.add(new THREE.Mesh(built.geometry, highlight.material));
      built.geometry.computeBoundingBox();
      const box = built.geometry.boundingBox ?? new THREE.Box3();
      extent = { x: Math.max(-box.min.x, box.max.x), z: Math.max(-box.min.z, box.max.z) };
      frame();
      const look: LocomotionBody = {
        height: 1,
        minX: box.min.x,
        maxX: box.max.x,
        halfDepth: extent.z * thickness,
        pivots: { centerOfGravity: new THREE.Vector3(), front: new THREE.Vector3() },
      };
      body = { body: built, mesh, look, ...(highlight ? { highlight } : {}) };
      placeAnchors();
      placeBody(0);
    },
    setHeight(next) {
      height = next;
      turntable.scale.setScalar(height);
      frame();
      dirty = true;
    },
    setThickness(next) {
      thickness = next;
      placeBody(0);
      frame();
      dirty = true;
    },
    setPaused(next) {
      paused = next;
      dirty = true;
    },
    setMotion(next) {
      motion = next && { ...next };
      water.visible = (next?.submersion ?? 0) > 0;
      grid.visible = !water.visible;
      placeBody(0);
      dirty = true;
    },
    setAnchors(next) {
      anchors = structuredClone(next);
      placeAnchors();
      placeBody(0);
      dirty = true;
    },
    dispose() {
      cancelAnimationFrame(request);
      resizer.disconnect();
      stopPixelRatio();
      clearBody();
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

interface Highlight {
  material: THREE.Material;
  dispose(): void;
}

/**
 * A see-through tint over the highlighted parts. It shares the body's geometry, whose texture
 * coordinates map the drawing onto the faces and the sides alike, so the tint follows the parts
 * all round.
 */
function createHighlight(pixels: Pixels, { thin, loose }: BodyHighlights): Highlight | undefined {
  const { width, height } = pixels;
  const rgba = new Uint8Array(width * height * 4);
  let any = false;
  for (let i = 0; i < width * height; i++) {
    const colour = thin?.[i] ? THIN_COLOUR : loose?.[i] ? LOOSE_COLOUR : undefined;
    if (!colour) continue;
    rgba.set([...colour, 255], i * 4);
    any = true;
  }
  if (!any) return undefined;
  const map = new THREE.DataTexture(rgba, width, height);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.LinearFilter;
  map.minFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  const material = new THREE.MeshBasicMaterial({
    map,
    transparent: true,
    opacity: HIGHLIGHT_OPACITY,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  return {
    material,
    dispose() {
      material.dispose();
      map.dispose();
    },
  };
}
