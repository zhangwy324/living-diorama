import { SIZE_CLASSES, type BodyShape, type SizeClass } from "@living-diorama/content-schema";
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
  type CreatureCueSprites,
  type CueAnchor,
  type CueView,
  type CueWeights,
} from "./cues";
import type { CreaturePose } from "./interpolation";
import type { SceneLayer } from "./layers";
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
}

interface SpeciesLook {
  /** The fallback block until the drawing's body is built. */
  body: Body;
  /** Metres from the feet to the top of the head. */
  height: number;
  /** Metres from the feet forward to the front of the body, for lifting it as it pecks. */
  front: number;
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
  mesh: THREE.Mesh;
  weights: CueWeights;
  phase: number;
  sprites: CreatureCueSprites;
  /** The meal's progress while eating, kept as the ring fades out after it. */
  progress: number | undefined;
}

/** Without a camera, cues are sized as if a pixel were this many metres. */
const DEFAULT_UNITS_PER_PIXEL = 0.02;

/** How far a body reaches forward (+X) of its feet. */
function frontOf(body: Body): number {
  body.geometry.computeBoundingBox();
  return Math.max(0, body.geometry.boundingBox?.max.x ?? 0);
}

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
  readonly #cues = new CueSprites();
  readonly #screen = new ScreenScale();
  // Reused every frame, so placing creatures allocates nothing.
  readonly #motion = restingMotion();
  readonly #anchor: CueAnchor;
  readonly #seen = new Set<string>();
  #frame: CreatureFrame = { time: 0, realTime: 0 };
  #realTime: number | undefined;

  constructor(layer: SceneLayer, options: CreatureBodiesOptions) {
    this.#layer = layer;
    this.#resolveSpecies = options.resolveSpecies;
    this.#resolveAsset = options.resolveAsset;
    this.#readImage = options.readImage ?? readImage;
    this.#anchor = {
      top: new THREE.Vector3(),
      creaturePx: 0,
      unitsPerPixel: DEFAULT_UNITS_PER_PIXEL,
      right: this.#screen.right,
    };
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
      const motion = bodyMotion(weights, time, phase, this.#motion);
      // The pitch turns about the feet, so the body rises as its front dips, to keep it above ground.
      const lift = motion.lift * look.height + frontLift(look.front * motion.scaleXZ, motion.pitch);
      mesh.position.set(pose.world.x, pose.world.y + lift, pose.world.z);
      // Heading 0 is +Z and the drawing faces +X: turn +X onto (sin h, 0, cos h). The pitch turns
      // about the drawing's own depth axis, so its front dips.
      mesh.rotation.set(0, pose.heading - Math.PI / 2, -motion.pitch);
      mesh.scale.set(motion.scaleXZ, motion.scaleY, motion.scaleXZ);
      mesh.geometry = look.body.geometry;
      mesh.material = look.body.material;

      const anchor = this.#anchor;
      anchor.top.set(
        mesh.position.x,
        mesh.position.y + look.height * motion.scaleY,
        mesh.position.z,
      );
      anchor.unitsPerPixel = view
        ? this.#screen.unitsPerPixel(anchor.top.x, anchor.top.y, anchor.top.z)
        : DEFAULT_UNITS_PER_PIXEL;
      anchor.creaturePx = look.height / anchor.unitsPerPixel;
      this.#cues.place(creature.sprites, weights, anchor, time, phase, creature.progress);
    }
    for (const [id, creature] of this.#creatures) {
      if (seen.has(id)) continue;
      creature.mesh.removeFromParent();
      this.#cues.release(creature.sprites);
      this.#creatures.delete(id);
    }
  }

  get count(): number {
    return this.#creatures.size;
  }

  /** Cue sprites in use. */
  get cueSprites(): number {
    return this.#cues.active;
  }

  dispose(): void {
    for (const body of this.#bodies) body.dispose();
    this.#cues.dispose();
  }

  #add(id: string, look: SpeciesLook): Creature {
    const mesh = new THREE.Mesh(look.body.geometry, look.body.material);
    mesh.name = id;
    mesh.castShadow = true;
    this.#layer.add(mesh);
    const creature: Creature = {
      mesh,
      weights: { eating: 0, sleeping: 0, hungry: 0 },
      phase: cuePhase(id),
      sprites: noCueSprites(),
      progress: undefined,
    };
    this.#creatures.set(id, creature);
    return creature;
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
    const look: SpeciesLook = { body: block, height, front: frontOf(block) };
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
          look.front = frontOf(body);
        },
        (error: unknown) => console.warn(`Could not load ${species.appearance}`, error),
      ),
    );
    return look;
  }
}
