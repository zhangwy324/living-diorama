/** What a key does in the normal window. */
export type Shortcut = "toggle-full-screen" | "leave-full-screen" | "reset-camera";

/**
 * The normal window's only keys (ADR 0016 §2): F11 toggles full screen, Esc leaves it and
 * otherwise does nothing (it never collapses the window), Home resets the camera. The strip never
 * has keyboard focus, so it has none. Held keys and keys with Ctrl, Alt or the Windows key do
 * nothing.
 */
export function shortcutFor(
  event: Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "altKey" | "metaKey">,
  fullScreen: boolean,
): Shortcut | undefined {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return undefined;
  switch (event.key) {
    case "F11":
      return "toggle-full-screen";
    case "Escape":
      return fullScreen ? "leave-full-screen" : undefined;
    case "Home":
      return "reset-camera";
    default:
      return undefined;
  }
}
