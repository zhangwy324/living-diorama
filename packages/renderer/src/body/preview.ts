import * as THREE from "three";
import { createSkyLight, createSunLight, SUN_DIRECTION } from "../lighting";
import { followPixelRatio } from "../pixel-ratio";
import { FrameThrottle } from "../throttle";
import { buildBody, type Body } from "./body";
import type { Pixels } from "./pixels";

// The Creation Studio's live preview (ADR 0015 §7): one body, built like the diorama's and lit
// like it, turning slowly over a ground grid. Its WebGL context lives until `dispose`.

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
  /** While true nothing turns or renders, e.g. while a stroke is drawn, so drawing stays smooth. */
  setPaused(paused: boolean): void;
  dispose(): void;
}

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
  const turntable = new THREE.Group();
  scene.add(turntable);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 50);
  let height = 1;
  /** How far the body reaches from its axis while turning, at a height of 1. */
  let reach = 0.5;
  // Wide or tall drawings get more room, so a turning body never leaves the view.
  const frame = () => {
    const view = Math.max(
      sizedView(height),
      height * HEIGHT_MARGIN,
      (height * reach * REACH_MARGIN) / Math.min(1, camera.aspect),
    );
    // `view` is what fits at the body's nearest point while it turns, which is closest.
    const distance = view / 2 / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) + height * reach;
    // Feet low in the view, but a body much smaller than the view not lost at its bottom.
    const target = new THREE.Vector3(0, Math.min(view * 0.42, height * 0.6), 0);
    camera.position
      .copy(target)
      .add(new THREE.Vector3(0, Math.sin(PITCH), Math.cos(PITCH)).multiplyScalar(distance));
    camera.lookAt(target);
  };
  frame();

  let body: { body: Body; highlight?: Highlight } | undefined;
  const clearBody = () => {
    if (!body) return;
    turntable.clear();
    body.body.dispose();
    body.highlight?.dispose();
    body = undefined;
  };

  let paused = false;
  let dirty = true;
  let angle = 0;
  let last: number | undefined;
  const throttle = new FrameThrottle();
  let request = requestAnimationFrame(function loop(now) {
    request = requestAnimationFrame(loop);
    const elapsed = last === undefined ? 0 : (now - last) / 1000;
    last = now;
    if (paused) return;
    angle += Math.min(elapsed, 0.1) * TURN_SPEED;
    if (!throttle.due(now, false) && !dirty) return;
    dirty = false;
    turntable.rotation.y = angle;
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
      const built = pixels && buildBody(pixels, 1);
      if (!pixels || !built) return;
      const mesh = new THREE.Mesh(built.geometry, built.material);
      turntable.add(mesh);
      const highlight = createHighlight(pixels, highlights);
      if (highlight) mesh.add(new THREE.Mesh(built.geometry, highlight.material));
      built.geometry.computeBoundingBox();
      const box = built.geometry.boundingBox ?? new THREE.Box3();
      reach = Math.hypot(Math.max(-box.min.x, box.max.x), Math.max(-box.min.z, box.max.z));
      frame();
      body = highlight ? { body: built, highlight } : { body: built };
    },
    setHeight(next) {
      height = next;
      turntable.scale.setScalar(height);
      frame();
      dirty = true;
    },
    setPaused(next) {
      paused = next;
      dirty = true;
    },
    dispose() {
      cancelAnimationFrame(request);
      resizer.disconnect();
      stopPixelRatio();
      clearBody();
      grid.dispose();
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
