/** The renderers draw at most at this pixel ratio; beyond it the cost isn't worth the sharpness. */
export const MAX_PIXEL_RATIO = 2;

/** What `followPixelRatio` needs of the window: enough to fake in tests. */
export interface PixelRatioSource {
  readonly devicePixelRatio: number;
  matchMedia(query: string): {
    addEventListener(type: "change", listener: () => void): void;
    removeEventListener(type: "change", listener: () => void): void;
  };
}

/**
 * Calls `apply` with the window's pixel ratio, capped, now and whenever it changes: when the
 * window moves to a monitor with another scale, or the scale changes (issue #55). Browsers have no
 * event for it, so this listens for the current ratio to stop matching. Returns a function that
 * stops listening.
 */
export function followPixelRatio(
  source: PixelRatioSource,
  apply: (ratio: number) => void,
): () => void {
  let query: ReturnType<PixelRatioSource["matchMedia"]> | undefined;
  const update = () => {
    query?.removeEventListener("change", update);
    const ratio = source.devicePixelRatio;
    query = source.matchMedia(`(resolution: ${ratio}dppx)`);
    query.addEventListener("change", update);
    apply(Math.min(ratio, MAX_PIXEL_RATIO));
  };
  update();
  return () => query?.removeEventListener("change", update);
}
