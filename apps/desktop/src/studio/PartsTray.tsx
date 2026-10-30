import type { VoxelThumbnails } from "@living-diorama/renderer";
import { useEffect, useState } from "react";
import type { TraySection } from "./parts-kit";

// Build mode's parts tray (ADR 0023 §4, §18): the parts to build with, in a section per part
// type, each with a voxel thumbnail. Picking one marks where it can go.

/** A tray thumbnail's size in image pixels: twice its size on screen, for sharp high-DPI screens. */
export const TRAY_THUMBNAIL_SIZE = 112;

export function PartsTray(props: {
  sections: readonly TraySection[];
  /** The picked part's ID. */
  picked: string | undefined;
  onPick(partId: string): void;
  /** Draws the thumbnails; undefined until the assembly view runs. */
  thumbnails: Pick<VoxelThumbnails, "part"> | undefined;
  /** No picking in the confirm step. */
  locked?: boolean;
}) {
  const { sections, thumbnails } = props;
  const [images, setImages] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    if (!thumbnails) return;
    let current = true;
    for (const { parts } of sections) {
      for (const part of parts) {
        thumbnails
          .part(part, TRAY_THUMBNAIL_SIZE)
          .then((image) => {
            if (current && image) setImages((known) => new Map(known).set(part.id, image));
          })
          // The tray works without it: the name still shows.
          .catch((error: unknown) => console.warn(`No thumbnail for ${part.id}`, error));
      }
    }
    return () => {
      current = false;
    };
  }, [sections, thumbnails]);

  return (
    <aside
      className={props.locked ? "parts-tray locked" : "parts-tray"}
      aria-label="Parts"
      inert={props.locked}
    >
      {sections.map((section) => (
        <section key={section.type} aria-labelledby={`tray-${section.type}`}>
          <h3 id={`tray-${section.type}`}>{section.name}</h3>
          <div className="tray-parts">
            {section.parts.map((part) => {
              const image = images.get(part.id);
              return (
                <button
                  key={part.id}
                  type="button"
                  className="tray-part"
                  aria-pressed={props.picked === part.id}
                  title={part.name}
                  onClick={() => props.onPick(part.id)}
                >
                  {image ? (
                    <img src={image} alt="" draggable={false} />
                  ) : (
                    <span className="tray-placeholder" aria-hidden="true" />
                  )}
                  <span className="tray-name">{part.name}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </aside>
  );
}
