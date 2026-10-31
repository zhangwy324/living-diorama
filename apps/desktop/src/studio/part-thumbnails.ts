import type { VoxelThumbnails } from "@living-diorama/renderer";
import type { PartSummary } from "@living-diorama/simulation";
import { useEffect, useState } from "react";

// The voxel images of parts, for the tray and My parts (ADR 0023 §20, ADR 0025 §7): asked for once
// per part and version and drawn by the renderer's scheduled, cached thumbnails (#224), so an
// edited part, a new version, is drawn anew while its old image is dropped.

/** What draws part images: Build mode's view's thumbnails. */
export type PartThumbnails = Pick<VoxelThumbnails, "part">;

/** A part's image's key, `id@version`, as the renderer caches it. */
export const partThumbnailKey = (part: Pick<PartSummary, "id" | "version">): string =>
  `${part.id}@${part.version}`;

/**
 * Image URLs of `parts` by `partThumbnailKey`, `size` pixels square, filled in as they are drawn.
 * Images of parts no longer listed, or of an older version, are dropped as new ones arrive, and
 * never shown. Pass a stable list.
 */
export function usePartThumbnails(
  parts: readonly PartSummary[],
  thumbnails: PartThumbnails | undefined,
  size: number,
): ReadonlyMap<string, string> {
  const [images, setImages] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!thumbnails) return;
    const listed = new Set(parts.map(partThumbnailKey));
    let current = true;
    for (const part of parts) {
      const key = partThumbnailKey(part);
      thumbnails
        .part(part, size)
        .then((image) => {
          if (!current || !image) return;
          // Keeps only the listed parts' images, so an old version's goes.
          setImages((known) =>
            new Map([...known].filter(([listedKey]) => listed.has(listedKey))).set(key, image),
          );
        })
        // The name still shows without it.
        .catch((error: unknown) => console.warn(`No thumbnail for ${key}`, error));
    }
    return () => {
      current = false;
    };
  }, [parts, thumbnails, size]);
  return images;
}
