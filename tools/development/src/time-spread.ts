import { formatClockTime } from "@living-diorama/simulation";

/**
 * Earliest and latest of some times of day, in minutes since midnight, how far apart and how
 * many, e.g. "20:41–21:35 (54 min apart, 5×)"; `none` when there are none. `pnpm sim` uses it per
 * creature over the nights of a run, `pnpm soak` across a seed's creatures and across seeds.
 */
export function spread(times: readonly number[], none = "never"): string {
  if (times.length === 0) return none;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const range = `${formatClockTime(min)}–${formatClockTime(max)}`;
  return `${range} (${Math.round(max - min)} min apart, ${times.length}×)`;
}
