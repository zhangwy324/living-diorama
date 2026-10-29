import type { SceneData } from "@living-diorama/simulation";
import * as THREE from "three";
import { terrainHeightAt } from "./camera";
import { SNAP_SECONDS } from "./cues";
import type { SceneLayer } from "./layers";

// Whether a creature's cues show (issue #93, ADR 0018 as built): the terrain and structures hide
// the cues of a creature they hide from the camera, and so does a clipping plane that cuts its
// creature away. Props, trees and other creatures never do: a bubble behind a tree still says
// something about a creature you can see. Checked on the CPU, a few times a second per creature.

/** Seconds between checks of one creature; creatures are staggered across it. */
export const CHECK_SECONDS = 0.2;
/** A changed result must hold for this many checks in a row before the cues follow it. */
export const HYSTERESIS_CHECKS = 2;
/** Seconds the cues take to fade fully out or back in. */
const FADE_SECONDS = 0.4;
/** Horizontal metres between terrain samples along a ray. */
const TERRAIN_STEP = 0.25;
/**
 * The terrain hides a point only where it rises this many metres above the ray, so a creature on
 * a slope isn't hidden by the ground at its own feet.
 */
export const SLOPE_TOLERANCE = 0.15;

/**
 * Raycast layer of the meshes that hide cues: the decks of structures, not their thin railings.
 * Those meshes also stay on layer 0, so they are drawn and cast shadows as before.
 */
export const CUE_OCCLUDER_LAYER = 1;

/** The layers that hide cues or clip creatures. */
export interface VisibilityLayers {
  terrain: SceneLayer;
  structures: SceneLayer;
  creatures: SceneLayer;
}

/** One creature's visibility over time. */
export interface VisibilityState {
  /** Whether its cues are hidden, after hysteresis. */
  hidden: boolean;
  /** Checks in a row that disagreed with `hidden`. */
  streak: number;
  /** How far its cues show, 0–1, faded towards `hidden`. Multiplies every cue's opacity. */
  weight: number;
  /** Real time of its next check; undefined before the first. */
  due: number | undefined;
  /** 0–1, staggers its checks against other creatures'. */
  phase: number;
}

export const visibleState = (phase: number): VisibilityState => ({
  hidden: false,
  streak: 0,
  weight: 1,
  due: undefined,
  phase,
});

export class CueVisibility {
  readonly #scene: SceneData;
  readonly #layers: VisibilityLayers;
  readonly #maxHeight: number;
  readonly #raycaster = new THREE.Raycaster();
  readonly #hits: THREE.Intersection[] = [];
  readonly #direction = new THREE.Vector3();
  readonly #point = new THREE.Vector3();
  #structureBox: THREE.Box3 | undefined;

  constructor(scene: SceneData, layers: VisibilityLayers) {
    this.#scene = scene;
    this.#layers = layers;
    this.#maxHeight = scene.terrain.heights.reduce((max, h) => Math.max(max, h), -Infinity);
    this.#raycaster.layers.set(CUE_OCCLUDER_LAYER);
  }

  /**
   * Steps `state` to `realTime`, `dt` seconds after the last step, for a creature whose sample
   * points are `points` (its head's top first) seen from `camera`. Checks only when due; the first
   * check sets the state at once. Mutates and returns `state`.
   */
  update(
    state: VisibilityState,
    points: readonly THREE.Vector3[],
    camera: THREE.Vector3,
    realTime: number,
    dt: number,
  ): VisibilityState {
    if (state.due === undefined) {
      state.hidden = this.hidden(points, camera);
      state.weight = state.hidden ? 0 : 1;
      state.streak = 0;
      state.due = realTime + CHECK_SECONDS * (0.5 + state.phase);
      return state;
    }
    if (realTime >= state.due) {
      state.due += CHECK_SECONDS;
      if (state.due <= realTime) state.due = realTime + CHECK_SECONDS * (0.5 + state.phase);
      const hidden = this.hidden(points, camera);
      if (hidden === state.hidden) state.streak = 0;
      else if (++state.streak >= HYSTERESIS_CHECKS) {
        state.hidden = hidden;
        state.streak = 0;
      }
    }
    const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const target = state.hidden ? 0 : 1;
    const delta = step > SNAP_SECONDS ? 1 : step / FADE_SECONDS;
    state.weight =
      target > state.weight
        ? Math.min(target, state.weight + delta)
        : Math.max(target, state.weight - delta);
    return state;
  }

  /**
   * Whether a creature's cues should hide: its head's top (`points[0]`) is clipped away on the
   * creatures layer, or every point is hidden from `camera` by the terrain or a structure. A
   * creature partly in view shows its cues in full.
   */
  hidden(points: readonly THREE.Vector3[], camera: THREE.Vector3): boolean {
    const [top] = points;
    if (!top) return false;
    if (this.#layers.creatures.isClipped(top)) return true;
    for (const point of points) {
      if (!this.#terrainHides(point, camera) && !this.#structureHides(point, camera)) return false;
    }
    return true;
  }

  /** Steps along the ray from `from` to `to` against the heightfield. */
  #terrainHides(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const horizontal = Math.hypot(dx, dz);
    if (horizontal < 1e-6) return false;
    const { min, max } = this.#scene.bounds;
    const steps = Math.ceil(horizontal / TERRAIN_STEP);
    const terrain = this.#layers.terrain;
    const point = this.#point;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const z = from.z + dz * t;
      if (x < min.x || x > max.x || z < min.z || z > max.z) return false;
      // Above the highest ground and rising: nothing further on can hide it.
      if (y > this.#maxHeight && dy >= 0) return false;
      const ground = terrainHeightAt(this.#scene, x, z);
      // Ground that a cutaway clips doesn't hide anything.
      if (ground > y + SLOPE_TOLERANCE && !terrain.isClipped(point.set(x, ground, z))) {
        return true;
      }
    }
    return false;
  }

  /** Casts the ray from `from` to `to` against the decks of structures. */
  #structureHides(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const group = this.#layers.structures.group;
    this.#structureBox ??= new THREE.Box3().setFromObject(group);
    if (this.#structureBox.isEmpty()) return false;
    const direction = this.#direction.subVectors(to, from);
    const distance = direction.length();
    if (distance < 1e-6) return false;
    const raycaster = this.#raycaster;
    raycaster.set(from, direction.divideScalar(distance));
    raycaster.far = distance;
    if (!raycaster.ray.intersectsBox(this.#structureBox)) return false;
    const hits = this.#hits;
    hits.length = 0;
    raycaster.intersectObject(group, true, hits);
    const structures = this.#layers.structures;
    let hidden = false;
    for (const hit of hits) {
      if (!structures.isClipped(hit.point)) {
        hidden = true;
        break;
      }
    }
    hits.length = 0;
    return hidden;
  }
}
