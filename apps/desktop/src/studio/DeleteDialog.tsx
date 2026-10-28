import { useEffect, useRef } from "react";

export interface DeleteDialogProps {
  name: string;
  /** Its creatures in the world now, which leave with it. */
  inWorld: number;
  onDelete(): void;
  onCancel(): void;
}

/** Asked before a species is deleted from My creatures. Escape cancels. */
export function DeleteDialog({ name, inWorld, onDelete, onCancel }: DeleteDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    // Cancel has the focus, so Enter keeps the species.
    cancel.current?.focus();
  }, []);
  const leaving =
    inWorld === 0
      ? ""
      : inWorld === 1
        ? " The one in the world leaves it."
        : ` All ${inWorld} in the world leave it.`;
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
      <p>
        {name} will be gone from My creatures for good.{leaving}
      </p>
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
