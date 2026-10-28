import { useEffect, useRef } from "react";

export interface CloseDialogProps {
  onDiscard(): void;
  onCancel(): void;
}

/**
 * Asked when the Studio is closed with a drawing that wasn't released (ADR 0015 §10). Saving
 * drafts comes later, so its button is shown but disabled. Escape cancels.
 */
export function CloseDialog({ onDiscard, onCancel }: CloseDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    // Cancel has the focus, so Enter keeps the drawing.
    cancel.current?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="close-dialog"
      aria-labelledby="close-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="close-dialog-title">Close the Studio?</h2>
      <p>Your drawing hasn't been released. Closing now loses it.</p>
      <div className="close-dialog-buttons">
        <button type="button" onClick={onDiscard}>
          Discard
        </button>
        <button type="button" disabled title="Coming later">
          Save draft <small>(coming later)</small>
        </button>
        <button type="button" ref={cancel} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
