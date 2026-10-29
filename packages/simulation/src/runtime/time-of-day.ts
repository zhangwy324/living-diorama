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

/**
 * Where each phase starts, in minutes since midnight; it runs until the next one starts. A
 * creature's own day (issue #85) has starts of its own, derived from these.
 */
export type PhaseStarts = Readonly<Record<DayPhase, number>>;

/** The world's day: dawn 06–08, day 08–18, dusk 18–20, night 20–06. */
export const WORLD_PHASE_STARTS: PhaseStarts = {
  dawn: 6 * 60,
  day: 8 * 60,
  dusk: 18 * 60,
  night: 20 * 60,
};

/** The starts, wrapped into a day and in the order the day passes them from midnight. */
function startTable(starts: PhaseStarts): (readonly [number, DayPhase])[] {
  return DAY_PHASES.map((p) => [wrapMinutes(starts[p]), p] as const).sort(([x], [y]) => x - y);
}

const WORLD_TABLE = startTable(WORLD_PHASE_STARTS);
const tableFor = (starts: PhaseStarts) =>
  starts === WORLD_PHASE_STARTS ? WORLD_TABLE : startTable(starts);

/** Wraps any finite number of minutes into [0, MINUTES_PER_DAY). */
export function wrapMinutes(minutes: number): number {
  const wrapped = minutes % MINUTES_PER_DAY;
  // `+ 0` turns -0 into 0.
  const positive = (wrapped < 0 ? wrapped + MINUTES_PER_DAY : wrapped) + 0;
  // A tiny negative remainder rounds to a whole day when the day is added back.
  return positive >= MINUTES_PER_DAY ? 0 : positive;
}

/**
 * The phase at `minutes` since midnight: the one whose start (of `starts`, by default the
 * world's) was passed last.
 */
export function dayPhaseAt(minutes: number, starts: PhaseStarts = WORLD_PHASE_STARTS): DayPhase {
  const m = wrapMinutes(minutes);
  const table = tableFor(starts);
  // Before the first start of the day, the last one's phase runs on from yesterday.
  let phase = (table.at(-1) as readonly [number, DayPhase])[1];
  for (const [start, p] of table) if (m >= start) phase = p;
  return phase;
}

/**
 * Minutes from `minutes` since midnight to the next start of `starts` (by default the world's),
 * more than 0. It and `dayPhaseAt` compare against the same starts, so the phase changes there.
 */
export function minutesToNextPhase(
  minutes: number,
  starts: PhaseStarts = WORLD_PHASE_STARTS,
): number {
  const m = wrapMinutes(minutes);
  const table = tableFor(starts);
  const next = table.find(([start]) => start > m)?.[0];
  // Past the last start, the next phase starts with the first one tomorrow.
  return (next ?? (table[0]?.[0] ?? 0) + MINUTES_PER_DAY) - m;
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
