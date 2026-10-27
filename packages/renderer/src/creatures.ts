import { SIZE_CLASSES, type SizeClass } from "@living-diorama/content-schema";
import * as THREE from "three";
import { buildBody, fallbackBody, type Body } from "./body/body";
import { readImage, type ImageReader } from "./body/pixels";
import type { CreaturePose } from "./interpolation";
import type { SceneLayer } from "./layers";
import type { AssetResolver } from "./props";

// Creatures as solid bodies extruded from their drawings, casting shadows from the sun, with a
// contact shadow blob under their feet (ADR 0011), true to scale.

/** What the renderer needs to know about a species. `SpeciesDefinition` fits. */
export interface RenderSpecies {
  /** Asset ref of an image drawn facing right, feet at the bottom of the drawing. */
  appearance: string;
  sizeClass: SizeClass;
}

export type SpeciesResolver = (speciesId: string) => RenderSpecies | undefined;

/** Lifts the shadow blob off the surface so it does not z-fight. */
const SHADOW_LIFT = 0.02;
/** The ground is looked for from this far above a creature's feet: below deck railings, above slopes. */
const GROUND_PROBE_HEIGHT = 0.25;
const GROUND_PROBE_DEPTH = 1;
/** A creature that moved less than this keeps its last ground contact. */
const GROUND_RECHECK_DISTANCE = 0.01;
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
/** Where the ground is probed, in shadow radii: the centre and four points on the rim. */
const GROUND_PROBES = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** A hit face's normal in world space, pointing up. */
function groundNormal(hit: THREE.Intersection): THREE.Vector3 {
  const normal = (hit.face?.normal ?? UP).clone().transformDirection(hit.object.matrixWorld);
  return normal.y < 0 ? normal.negate() : normal;
}

export interface CreatureBodiesOptions {
  resolveSpecies: SpeciesResolver;
  resolveAsset: AssetResolver;
  readImage?: ImageReader;
  /** Surfaces creatures stand on (terrain, structures); shadows lie along them. */
  ground?: readonly THREE.Object3D[];
}

interface SpeciesLook {
  /** The fallback block until the drawing's body is built. */
  body: Body;
  radius: number;
}

interface CreatureObject {
  root: THREE.Group;
  body: THREE.Mesh;
  shadow: THREE.Mesh;
  /** Where the ground was last probed for this creature. */
  probedAt?: THREE.Vector3;
  look: SpeciesLook;
}

/** Soft round shadow: alpha falls off from the centre. */
function shadowTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2);
      const alpha = Math.max(0, 1 - r) ** 1.5;
      data.set([255, 255, 255, Math.round(alpha * 255)], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.needsUpdate = true;
  return texture;
}

export class CreatureBodies {
  readonly #creatures = new Map<string, CreatureObject>();
  readonly #looks = new Map<string, SpeciesLook>();
  /** Every body built, fallbacks included, for `dispose`. */
  readonly #bodies: Body[] = [];
  readonly #shadowTexture = shadowTexture();
  readonly #shadowGeometry = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  readonly #shadowMaterial: THREE.MeshBasicMaterial;
  readonly #loads: Promise<void>[] = [];
  readonly #layer: SceneLayer;
  readonly #resolveSpecies: SpeciesResolver;
  readonly #resolveAsset: AssetResolver;
  readonly #readImage: ImageReader;
  readonly #ground: readonly THREE.Object3D[];
  readonly #raycaster = new THREE.Raycaster();

