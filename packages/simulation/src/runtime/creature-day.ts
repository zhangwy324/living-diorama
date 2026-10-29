import type { Rng } from "./rng";
import { dayPhaseAt, WORLD_PHASE_STARTS, type DayPhase, type PhaseStarts } from "./time-of-day";

// A creature's own day (issue #85): the world's day phases with their starts moved by an offset
// the creature draws each day, so its bedtime and waking vary from night to night within a
// bounded window. Everything that asks a creature's day phase (its behaviors and actions, the
// day-phase decision trigger, catch-up) asks it here, through `creaturePhaseAt`.

/** A day's offset is drawn uniformly within this many minutes either way. */
export const DAY_SHIFT_MINUTES = 30;

/**
 * A creature's own day, plain data in its state. One offset a day moves the phases' starts: drawn
 * at the start of the creature's dawn, it moves that evening's dusk and night at once, and the
 * next dawn and day once its night has begun. So no start moves while the creature is near it,
 * and a new draw never puts it back into the phase it has just left.
 */
export interface CreatureDay {
  /** Its phase as of the last tick, to notice when it changes. */
  phase: DayPhase;
  /** Minutes by which its dawn and day start late (negative: early). */
  morning: number;
  /** This day's offset, drawn at its dawn, which moves its dusk and night; until then `morning`. */
  evening?: number;
}

/** A day's offset, uniformly within `DAY_SHIFT_MINUTES` either way. */
export const drawDayShift = (rng: Rng) => rng.range(-DAY_SHIFT_MINUTES, DAY_SHIFT_MINUTES);

/**
 * Where each phase of the creature's day starts, in minutes since midnight: the baseline, the
 * world's day, moved by its offsets. The one place a creature's day departs from the world's, so
 * a baseline that moves its sleep (issue #101) belongs here, as absolute starts of its own.
 */
export function creaturePhaseStarts(day: Omit<CreatureDay, "phase">): PhaseStarts {
  const base = WORLD_PHASE_STARTS;
  const evening = day.evening ?? day.morning;
  return {
    dawn: base.dawn + day.morning,
    day: base.day + day.morning,
    dusk: base.dusk + evening,
    night: base.night + evening,
  };
}

/** The creature's phase at `minutes` since midnight, by `creaturePhaseStarts`. */
export function creaturePhaseAt(day: Omit<CreatureDay, "phase">, minutes: number): DayPhase {
  return dayPhaseAt(minutes, creaturePhaseStarts(day));
}

/**
 * Brings `day` up to `minutes`: from its dawn on, it draws the day's offset from `rng` if not yet
 * drawn; from its night on, that offset moves the next morning too. Sets `phase` and returns
 * whether it changed. `rng` is asked for only when a draw is due. Depends only on the phase, not
 * on how the time of day got there, so a jump of the clock settles too.
 */
export function settleDay(day: CreatureDay, minutes: number, rng: () => Rng): boolean {
  const before = day.phase;
  let phase = creaturePhaseAt(day, minutes);
  if ((phase === "dawn" || phase === "day") && day.evening === undefined) {
    day.evening = drawDayShift(rng());
    phase = creaturePhaseAt(day, minutes);
  }
  if (phase === "night" && day.evening !== undefined) {
    day.morning = day.evening;
    delete day.evening;
    phase = creaturePhaseAt(day, minutes);
  }
  day.phase = phase;
  return phase !== before;
}
