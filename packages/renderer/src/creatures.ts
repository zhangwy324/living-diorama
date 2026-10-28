import { SIZE_CLASSES, type BodyShape, type SizeClass } from "@living-diorama/content-schema";
import * as THREE from "three";
import { buildBody, fallbackBody, type Body } from "./body/body";
import { readImage, type ImageReader } from "./body/pixels";
import type { CreaturePose } from "./interpolation";
import type { SceneLayer } from "./layers";
import type { AssetResolver } from "./props";

// Creatures as solid bodies extruded from their drawings, casting shadows from the sun (ADR 0011),
// true to scale.

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
}

export class CreatureBodies {
  readonly #creatures = new Map<string, THREE.Mesh>();
  readonly #looks = new Map<string, SpeciesLook>();
  /** Every body built, fallbacks included, for `dispose`. */
  readonly #bodies: Body[] = [];
  readonly #loads: Promise<void>[] = [];
  readonly #layer: SceneLayer;
  readonly #resolveSpecies: SpeciesResolver;
  readonly #resolveAsset: AssetResolver;
  readonly #readImage: ImageReader;

  constructor(layer: SceneLayer, options: CreatureBodiesOptions) {
    this.#layer = layer;
    this.#resolveSpecies = options.resolveSpecies;
    this.#resolveAsset = options.resolveAsset;
    this.#readImage = options.readImage ?? readImage;
  }

  /** Resolves once every drawing requested so far has been built into a body or failed. */
  get ready(): Promise<void> {
    return Promise.all(this.#loads).then(() => undefined);
  }

  /** Places each creature for this frame; creatures not in `poses` are removed. */
  update(poses: readonly CreaturePose[]) {
    const seen = new Set<string>();
    for (const pose of poses) {
      const look = this.#look(pose.speciesId);
      if (!look) continue;
      const body = this.#creatures.get(pose.id) ?? this.#add(pose.id, look);
      seen.add(pose.id);
      body.position.set(pose.world.x, pose.world.y, pose.world.z);
      // Heading 0 is +Z and the drawing faces +X: turn +X onto (sin h, 0, cos h).
      body.rotation.y = pose.heading - Math.PI / 2;
      body.geometry = look.body.geometry;
      body.material = look.body.material;
    }
    for (const [id, body] of this.#creatures) {
      if (seen.has(id)) continue;
      body.removeFromParent();
      this.#creatures.delete(id);
    }
  }

  get count(): number {
    return this.#creatures.size;
  }

  dispose(): void {
    for (const body of this.#bodies) body.dispose();
  }

  #add(id: string, look: SpeciesLook): THREE.Mesh {
    const body = new THREE.Mesh(look.body.geometry, look.body.material);
    body.name = id;
    body.castShadow = true;
    this.#layer.add(body);
    this.#creatures.set(id, body);
    return body;
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
    const look: SpeciesLook = { body: fallbackBody(height, thickness) };
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
        },
        (error: unknown) => console.warn(`Could not load ${species.appearance}`, error),
      ),
    );
    return look;
  }
}
