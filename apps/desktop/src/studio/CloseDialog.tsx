import { useEffect, useRef } from "react";

export interface CloseDialogProps {
  /** The question, "Close the Studio?" by default. */
  title?: string;
  /** What is lost, by default by closing. */
  message?: string;
  onDiscard(): void;
  onCancel(): void;
}

/**
 * Asked when the Studio is closed with a creature that wasn't released (ADR 0015 §10), and before
 * Edit a copy replaces one (ADR 0023 §3), with its own title and message. Saving
 * drafts comes later, so its button is shown but disabled. Escape cancels.
 */
export function CloseDialog({
  title = "Close the Studio?",
  message = "Your creature hasn't been released. Closing now loses it.",
  onDiscard,
  onCancel,
}: CloseDialogProps) {
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
      <h2 id="close-dialog-title">{title}</h2>
      <p>{message}</p>
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