  constructor(layer: SceneLayer, options: CreatureBodiesOptions) {
    this.#layer = layer;
    this.#resolveSpecies = options.resolveSpecies;
    this.#resolveAsset = options.resolveAsset;
    this.#readImage = options.readImage ?? readImage;
    this.#ground = options.ground ?? [];
    this.#raycaster.far = GROUND_PROBE_HEIGHT + GROUND_PROBE_DEPTH;
    this.#shadowMaterial = new THREE.MeshBasicMaterial({
      color: "#1d2414",
      transparent: true,
      opacity: 0.45,
      alphaMap: this.#shadowTexture,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }

  /** Resolves once every drawing requested so far has been built into a body or failed. */
  get ready(): Promise<void> {
    return Promise.all(this.#loads).then(() => undefined);
  }

  /** Places each creature for this frame; creatures not in `poses` are removed. */
  update(poses: readonly CreaturePose[]) {
    const seen = new Set<string>();
    for (const pose of poses) {
      const creature = this.#creatures.get(pose.id) ?? this.#add(pose);
      if (!creature) continue;
      seen.add(pose.id);
      const { root, body, look } = creature;
      root.position.set(pose.world.x, pose.world.y, pose.world.z);
      if (
        !creature.probedAt ||
        creature.probedAt.distanceTo(root.position) > GROUND_RECHECK_DISTANCE
      ) {
        this.#layShadow(creature);
      }
      // Heading 0 is +Z and the drawing faces +X: turn +X onto (sin h, 0, cos h).
      body.rotation.y = pose.heading - Math.PI / 2;
      body.geometry = look.body.geometry;
      body.material = look.body.material;
    }
    for (const [id, creature] of this.#creatures) {
      if (seen.has(id)) continue;
      creature.root.removeFromParent();
      this.#creatures.delete(id);
    }
  }

  get count(): number {
    return this.#creatures.size;
  }

  dispose(): void {
    this.#shadowGeometry.dispose();
    this.#shadowMaterial.dispose();
    this.#shadowTexture.dispose();
    for (const body of this.#bodies) body.dispose();
  }

  #add(pose: CreaturePose): CreatureObject | undefined {
    const look = this.#look(pose.speciesId);
    if (!look) return undefined;
    const body = new THREE.Mesh(look.body.geometry, look.body.material);
    body.castShadow = true;
    const shadow = new THREE.Mesh(this.#shadowGeometry, this.#shadowMaterial);
    shadow.scale.setScalar(look.radius * 1.1);
    shadow.renderOrder = -1;
    const root = new THREE.Group();
    root.name = pose.id;
    root.add(shadow, body);
    this.#layer.add(root);
    const creature: CreatureObject = { root, body, shadow, look };
    this.#creatures.set(pose.id, creature);
    return creature;
  }

  /**
   * Lays the shadow on the ground under the creature (flat at its feet if none is found). The
   * ground is probed at the centre and four rim points: the shadow tilts to their average normal
   * and rises to the highest hit, so where two surfaces meet it isn't hidden under one (issue #29).
   */
  #layShadow(creature: CreatureObject): void {
    const { root, shadow } = creature;
    creature.probedAt = root.position.clone();
    const rim = shadow.scale.x;
    const hits = GROUND_PROBES.flatMap(([x, z]) => {
      const from = root.position
        .clone()
        .add(new THREE.Vector3(x * rim, GROUND_PROBE_HEIGHT, z * rim));
      this.#raycaster.set(from, DOWN);
      const hit = this.#raycaster.intersectObjects([...this.#ground], true).find((h) => h.face);
      return hit ? [{ point: hit.point, normal: groundNormal(hit) }] : [];
    });
    if (!hits.length) {
      shadow.position.set(0, SHADOW_LIFT, 0);
      shadow.quaternion.identity();
      return;
    }
    const normal = hits.reduce((sum, hit) => sum.add(hit.normal), new THREE.Vector3()).normalize();
    // The shadow's plane passes through the hit highest along the normal (on an even slope, all
    // of them), and the shadow sits on that plane under the creature.
    const offset = Math.max(...hits.map((hit) => hit.point.clone().sub(root.position).dot(normal)));
    shadow.position.set(0, offset / normal.y, 0).addScaledVector(normal, SHADOW_LIFT);
    shadow.quaternion.setFromUnitVectors(UP, normal);
  }

  #look(speciesId: string): SpeciesLook | undefined {
    const cached = this.#looks.get(speciesId);
    if (cached) return cached;
    const species = this.#resolveSpecies(speciesId);
    if (!species) {
      console.warn(`No species ${speciesId} to draw`);
      return undefined;
    }
    const { height, radius } = SIZE_CLASSES[species.sizeClass];
    const look: SpeciesLook = { body: fallbackBody(height), radius };
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
          const body = buildBody(pixels, height);
          if (!body) {
            console.warn(`No opaque shape in ${species.appearance}`);
            return;
          }
          this.#bodies.push(body);
          look.body = body;
        },
        (error: unknown) => console.warn(`Could not load ${species.appearance}`, error),
      ),
    );
    return look;
  }
}
