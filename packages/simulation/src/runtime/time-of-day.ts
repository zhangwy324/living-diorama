// Time of day (ADR 0018 §5): an input to the simulation, never a clock read. The main thread
// sends local minutes since midnight; headless runs derive them from simulation time. The
// simulation maps them to four phases, and everything downstream reads only those.

import { DayPhaseSchema } from "@living-diorama/content-schema";

export const MINUTES_PER_DAY = 24 * 60;

/**
 * The phases in the order a day passes through them, from dawn. The save schema's list is the
 * single source of truth, so a saved `dayPhase` is always one the simulation knows.
 */
export type DayPhase = (typeof DayPhaseSchema.options)[number];
export const DAY_PHASES: readonly DayPhase[] = DayPhaseSchema.options;

/** Where each phase starts, in minutes since midnight; it runs until the next one starts. */
const PHASE_STARTS: readonly (readonly [number, DayPhase])[] = [
  [6 * 60, "dawn"],
  [8 * 60, "day"],
  [18 * 60, "dusk"],
  [20 * 60, "night"],
];

/** Wraps any finite number of minutes into [0, MINUTES_PER_DAY). */
export function wrapMinutes(minutes: number): number {
  const wrapped = minutes % MINUTES_PER_DAY;
  // `+ 0` turns -0 into 0.
  const positive = (wrapped < 0 ? wrapped + MINUTES_PER_DAY : wrapped) + 0;
  // A tiny negative remainder rounds to a whole day when the day is added back.
  return positive >= MINUTES_PER_DAY ? 0 : positive;
}

/**
 * How many minutes later than in the world's day each phase starts (negative: earlier), e.g. in a
 * creature's own day (issue #85). Each must be under an hour either way, half the shortest phase,
 * so the phases keep their order and length stays positive.
 */
export type PhaseShift = (phase: DayPhase) => number;

/** Where `phase` starts in the world's day, in minutes since midnight. */
function phaseStart(phase: DayPhase): number {
  return PHASE_STARTS.find(([, p]) => p === phase)?.[0] ?? 0;
}

function phaseAfter(phase: DayPhase, steps: number): DayPhase {
  const n = DAY_PHASES.length;
  return DAY_PHASES[(((DAY_PHASES.indexOf(phase) + steps) % n) + n) % n] ?? phase;
}

/**
 * The phase at `minutes` since midnight: dawn 06–08, day 08–18, dusk 18–20, night 20–06, with
 * each phase's start moved by `shift` if given.
 */
export function dayPhaseAt(minutes: number, shift?: PhaseShift): DayPhase {
  const m = wrapMinutes(minutes);
  let phase: DayPhase = "night";
  for (const [start, p] of PHASE_STARTS) if (m >= start) phase = p;
  if (!shift) return phase;
  // Still before this phase's moved start, or already past the next one's.
  if (wrapMinutes(m - phaseStart(phase)) < shift(phase)) return phaseAfter(phase, -1);
  const next = phaseAfter(phase, 1);
  return wrapMinutes(phaseStart(next) - m) <= -shift(next) ? next : phase;
}

/**
 * Minutes from `minutes` since midnight to the start of the next phase, more than 0, with each
 * phase's start moved by `shift` if given.
 */
export function minutesToNextPhase(minutes: number, shift?: PhaseShift): number {
  const m = wrapMinutes(minutes);
  if (shift) {
    const next = phaseAfter(dayPhaseAt(m, shift), 1);
    const to = wrapMinutes(phaseStart(next) + shift(next) - m);
    return to > 0 ? to : MINUTES_PER_DAY;
  }
  const next = PHASE_STARTS.find(([start]) => start > m)?.[0];
  // Past the last start, the next phase starts with the first one tomorrow.
  return (next ?? (PHASE_STARTS[0]?.[0] ?? 0) + MINUTES_PER_DAY) - m;
}

/**
 * The time of day `elapsedMs` of simulation time after `startMinutes`, for runs with no main
 * thread to send it (headless runs and tests).
 */
export function minutesAfter(startMinutes: number, elapsedMs: number): number {
  return wrapMinutes(startMinutes + elapsedMs / 60_000);
}

/** Parses a 24-hour clock time such as `"21:30"` or `"6:05"` into minutes since midnight. */
export function parseClockTime(text: string): number | undefined {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

/** Formats minutes since midnight as a 24-hour clock time, e.g. `"21:30"`. */
export function formatClockTime(minutes: number): string {
  const m = Math.floor(wrapMinutes(minutes));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
