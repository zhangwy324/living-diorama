import type { PlayerPartEntry } from "@living-diorama/content-schema";
import { useEffect, useMemo, useRef, useState } from "react";
import "./my-parts.css";
import { partThumbnailKey, usePartThumbnails, type PartThumbnails } from "./part-thumbnails";
import {
  MAX_PART_NAME_LENGTH,
  validPartName,
  type PlayerPart,
  type PlayerPartsState,
} from "./player-parts";

// The parts the player drew (ADR 0025 §7, §9): each with its image, name and part type, to
// rename, edit in Draw mode or delete. Deleting asks first; creatures already released keep
// their copies (ADR 0022 §17).

/** Images are drawn at twice their 40 px on screen, for high-density displays. */
export const MY_PARTS_THUMBNAIL_SIZE = 80;

export interface MyPartsProps {
  playerParts: PlayerPartsState;
  /** A part type's name, e.g. "Leg", shown under each part's name. */
  typeName?(partType: string): string | undefined;
  /** Draws the images; with none, placeholders show. */
  thumbnails?: PartThumbnails | undefined;
  /** Opens the part's drawing in Draw mode; with none, there is no Edit button. */
  onEditPart?: ((entry: PlayerPartEntry) => void) | undefined;
}

export function MyParts({ playerParts, typeName, thumbnails, onEditPart }: MyPartsProps) {
  const { parts, error } = playerParts;
  const summaries = useMemo(() => (parts ?? []).map(({ summary }) => summary), [parts]);
  const images = usePartThumbnails(summaries, thumbnails, MY_PARTS_THUMBNAIL_SIZE);
  const [renaming, setRenaming] = useState<{ uuid: string; name: string }>();
  const [deleting, setDeleting] = useState<PlayerPart>();
  // The part a rename or delete is waiting on, whose buttons are disabled meanwhile.
  const [busy, setBusy] = useState<string>();

  const run = (uuid: string, request: () => Promise<boolean>, after?: (ok: boolean) => void) => {
    setBusy(uuid);
    void request()
      .then((ok) => after?.(ok))
      .finally(() => setBusy(undefined));
  };

  return (
    <section className="my-parts" aria-labelledby="my-parts-heading">
      <h2 id="my-parts-heading">My parts</h2>
      {error && (
        <p className="panel-message" role="alert">
          {error}
        </p>
      )}
      {parts?.length === 0 && <p className="empty-list">Parts you draw appear here.</p>}
      <ul className="my-parts-list">
        {parts?.map((part) => {
          const { uuid, entry, summary } = part;
          const image = images.get(partThumbnailKey(summary));
          const disabled = busy === uuid;
          return (
            <li key={uuid} className="my-part">
              {image ? (
                <img className="thumbnail" src={image} alt="" />
              ) : (
                <span className="thumbnail placeholder" />
              )}
              {renaming?.uuid === uuid ? (
                <RenameField
                  name={renaming.name}
                  original={entry.name}
                  disabled={disabled}
                  onName={(name) => setRenaming({ uuid, name })}
                  onCancel={() => setRenaming(undefined)}
                  onSave={() =>
                    run(
                      uuid,
                      () => playerParts.rename(uuid, renaming.name),
                      (ok) => ok && setRenaming(undefined),
                    )
                  }
                />
              ) : (
                <>
                  <div className="my-part-text">
                    <span className="my-part-name">{entry.name}</span>
                    <span className="my-part-type">
                      {typeName?.(entry.part.type) ?? entry.part.type}
                    </span>
                  </div>
                  <div className="my-part-buttons">
                    <button
                      type="button"
                      aria-label={`Rename ${entry.name}`}
                      title="Rename"
                      disabled={disabled}
                      onClick={() => setRenaming({ uuid, name: entry.name })}
                    >
                      <Icon d="M2.5 12.5h11M4 9.5l5.5-5.5 2 2L6 11.5H4z" />
                    </button>
                    {onEditPart && (
                      <button
                        type="button"
                        aria-label={`Edit ${entry.name}`}
                        title="Edit the drawing"
                        disabled={disabled}
                        onClick={() => onEditPart(entry)}
                      >
                        <Icon d="M10.5 3l2.5 2.5-7 7H3.5V10zM9 4.5L11.5 7" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="delete"
                      aria-label={`Delete ${entry.name}`}
                      title="Delete"
                      disabled={disabled}
                      onClick={() => setDeleting(part)}
                    >
                      <Icon d="M3.5 4.5h9M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {deleting && (
        <DeletePartDialog
          name={deleting.entry.name}
          onDelete={() => {
            const { uuid } = deleting;
            setDeleting(undefined);
            run(uuid, () => playerParts.remove(uuid));
          }}
          onCancel={() => setDeleting(undefined)}
        />
      )}
    </section>
  );
}

function RenameField(props: {
  name: string;
  original: string;
  disabled: boolean;
  onName(name: string): void;
  onSave(): void;
  onCancel(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const savable = validPartName(props.name) && props.name.trim() !== props.original;
  return (
    <form
      className="my-part-rename"
      onSubmit={(event) => {
        event.preventDefault();
        if (savable) props.onSave();
        else if (props.name.trim() === props.original) props.onCancel();
      }}
    >
      <input
        ref={input}
        type="text"
        aria-label={`New name for ${props.original}`}
        value={props.name}
        maxLength={MAX_PART_NAME_LENGTH}
        disabled={props.disabled}
        onChange={(event) => props.onName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          props.onCancel();
        }}
      />
      <button type="submit" disabled={props.disabled || !savable}>
        Save
      </button>
      <button type="button" disabled={props.disabled} onClick={props.onCancel}>
        Cancel
      </button>
    </form>
  );
}

/** Asked before a part is deleted from My parts. Escape cancels; Cancel has the focus. */
export function DeletePartDialog(props: { name: string; onDelete(): void; onCancel(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    cancel.current?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="close-dialog"
      aria-labelledby="delete-part-title"
      onCancel={(event) => {
        event.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="delete-part-title">Delete {props.name}?</h2>
      <p>
        {props.name} will be gone from My parts for good. Creatures you released with it keep
        theirs.
      </p>
      <div className="close-dialog-buttons">
        <button type="button" className="danger" onClick={props.onDelete}>
          Delete
        </button>
        <button type="button" ref={cancel} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path className="stroke" d={d} />
    </svg>
  );
}
