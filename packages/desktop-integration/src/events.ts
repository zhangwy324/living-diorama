import { listen } from "@tauri-apps/api/event";

/** The strip's window label (ADR 0008). */
export const STRIP_WINDOW = "main";
/** The Creation Studio's window label (ADR 0015 §1). */
export const STUDIO_WINDOW = "studio";

/**
 * Listens to a Tauri event sent to the window labelled `target` (or to every window). `listen`
 * alone hears events sent to any window, so each window names its own label (ADR 0015 §5).
 * Resolves once listening; the function it resolves with stops listening.
 */
export async function listenAs<T>(
  target: string,
  event: string,
  listener: (payload: T) => void,
): Promise<() => void> {
  return listen<T>(event, (e) => listener(e.payload), { target });
}

/** Like `listenAs`, but the returned function stops listening even before `listen` resolves. */
export function subscribeAs<T>(
  target: string,
  event: string,
  listener: (payload: T) => void,
): () => void {
  const unlisten = listenAs(target, event, listener);
  return () => void unlisten.then((stop) => stop());
}
