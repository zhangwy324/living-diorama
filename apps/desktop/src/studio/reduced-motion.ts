import { useSyncExternalStore } from "react";

// Whether the player asked the system for less motion (`prefers-reduced-motion`), followed live.

const QUERY = "(prefers-reduced-motion: reduce)";

const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** True while the system asks for reduced motion. */
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
