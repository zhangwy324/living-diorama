import { creaturePhaseStarts, settleDay, type CreatureDay } from "./creature-day";
import type { Rng } from "./rng";
import {
  dayPhaseAt,
  minutesToNextPhase,
  wrapMinutes,
  WORLD_PHASE_STARTS,
  type DayPhase,
  type PhaseStarts,
} from "./time-of-day";

// Catch-up after a gap (ADR 0018 §19, ADR 0019 §5, §6): when a saved world is restored in real
// time mode, the wall-clock time it was away is not simulated. The world is set to a plausible
// state for the present instead. This module holds the gap rules; the simulation applies them
// to each creature, and behaviors set their needs through their `catchUp` hooks.

/** The longest gap caught up; a longer one counts as this long. */
export const CATCH_UP_CAP_MS = 12 * 60 * 60 * 1000;
/** A shorter gap is no gap: the world resumes exactly, and only the time of day jumps (§6). */
export const SHORT_GAP_MS = 2 * 60 * 1000;

/**
 * Why a restore did no catch-up: the clock didn't move forwards (`no_gap`) or the gap was under
 * 2 minutes (`short_gap`).
 */
export type CatchUpSkip = "no_gap" | "short_gap";

/** Whether a restore catches up, and over how long a gap. */
export type CatchUpPlan = { apply: true; gapMs: number } | { apply: false; reason: CatchUpSkip };

/**
 * The catch-up rules, in real time mode, for a world saved at `savedAt` and restored at `nowMs`.
 */
export function planCatchUp(savedAt: number, nowMs: number): CatchUpPlan {
  const gapMs = nowMs - savedAt;
  if (!(gapMs > 0)) return { apply: false, reason: "no_gap" };
  if (gapMs < SHORT_GAP_MS) return { apply: false, reason: "short_gap" };
  return { apply: true, gapMs: Math.min(gapMs, CATCH_UP_CAP_MS) };
}

/** Time a gap spent in one day phase. */
export interface PhaseSpan {
  readonly phase: DayPhase;
  readonly hours: number;
}

/**
 * The day phases a gap of `gapMs` ending at `toMinutes` (the present time of day) passed through,
 * oldest first, with the hours spent in each. The gap is taken to end now rather than to start at
 * the saved time of day, so a capped gap covers the hours just before the present, and a clock
 * change since the save (a time zone, daylight saving) can't put the two out of step. `starts`,
 * by default the world's, hold throughout.
 */
export function phaseSpans(
  toMinutes: number,
  gapMs: number,
  starts: PhaseStarts = WORLD_PHASE_STARTS,
): PhaseSpan[] {
  return spans(
    toMinutes,
    gapMs,
    (at) => dayPhaseAt(at, starts),
    (at) => minutesToNextPhase(at, starts),
  );
}

/**
 * The phases of a creature's own day (issue #85) that a gap passed through, as `phaseSpans`
 * has them for the world. `day` is its day as saved; it is brought through the gap as each tick
 * would have, drawing from `rng` the offset of a dawn the gap passed, and left as of the present.
 */
export function creaturePhaseSpans(
  day: CreatureDay,
  toMinutes: number,
  gapMs: number,
  rng: () => Rng,
): PhaseSpan[] {
  const phaseAt = (at: number) => {
    settleDay(day, at, rng);
    return day.phase;
  };
  const result = spans(toMinutes, gapMs, phaseAt, (at) =>
    minutesToNextPhase(at, creaturePhaseStarts(day)),
  );
  settleDay(day, toMinutes, rng);
  return result;
}

function spans(
  toMinutes: number,
  gapMs: number,
  phaseAt: (minutes: number) => DayPhase,
  toNext: (minutes: number) => number,
): PhaseSpan[] {
  const spans: { phase: DayPhase; minutes: number }[] = [];
  let remaining = gapMs / 60_000;
  let at = wrapMinutes(toMinutes - remaining);
  while (remaining > 1e-9) {
    const phase = phaseAt(at);
    const minutes = Math.min(remaining, toNext(at));
    const last = spans.at(-1);
    if (last?.phase === phase) last.minutes += minutes;
    else spans.push({ phase, minutes });
    remaining -= minutes;
    at = wrapMinutes(at + minutes);
  }
  return spans.map(({ phase, minutes }) => ({ phase, hours: minutes / 60 }));
}
