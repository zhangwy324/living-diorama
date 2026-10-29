import {
  SIZE_CLASSES,
  defaultAnchor,
  type Anchors,
  type BodyShape,
  type SizeClass,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { buildBody, fallbackBody, type Body } from "./body/body";
import { readImage, type ImageReader } from "./body/pixels";
import {
  CueSprites,
  ScreenScale,
  bodyMotion,
  cuePhase,
  frontLift,
  noCueSprites,
  restingMotion,
  stepCueWeights,
  type BodyMotion,
  type CreatureCueSprites,
  type CueAnchor,
  type CueView,
  type CueWeights,
} from "./cues";
import { describeCues, emptyCueBox, layoutCues, type CueBox } from "./cue-layout";
import { visibleState, type CueVisibility, type VisibilityState } from "./cue-visibility";
import type { CreaturePose } from "./interpolation";
import type { SceneLayer } from "./layers";
import {
  leapMotion,
  locomotionMotion,
  locomotionTransform,
  placePivots,
  restingLocomotion,
  restingMovement,
  trackMovement,
  type LocomotionBody,
  type LocomotionInput,
  type LocomotionMotion,
  type LocomotionPivot,
  type Movement,
} from "./locomotion";
import type { AssetResolver } from "./props";

// Creatures as solid bodies extruded from their drawings, casting shadows from the sun (ADR 0011),
// true to scale, posed and marked for their cues (ADR 0018 §15).

/** What the renderer needs to know about a species. `SpeciesDefinition` fits. */
export interface RenderSpecies {
  /** Asset ref of an image drawn facing right, feet at the bottom of the drawing. */
  appearance: string;
  sizeClass: SizeClass;
  /** How the body is built from the image: how deep it is. */
  body: BodyShape;
}

export type SpeciesResolver = (speciesId: string) => RenderSpecies | undefined;

export interface CreatureBodiesOptions {
  resolveSpecies: SpeciesResolver;
  resolveAsset: AssetResolver;
  readImage?: ImageReader;
  /** Hides the cues of creatures the terrain or a structure hides. Without it cues always show. */
  visibility?: CueVisibility;
}

/** A species as drawn: its body, its size and reach in metres, and its anchors as pivots. */
interface SpeciesLook extends LocomotionBody {
  /** The fallback block until the drawing's body is built. */
  body: Body;
  /** The species' placed anchors; the others sit where `defaultAnchor` puts them. */
  anchors: Anchors;
  pivots: Record<LocomotionPivot, THREE.Vector3>;
}

/** A frame's clocks, in seconds. */
export interface CreatureFrame {
  /** Animation time: stops while the simulation is paused, so bobs and z's hold still. */
  time: number;
  /** Real time: cues fade in and out on it even while paused. */
  realTime: number;
  /** The camera cue sprites are sized for, in its CSS pixels. */
  view?: CueView;
}

interface Creature {
  id: string;
  mesh: THREE.Mesh;
  weights: CueWeights;
  /** How it has been moving, for its walk, hop or swim. */
  movement: Movement;
  phase: number;
  sprites: CreatureCueSprites;
  /** The meal's progress while eating, kept as the ring fades out after it. */
  progress: number | undefined;
  visibility: VisibilityState;
  /** Where its cue sprites go this frame. */
  anchor: CueAnchor;
  /** Its cues as the layout sees them. */
  box: CueBox;
}

/** Without a camera, cues are sized as if a pixel were this many metres. */
const DEFAULT_UNITS_PER_PIXEL = 0.02;

const byId = (a: Creature, b: Creature) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** How far a body reaches back and forward along X, and to each side of its middle plane. */
function reachOf(body: Body): Pick<SpeciesLook, "minX" | "maxX" | "halfDepth"> {
  body.geometry.computeBoundingBox();
  const box = body.geometry.boundingBox;
  return {
    minX: box?.min.x ?? 0,
    maxX: box?.max.x ?? 0,
    halfDepth: Math.max(0, box?.max.z ?? 0, -(box?.min.z ?? 0)),
  };
}

const cogOnBody = new THREE.Vector3();
const tailOnBody = new THREE.Vector3();

/**
 * Puts the pivots of `look` on its current body (ADR 0020 §10), from its anchors: placed, or
 * where `defaultAnchor` puts them.
 */
function placeAnchors(look: SpeciesLook): void {
  const { drawing } = look.body;
  const { centerOfGravity, tail } = look.anchors;
  drawing.toBody(centerOfGravity ?? defaultAnchor("centerOfGravity", drawing.bounds), cogOnBody);
  drawing.toBody(tail ?? defaultAnchor("tail", drawing.bounds), tailOnBody);
  placePivots(look, cogOnBody, tailOnBody);
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const ONE = new THREE.Vector3(1, 1, 1);

export class CreatureBodies {
  readonly #creatures = new Map<string, Creature>();
  readonly #looks = new Map<string, SpeciesLook>();
  /** Every body built, fallbacks included, for `dispose`. */
  readonly #bodies: Body[] = [];
  readonly #loads: Promise<void>[] = [];
  readonly #layer: SceneLayer;
  readonly #resolveSpecies: SpeciesResolver;
  readonly #resolveAsset: AssetResolver;
  readonly #readImage: ImageReader;
  readonly #visibility: CueVisibility | undefined;
  readonly #cues = new CueSprites();
  readonly #screen = new ScreenScale();
  // Reused every frame, so placing creatures allocates nothing.
  readonly #motion = restingMotion();
  readonly #locomotion = restingLocomotion();
  readonly #input: LocomotionInput = {
    profile: undefined,
    speed: 0,
    travelled: 0,
    time: 0,
    phase: 0,
    height: 0,
  };
  readonly #scratch = {
    base: new THREE.Matrix4(),
    cue: new THREE.Matrix4(),
    move: new THREE.Matrix4(),
    position: new THREE.Vector3(),
    scale: new THREE.Vector3(),
    turn: new THREE.Quaternion(),
    point: new THREE.Vector3(),
  };
  /** Where the visibility check looks from: the head's top, then the middle of the body. */
  readonly #samples = [new THREE.Vector3(), new THREE.Vector3()] as const;
  readonly #seen = new Set<string>();
  /** Creatures by ID, so cues lay out the same whatever order poses come in; rebuilt on change. */
  readonly #ordered: Creature[] = [];
  readonly #boxes: CueBox[] = [];
  #reorder = false;
  readonly #onScreen = new THREE.Vector3();
  #frame: CreatureFrame = { time: 0, realTime: 0 };
  #realTime: number | undefined;
  #time: number | undefined;

  constructor(layer: SceneLayer, options: CreatureBodiesOptions) {
    this.#layer = layer;
    this.#resolveSpecies = options.resolveSpecies;
    this.#resolveAsset = options.resolveAsset;
    this.#readImage = options.readImage ?? readImage;
    this.#visibility = options.visibility;
    layer.group.add(this.#cues.group);
  }

  /** Resolves once every drawing requested so far has been built into a body or failed. */
  get ready(): Promise<void> {
    return Promise.all(this.#loads).then(() => undefined);
  }

  /**
   * Places each creature for this `frame` (by default the last one again), posed and marked for its
   * cues; creatures not in `poses` are removed.
   */
  update(poses: readonly CreaturePose[], frame: CreatureFrame = this.#frame) {
    this.#frame = frame;
    const { time, realTime, view } = frame;
    const dt = realTime - (this.#realTime ?? realTime);
    this.#realTime = realTime;
    // Movement is measured on animation time, which stops while the simulation is paused (the
    // view sets its timer's timescale to 0), so a paused creature holds its pose mid-stride.
    const animationDt = time - (this.#time ?? time);
    this.#time = time;
    if (view) this.#screen.set(view);
    const seen = this.#seen;
    seen.clear();
    for (const pose of poses) {
      const look = this.#look(pose.speciesId);
      if (!look) continue;
      const creature = this.#creatures.get(pose.id) ?? this.#add(pose.id, look);
      seen.add(pose.id);
      const { mesh, weights, phase } = creature;
      stepCueWeights(weights, pose.cues, dt);
      if (pose.cues.includes("eating")) creature.progress = pose.cueProgress;
      const airborne = pose.jump !== undefined;
      const { speed, travelled } = trackMovement(
        creature.movement,
        pose.world,
        animationDt,
        airborne,
      );
      const motion = bodyMotion(weights, time, phase, this.#motion);
      const height = look.height;
      const input = this.#input;
      input.profile = pose.animation;
      input.speed = speed;
      input.travelled = travelled;
      input.time = time;
      input.phase = phase;
      input.height = height;
      // In the air on a bank jump the leap takes the profile's place; the arc is in the pose.
      const locomotion = airborne
        ? leapMotion(pose.jump ?? 0, this.#locomotion)
        : locomotionMotion(input, this.#locomotion);
      this.#place(mesh, pose, look, motion, locomotion);
      mesh.geometry = look.body.geometry;
      mesh.material = look.body.material;

      // Cues go above the head as it rises and falls, but don't swing aside as it sways.
      const top = this.#scratch.point.set(0, height, 0).applyMatrix4(mesh.matrix).y;
      const middle = this.#scratch.point.set(0, height / 2, 0).applyMatrix4(mesh.matrix).y;
      const anchor = creature.anchor;
      anchor.top.set(pose.world.x, top, pose.world.z);
      anchor.unitsPerPixel = view
        ? this.#screen.unitsPerPixel(anchor.top.x, anchor.top.y, anchor.top.z)
        : DEFAULT_UNITS_PER_PIXEL;
      anchor.creaturePx = look.height / anchor.unitsPerPixel;
      anchor.visible = 1;
      const cued = weights.eating > 0 || weights.sleeping > 0 || weights.hungry > 0;
      if (!cued) {
        // Nothing to hide: skip the checks, and check afresh once a cue starts.
        creature.visibility.due = undefined;
      } else if (view && this.#visibility) {
        this.#samples[0].copy(anchor.top);
        this.#samples[1].set(pose.world.x, middle, pose.world.z);
        const visibility = creature.visibility;
        this.#visibility.update(visibility, this.#samples, this.#screen.position, realTime, dt);
        anchor.visible = visibility.weight;
      }
      const box = creature.box;
      if (view && cued && this.#screen.project(anchor.top, this.#onScreen)) {
        const ring = creature.progress !== undefined;
        const { x, y } = this.#onScreen;
        describeCues(box, weights, anchor.creaturePx, anchor.visible, ring, x, y);
      } else {
        box.weight = 0;
        box.zWeight = 0;
      }
    }
    for (const [id, creature] of this.#creatures) {
      if (seen.has(id)) continue;
      creature.mesh.removeFromParent();
      this.#cues.release(creature.sprites);
      this.#creatures.delete(id);
      this.#reorder = true;
    }
    if (this.#reorder) this.#sort();

    // Then keeps cues of creatures bunched together apart, and places them.
    layoutCues(this.#boxes, dt);
    const { right, up } = this.#screen;
    for (const creature of this.#ordered) {
      const { anchor, box } = creature;
      anchor.shift
        .copy(right)
        .multiplyScalar(box.shiftX * anchor.unitsPerPixel)
        .addScaledVector(up, box.shiftY * anchor.unitsPerPixel);
      anchor.zThin = box.thin;
      const { sprites, weights, phase, progress } = creature;
      this.#cues.place(sprites, weights, anchor, time, phase, progress);
    }
  }

  get count(): number {
    return this.#creatures.size;
  }

  /** Gives the z's their night look (light on dark) or their day look (dark on light). */
  setNight(night: boolean): void {
    this.#cues.night = night;
  }

  /** Cue sprites in use. */
  get cueSprites(): number {
    return this.#cues.active;
  }

  dispose(): void {
    for (const body of this.#bodies) body.dispose();
    this.#cues.dispose();
  }

  /**
   * Sets the body's transform from its pose, cue motion and locomotion. Outermost first: the
   * position, lowered by its submersion (ADR 0020 §9), and the heading; then the cue motion about
   * the bottom middle of the body (ADR 0018 §15); then the locomotion about its pivot (ADR 0020
   * §8, §10, `locomotionTransform`). So the two add up: their lifts sum, their tilts and scales
   * compose. A sleeping or eating creature stands still, so the two rarely overlap, and when they
   * do, as one fades, each turns about its own point.
   */
  #place(
    mesh: THREE.Mesh,
    pose: CreaturePose,
    look: SpeciesLook,
    cue: BodyMotion,
    move: LocomotionMotion,
  ): void {
    const { base, cue: cueMatrix, move: moveMatrix, position, scale, turn } = this.#scratch;
    const height = look.height;
    // The cue pitch turns about the bottom middle, so the body rises as its front dips, to keep it
    // above ground; `locomotionTransform` lifts its own tilts the same way.
    const lift =
      cue.lift * height +
      frontLift(Math.max(0, look.maxX) * cue.scaleXZ, cue.pitch) +
      locomotionTransform(move, look, moveMatrix) -
      pose.submersion * height;
    // Heading 0 is +Z and the drawing faces +X: turn +X onto (sin h, 0, cos h).
    position.set(pose.world.x, pose.world.y + lift, pose.world.z);
    base.compose(position, turn.setFromAxisAngle(Y_AXIS, pose.heading - Math.PI / 2), ONE);
    // The pitch turns about the drawing's own depth axis, so its front dips.
    cueMatrix.compose(
      position.set(0, 0, 0),
      turn.setFromAxisAngle(Z_AXIS, -cue.pitch),
      scale.set(cue.scaleXZ, cue.scaleY, cue.scaleXZ),
    );
    mesh.matrix.copy(base).multiply(cueMatrix).multiply(moveMatrix);
    mesh.matrixWorldNeedsUpdate = true;
  }

  #add(id: string, look: SpeciesLook): Creature {
    const mesh = new THREE.Mesh(look.body.geometry, look.body.material);
    mesh.name = id;
    mesh.castShadow = true;
    // Placed by `#place`, which composes more than a position, a rotation and a scale can say.
    mesh.matrixAutoUpdate = false;
    this.#layer.add(mesh);
    const phase = cuePhase(id);
    const creature: Creature = {
      id,
      mesh,
      weights: { eating: 0, sleeping: 0, hungry: 0 },
      movement: restingMovement(),
      phase,
      sprites: noCueSprites(),
      progress: undefined,
      visibility: visibleState(phase),
      anchor: {
        top: new THREE.Vector3(),
        creaturePx: 0,
        unitsPerPixel: DEFAULT_UNITS_PER_PIXEL,
        right: this.#screen.right,
        visible: 1,
        shift: new THREE.Vector3(),
        zThin: false,
      },
      box: emptyCueBox(),
    };
    this.#creatures.set(id, creature);
    this.#reorder = true;
    return creature;
  }

  /** Puts creatures in ID order, for the layout. Only when creatures come or go. */
  #sort(): void {
    this.#reorder = false;
    const ordered = this.#ordered;
    ordered.length = 0;
    for (const creature of this.#creatures.values()) ordered.push(creature);
    ordered.sort(byId);
    this.#boxes.length = 0;
    for (const creature of ordered) this.#boxes.push(creature.box);
  }

  #look(speciesId: string): SpeciesLook | undefined {
    const cached = this.#looks.get(speciesId);
    if (cached) return cached;
    const species = this.#resolveSpecies(speciesId);
    if (!species) {
      console.warn(`No species ${speciesId} to draw`);
      return undefined;
    }
    const { height } = SIZE_CLASSES[species.sizeClass];
    const { thickness } = species.body;
    const block = fallbackBody(height, thickness);
    const look: SpeciesLook = {
      body: block,
      height,
      ...reachOf(block),
      anchors: species.body.anchors,
      pivots: { centerOfGravity: new THREE.Vector3(), front: new THREE.Vector3() },
    };
    placeAnchors(look);
    this.#bodies.push(look.body);
    this.#looks.set(speciesId, look);

    const asset = this.#resolveAsset(species.appearance);
    if (asset?.kind !== "image") {
      console.warn(`No image asset for ${species.appearance}`);
      return look;
    }
    this.#loads.push(
      this.#readImage(asset.url).then(
        (pixels) => {
          const body = buildBody(pixels, height, thickness);
          if (!body) {
            console.warn(`No opaque shape in ${species.appearance}`);
            return;
          }
          this.#bodies.push(body);
          look.body = body;
          Object.assign(look, reachOf(body));
          placeAnchors(look);
        },
        (error: unknown) => console.warn(`Could not load ${species.appearance}`, error),
      ),
    );
    return look;
  }
}
