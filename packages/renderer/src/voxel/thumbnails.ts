import {
  IDENTITY_QUATERNION,
  type VoxelAssembly,
  type VoxelPart,
} from "@living-diorama/content-schema";
import type * as THREE from "three";
import {
  drawThumbnail,
  thumbnailSize,
  type ThumbnailEncoder,
  type ThumbnailRenderer,
} from "../prop-thumbnails";
import { buildVoxelBody, createVoxelMaterial, skinVoxelBody } from "./body";

// Thumbnails of voxel parts and assemblies (ADR 0022, M20 decisions), e.g. for the Studio's part
// picker and creature library: drawn at run time like prop thumbnails (`prop-thumbnails.ts`), in
// the same three-quarter view and plain daylight, with the material creatures are drawn with in
// the world, so a part's colours, occlusion and glow read as they do on a creature.

/** The key of a lone part's one instance and its part, in the assembly it is drawn as. */
const LONE = "part";

/** A part alone, as an assembly of one instance: at rest, unmirrored, its own root. */
function loneAssembly(part: VoxelPart): VoxelAssembly {
  return {
    parts: { [LONE]: part },
    instances: [{ id: LONE, part: LONE, rotation: IDENTITY_QUATERNION, mirrored: false }],
  };
}

/**
 * Thumbnails of voxel parts and assemblies by object and size, drawn with the view's renderer
 * when first asked for and kept as image URLs, so each is drawn once per size. They are kept by
 * the identity of the part or assembly object, in a `WeakMap`: asking again with the same object
 * draws nothing, an equal copy is drawn anew, and an object no longer held elsewhere takes its
 * thumbnails with it. A part is drawn alone at rest; an assembly as a creature stands, in its rest
 * pose. Parts and assemblies must be valid (`VoxelPartSchema`, `VoxelAssemblySchema`).
 *
 * GPU resources: each thumbnail's body (geometry and skeleton) and render target are freed as
 * soon as it is read back, so only the image URLs are kept. `dispose` forgets the thumbnails and
 * frees the material; after it, thumbnails are undefined.
 */
export class VoxelThumbnails {
  readonly #renderer: ThumbnailRenderer;
  readonly #encode: ThumbnailEncoder;
  #cache = new WeakMap<VoxelPart | VoxelAssembly, Map<number, string>>();
  /** Shared by every thumbnail; `drawIcon` draws with copies of it. */
  #material: THREE.MeshStandardMaterial | undefined;
  #disposed = false;

  constructor(renderer: ThumbnailRenderer, encode: ThumbnailEncoder) {
    this.#renderer = renderer;
    this.#encode = encode;
  }

  /**
   * An image URL of `part` alone, `size` pixels square (rounded, at most `MAX_THUMBNAIL_SIZE`),
   * on a transparent background; undefined once disposed.
   */
  part(part: VoxelPart, size: number): string | undefined {
    return this.#thumbnail(part, size, () => loneAssembly(part));
  }

  /** As `part`, of a whole assembly in its rest pose, e.g. a creature in a library. */
  assembly(assembly: VoxelAssembly, size: number): string | undefined {
    return this.#thumbnail(assembly, size, () => assembly);
  }

  #thumbnail(
    key: VoxelPart | VoxelAssembly,
    size: number,
    assembly: () => VoxelAssembly,
  ): string | undefined {
    const pixels = thumbnailSize(size);
    if (this.#disposed) return undefined;
    let bySize = this.#cache.get(key);
    const kept = bySize?.get(pixels);
    if (kept !== undefined) return kept;
    const body = buildVoxelBody(assembly());
    const mesh = skinVoxelBody(body, (this.#material ??= createVoxelMaterial()));
    let url: string;
    try {
      url = drawThumbnail(this.#renderer, mesh, pixels, this.#encode);
    } finally {
      mesh.skeleton.dispose();
      body.dispose();
    }
    if (!bySize) this.#cache.set(key, (bySize = new Map()));
    bySize.set(pixels, url);
    return url;
  }

  dispose(): void {
    this.#disposed = true;
    this.#cache = new WeakMap();
    this.#material?.dispose();
    this.#material = undefined;
  }
}
