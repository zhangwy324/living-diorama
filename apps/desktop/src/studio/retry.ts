/** The first wait before asking again, doubled after each further failure up to `RETRY_MAX_MS`. */
export const RETRY_FIRST_MS = 1000;
export const RETRY_MAX_MS = 8000;

/** How long to wait after the `failures`th failure in a row (from 1). */
export const retryDelay = (failures: number) =>
  Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS);

/**
 * Runs `attempt` until it succeeds, waiting longer after each failure (`retryDelay`) and passing
 * each failure to `onFailure`. A request the strip couldn't answer in time, e.g. while the world
 * is still starting, is asked again. Returns a function that stops it; a late answer is still
 * handled by `attempt` itself, so it must check whether it is still wanted.
 */
export function keepTrying(
  attempt: () => Promise<void>,
  onFailure: (error: unknown) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const run = () => {
    attempt().catch((error: unknown) => {
      if (stopped) return;
      onFailure(error);
      failures += 1;
      timer = setTimeout(run, retryDelay(failures));
    });
  };
  run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
