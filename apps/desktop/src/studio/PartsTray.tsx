import type { PartSummary } from "@living-diorama/simulation";
import { useMemo, type PointerEvent } from "react";
import "./parts-tray.css";
import { partThumbnailKey, usePartThumbnails, type PartThumbnails } from "./part-thumbnails";
import type { TraySection } from "./parts-kit";

// Build mode's parts tray (ADR 0023 §4, §18): the parts to build with, in a section per part
// type, each with a voxel thumbnail. The player's own parts follow the packs' in their type's
// section, marked "Mine", and each section ends with a "Draw your own" tile (ADR 0025 §9).
// Picking one marks where it can go; dragging one onto the view places it.

/** A tray thumbnail's size in image pixels: twice its size on screen, for sharp high-DPI screens. */
export const TRAY_THUMBNAIL_SIZE = 112;

export function PartsTray(props: {
  sections: readonly TraySection[];
  /** The picked part's ID. */
  picked: string | undefined;
  onPick(partId: string): void;
  /** A press on a part, which may become a drag onto the view (ADR 0023 §4). */
  onPress?(partId: string, event: PointerEvent<HTMLButtonElement>): void;
  /** Draws the thumbnails; undefined until the assembly view runs. */
  thumbnails: PartThumbnails | undefined;
  /** Opens Draw mode for a part of this type; with none, there are no "Draw your own" tiles. */
  onDrawPart?: ((partType: string) => void) | undefined;
  /** No picking in the confirm step. */
  locked?: boolean;
}) {
  const { sections, onDrawPart } = props;
  const all = useMemo(() => sections.flatMap(({ parts, mine }) => [...parts, ...mine]), [sections]);
  const images = usePartThumbnails(all, props.thumbnails, TRAY_THUMBNAIL_SIZE);

  const tile = (part: PartSummary, mine: boolean) => {
    const image = images.get(partThumbnailKey(part));
    return (
      <button
        key={part.id}
        type="button"
        className={mine ? "tray-part mine" : "tray-part"}
        aria-pressed={props.picked === part.id}
        aria-label={mine ? `${part.name}, mine` : undefined}
        title={mine ? `${part.name} · Mine` : part.name}
        onClick={() => props.onPick(part.id)}
        onPointerDown={(event) => props.onPress?.(part.id, event)}
      >
        {image ? (
          <img src={image} alt="" draggable={false} />
        ) : (
          <span className="tray-placeholder" aria-hidden="true" />
        )}
        <span className="tray-name">{part.name}</span>
        {mine && (
          <span className="mine-badge" aria-hidden="true">
            Mine
          </span>
        )}
      </button>
    );
  };

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
            {section.parts.map((part) => tile(part, false))}
            {section.mine.map((part) => tile(part, true))}
            {onDrawPart && (
              <button
                type="button"
                className="tray-part draw-your-own"
                aria-label={`Draw your own ${section.name.toLowerCase()}`}
                title={`Draw your own ${section.name.toLowerCase()}`}
                onClick={() => onDrawPart(section.type)}
              >
                <svg viewBox="0 0 16 16" width="26" height="26" aria-hidden="true">
                  <path className="stroke" d="M10.5 3l2.5 2.5-7 7H3.5V10zM9 4.5L11.5 7" />
                </svg>
                <span className="tray-name">Draw your own</span>
              </button>
            )}
          </div>
        </section>
      ))}
    </aside>
  );
}
