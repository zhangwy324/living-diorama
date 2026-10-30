import type { LibraryBodyKind } from "@living-diorama/content-schema";

// The images of drawn species in My creatures. `blob:` URLs from the strip belong to its document,
// so the Studio loads each species' PNG itself and makes its own URL (ADR 0015 §5). A voxel
// species has no stored image: `voxel-thumbnails.ts` draws it (ADR 0023 §19).

export interface ThumbnailOptions {
  /** The PNG bytes of the species stored under `libraryId`. */
  load(libraryId: string): Promise<Uint8Array>;
  /** Called when an image is ready. */
  onChange(): void;
  createUrl?: (bytes: Uint8Array) => string;
  revokeUrl?: (url: string) => void;
}

/** One image URL per listed species, loaded once and revoked when the species leaves the list. */
export class Thumbnails {
  private readonly urls = new Map<string, string>();
  /** Species whose image is loading or failed to load, so it isn't asked for again. */
  private readonly asked = new Set<string>();
  private disposed = false;
  private readonly createUrl;
  private readonly revokeUrl;

  constructor(private readonly options: ThumbnailOptions) {
    this.createUrl =
      options.createUrl ??
      ((bytes: Uint8Array) =>
        URL.createObjectURL(new Blob([bytes.slice()], { type: "image/png" })));
    this.revokeUrl = options.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));
  }

  /** The image URL of `speciesId`, once loaded. */
  get(speciesId: string): string | undefined {
    return this.urls.get(speciesId);
  }

  /**
   * Loads the images of drawn species new to the list and revokes those of species no longer in
   * it. Voxel species have none to load.
   */
  sync(all: readonly { speciesId: string; libraryId: string; body?: LibraryBodyKind }[]): void {
    const species = all.filter(({ body }) => body !== "voxel");
    const listed = new Set(species.map(({ speciesId }) => speciesId));
    for (const [speciesId, url] of this.urls) {
      if (listed.has(speciesId)) continue;
      this.revokeUrl(url);
      this.urls.delete(speciesId);
    }
    for (const speciesId of this.asked) if (!listed.has(speciesId)) this.asked.delete(speciesId);
    for (const { speciesId, libraryId } of species) {
      if (this.asked.has(speciesId)) continue;
      this.asked.add(speciesId);
      this.options
        .load(libraryId)
        .then((bytes) => {
          // Gone from the list, or the Studio closing, while it loaded.
          if (this.disposed || !this.asked.has(speciesId)) return;
          this.urls.set(speciesId, this.createUrl(bytes));
          this.options.onChange();
        })
        .catch((error: unknown) => console.warn(`Could not load the image of ${speciesId}`, error));
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls.values()) this.revokeUrl(url);
    this.urls.clear();
  }
}
