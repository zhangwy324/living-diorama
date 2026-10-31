import { useEffect, useRef } from "react";

export interface DeleteDialogProps {
  /** What is deleted, for the title "Delete {name}?". */
  name: string;
  /** The dialog's text: what deleting does. */
  message: string;
  onDelete(): void;
  onCancel(): void;
}

/** What deleting a species from My creatures does: it goes, and its creatures leave the world. */
export function speciesDeleteMessage(name: string, inWorld: number): string {
  const leaving =
    inWorld === 0
      ? ""
      : inWorld === 1
        ? " The one in the world leaves it."
        : ` All ${inWorld} in the world leave it.`;
  return `${name} will be gone from My creatures for good.${leaving}`;
}

/** What deleting a part from My parts does; released creatures keep their copies (ADR 0022 §17). */
export const partDeleteMessage = (name: string): string =>
  `${name} will be gone from My parts for good. Creatures you released with it keep theirs.`;

/** Asked before something is deleted for good. Escape cancels; Cancel has the focus. */
export function DeleteDialog({ name, message, onDelete, onCancel }: DeleteDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    // Cancel has the focus, so Enter keeps it.
    cancel.current?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="close-dialog"
      aria-labelledby="delete-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="delete-dialog-title">Delete {name}?</h2>
      <p>{message}</p>
      <div className="close-dialog-buttons">
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
        <button type="button" ref={cancel} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
