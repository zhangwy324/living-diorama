import { SIZE_CLASSES, type SizeClass } from "@living-diorama/content-schema";
import * as THREE from "three";
import type { CreaturePose } from "./interpolation";
import type { SceneLayer } from "./layers";
import type { AssetResolver } from "./props";

// Creatures as upright sprites with a shadow blob (ADR 0007 §6–§7).

/** What the renderer needs to know about a species. `SpeciesDefinition` fits. */
export interface RenderSpecies {
  /** Asset ref of an image drawn facing right, feet on its bottom edge. */
  appearance: string;
  sizeClass: SizeClass;
}

export type SpeciesResolver = (speciesId: string) => RenderSpecies | undefined;
export type ImageLoader = (url: string) => Promise<THREE.Texture>;

export const loadTexture: ImageLoader = async (url) => {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

/** Sprites are never drawn shorter than this many CSS pixels; the footprint is unchanged. */
export const MIN_SPRITE_PX = 24;
/** Below this share of the camera's right vector the heading is "towards or away", so the sprite keeps its facing. */
const FACING_DEAD_ZONE = 0.15;
const FALLBACK_COLOR = "#8f8a82";
const FALLBACK_ASPECT = 0.75;
/** Lifts the shadow blob off the surface so it does not z-fight. */
const SHADOW_LIFT = 0.02;

interface SpeciesLook {
  material: THREE.MeshBasicMaterial;
  /** Sprite width over height, from the image once it loads. */
  aspect: number;
  height: number;
  radius: number;
}

interface CreatureObject {
  root: THREE.Group;
  sprite: THREE.Mesh;
  look: SpeciesLook;
  facingRight: boolean;
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

export class CreatureSprites {
  readonly #creatures = new Map<string, CreatureObject>();
  readonly #looks = new Map<string, SpeciesLook>();
  readonly #textures: THREE.Texture[] = [];
  readonly #spriteGeometry = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  readonly #shadowGeometry = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
  readonly #shadowMaterial: THREE.MeshBasicMaterial;
  readonly #loads: Promise<void>[] = [];
  readonly #layer: SceneLayer;
  readonly #resolveSpecies: SpeciesResolver;
  readonly #resolveAsset: AssetResolver;
  readonly #loadImage: ImageLoader;

  constructor(
    layer: SceneLayer,
    resolveSpecies: SpeciesResolver,
    resolveAsset: AssetResolver,
    loadImage: ImageLoader = loadTexture,
  ) {
    this.#layer = layer;
    this.#resolveSpecies = resolveSpecies;
    this.#resolveAsset = resolveAsset;
    this.#loadImage = loadImage;
    const alphaMap = shadowTexture();
    this.#textures.push(alphaMap);
    this.#shadowMaterial = new THREE.MeshBasicMaterial({
      color: "#1d2414",
      transparent: true,
      opacity: 0.45,
      alphaMap,
      depthWrite: false,
    });
  }

  /** Resolves once every sprite image requested so far has loaded or failed. */
  get ready(): Promise<void> {
    return Promise.all(this.#loads).then(() => undefined);
  }

  /** Places each creature for this frame; creatures not in `poses` are removed. */
  update(
    poses: readonly CreaturePose[],
    camera: THREE.PerspectiveCamera,
    viewportHeightPx: number,
  ) {
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const pixelsPerMetreAtUnitDepth =
      viewportHeightPx / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));

    const seen = new Set<string>();
    for (const pose of poses) {
      const creature = this.#creatures.get(pose.id) ?? this.#add(pose);
      if (!creature) continue;
      seen.add(pose.id);
      const { root, sprite, look } = creature;
      root.position.set(pose.world.x, pose.world.y, pose.world.z);

      // Upright: turn about the vertical axis only, towards the camera.
      sprite.rotation.y = Math.atan2(
        camera.position.x - pose.world.x,
        camera.position.z - pose.world.z,
      );
      // Heading 0 is +Z; the image faces right, so mirror it when the creature heads left on screen.
      const sideways = Math.sin(pose.heading) * right.x + Math.cos(pose.heading) * right.z;
      if (Math.abs(sideways) > FACING_DEAD_ZONE) creature.facingRight = sideways > 0;

      const depth = Math.max(0.01, root.position.clone().sub(camera.position).dot(forward));
      const heightPx = (look.height * pixelsPerMetreAtUnitDepth) / depth;
      const boost = Math.max(1, MIN_SPRITE_PX / heightPx);
      sprite.scale.set(
        look.height * look.aspect * boost * (creature.facingRight ? 1 : -1),
        look.height * boost,
        1,
      );
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
    this.#spriteGeometry.dispose();
    this.#shadowGeometry.dispose();
    this.#shadowMaterial.dispose();
    for (const look of this.#looks.values()) look.material.dispose();
    for (const texture of this.#textures) texture.dispose();
  }

  #add(pose: CreaturePose): CreatureObject | undefined {
    const look = this.#look(pose.speciesId);
    if (!look) return undefined;
    const sprite = new THREE.Mesh(this.#spriteGeometry, look.material);
    const shadow = new THREE.Mesh(this.#shadowGeometry, this.#shadowMaterial);
    shadow.position.y = SHADOW_LIFT;
    shadow.scale.setScalar(look.radius * 1.1);
    shadow.renderOrder = -1;
    const root = new THREE.Group();
    root.name = pose.id;
    root.add(shadow, sprite);
    this.#layer.add(root);
    const creature = { root, sprite, look, facingRight: true };
    this.#creatures.set(pose.id, creature);
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
    const { height, radius } = SIZE_CLASSES[species.sizeClass];
    const look: SpeciesLook = {
      material: new THREE.MeshBasicMaterial({
        color: FALLBACK_COLOR,
        alphaTest: 0.5,
        side: THREE.DoubleSide,
      }),
      aspect: FALLBACK_ASPECT,
      height,
      radius,
    };
    this.#looks.set(speciesId, look);

    const asset = this.#resolveAsset(species.appearance);
    if (asset?.kind !== "image") {
      console.warn(`No image asset for ${species.appearance}`);
      return look;
    }
    this.#loads.push(
      this.#loadImage(asset.url).then(
        (texture) => {
          this.#textures.push(texture);
          const image = texture.image as { width?: number; height?: number } | undefined;
          if (image?.width && image.height) look.aspect = image.width / image.height;
          look.material.map = texture;
          look.material.color.set("#ffffff");
          look.material.needsUpdate = true;
        },
        (error: unknown) => console.warn(`Could not load ${species.appearance}`, error),
      ),
    );
    return look;
  }
}
