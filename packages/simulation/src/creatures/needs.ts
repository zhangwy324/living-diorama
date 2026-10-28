import type { NeedType, SenseType, TraitType } from "@living-diorama/extension-api";

// The core needs, senses and traits (ADR 0018 §1, §4 and its amendments). They are data only:
// nothing reads them yet. All numbers are starting values, to tune once creatures use them.

/** Rises from 0 to 1 in 90 minutes awake, at a tenth of that asleep, so creatures sleep the night. */
const HUNGER_HOURS_TO_FULL = 1.5;

/**
 * Rises from 0 to 1 in 18 hours awake, so a creature up at dawn reaches `actAt` 0.9 only near
 * midnight and dusk, not tiredness, sends it to bed. Falls to 0 in 8 hours asleep.
 */
const TIREDNESS_HOURS_TO_FULL = 18;
const TIREDNESS_HOURS_TO_RESTED = 8;

export const coreNeeds: NeedType[] = [
  {
    id: "core:hunger",
    version: "1.0.0",
    perHour: { awake: 1 / HUNGER_HOURS_TO_FULL, asleep: 1 / HUNGER_HOURS_TO_FULL / 10 },
    actAt: 0.4,
    triggers: [0.4, 0.9, 1],
    cue: { cue: "hungry", from: 0.8 },
    atMax: { speedFactor: 0.8 },
  },
  {
    id: "core:tiredness",
    version: "1.0.0",
    perHour: { awake: 1 / TIREDNESS_HOURS_TO_FULL, asleep: -1 / TIREDNESS_HOURS_TO_RESTED },
    actAt: 0.9,
    triggers: [0.9],
  },
];

export const coreSenses: SenseType[] = [
  /** Range in metres. */
  { id: "core:vision", version: "1.0.0", default: 8, min: 1, max: 30 },
];

export const coreTraits: TraitType[] = [
  /** 0 sleeps at night, 1 sleeps by day. Only 0 and 1 are used for now. */
  { id: "core:nocturnal", version: "1.0.0", default: 0, min: 0, max: 1 },
  /** Scales how fast hunger rises. */
  { id: "core:appetite", version: "1.0.0", default: 1, min: 0.5, max: 2 },
];
