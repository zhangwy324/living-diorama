import type { ReactNode } from "react";

/** A toolbar button showing a 16-unit icon, labelled for its tooltip and screen readers. */
export function ToolButton(props: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
        {props.children}
      </svg>
    </button>
  );
}
