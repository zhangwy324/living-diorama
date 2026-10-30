import type { LibraryBodyKind } from "@living-diorama/content-schema";
import type { AssemblyThumbnailSource, VoxelThumbnails } from "@living-diorama/renderer";

// The images of voxel species in My creatures (ADR 0023 §19, §20). A voxel species has no stored
// image, so the Studio asks the strip for its assembly when it is first listed and draws it.

/** Thumbnails are drawn at twice their 40 px on screen, for high-density displays. */
export const CREATURE_THUMBNAIL_SIZE = 80;

/** What draws the thumbnails: made when first needed, disposed of with the Studio. */
export interface CreatureThumbnailRenderer {
  readonly thumbnails: Pick<VoxelThumbnails, "assembly">;
  dispose(): void;
}

export interface VoxelCreatureThumbnailOptions {
  /** The saved assembly of a voxel species and its version, from the strip. */
  fetch(
    speciesId: string,
  ): Promise<{ speciesId: string; version: string } & Pick<AssemblyThumbnailSource, "assembly">>;
  /** Makes the renderer, once the first assembly arrives. It may throw, e.g. with no WebGL. */
  createRenderer(): CreatureThumbnailRenderer;
  /** Called when an image is ready. */
  onChange(): void;
}

/**
 * One image URL per listed voxel species. Each species' assembly is asked for once while it is
 * listed and drawn once (`VoxelThumbnails` caches by `id@version`). A failed fetch or drawing is
 * tried again at the next `sync`, i.e. the next change to the library, never on its own.
 */
export class VoxelCreatureThumbnails {
  private readonly images = new Map<string, string>();
  /** Species asked for, by the token of the latest ask, so an answer for an older one is dropped. */
  private readonly asked = new Map<string, object>();
  private renderer: CreatureThumbnailRenderer | undefined;
  /** No renderer could be made, so no voxel images are drawn. */
  private noRenderer = false;
  private disposed = false;

  constructor(private readonly options: VoxelCreatureThumbnailOptions) {}

  /** The image URL of `speciesId`, once drawn. */
  get(speciesId: string): string | undefined {
    return this.images.get(speciesId);
  }

  /** Asks for the images of voxel species new to the list and forgets those no longer in it. */
  sync(all: readonly { speciesId: string; body?: LibraryBodyKind }[]): void {
    if (this.disposed || this.noRenderer) return;
    const listed = new Set(all.filter(({ body }) => body === "voxel").map((s) => s.speciesId));
    for (const speciesId of this.images.keys()) {
      if (!listed.has(speciesId)) this.images.delete(speciesId);
    }
    for (const speciesId of this.asked.keys()) {
      if (!listed.has(speciesId)) this.asked.delete(speciesId);
    }
    for (const speciesId of listed) {
      if (this.asked.has(speciesId)) continue;
      const token = {};
      this.asked.set(speciesId, token);
      const current = () => !this.disposed && this.asked.get(speciesId) === token;
      this.options
        .fetch(speciesId)
        .then(({ version, assembly }) => {
          if (!current()) return undefined;
          return this.draw()?.assembly(
            { id: speciesId, version, assembly },
            CREATURE_THUMBNAIL_SIZE,
          );
        })
        .then((image) => {
          if (!current() || !image) return;
          this.images.set(speciesId, image);
          this.options.onChange();
        })
        .catch((error: unknown) => {
          // My creatures shows a placeholder instead; the next sync tries again.
          if (current()) this.asked.delete(speciesId);
          console.warn(`No thumbnail for ${speciesId}`, error);
        });
    }
  }

  /** The renderer's thumbnails, made on first use; undefined if it can't be made. */
  private draw(): CreatureThumbnailRenderer["thumbnails"] | undefined {
    if (!this.renderer && !this.noRenderer) {
      try {
        this.renderer = this.options.createRenderer();
      } catch (error) {
        this.noRenderer = true;
        console.warn("Voxel creatures' thumbnails can't be drawn", error);
      }
    }
    return this.renderer?.thumbnails;
  }

  dispose(): void {
    this.disposed = true;
    this.images.clear();
    this.asked.clear();
    this.renderer?.dispose();
    this.renderer = undefined;
  }
}
