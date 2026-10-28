import type { NeedType, SenseType, TraitType } from "@living-diorama/extension-api";

// The core needs, senses and traits (ADR 0018 §1, §4 and its amendments). They are data; the
// engine and behaviors read them. All numbers are starting values, to tune.

/** Rises from 0 to 1 in 90 minutes awake, at a tenth of that asleep, so creatures sleep the night. */
const HUNGER_HOURS_TO_FULL = 1.5;

/**
 * Rises from 0 to 1 in 18 hours awake, so a creature up at dawn reaches `actAt` 0.9 only near
 * midnight and dusk, not tiredness, sends it to bed. Falls to 0 in 8 hours asleep.
 */
const TIREDNESS_HOURS_TO_FULL = 18;
const TIREDNESS_HOURS_TO_RESTED = 8;

/** Individuals differ by up to 15% in need rates and vision range (ADR 0018 §16). */
const INDIVIDUAL_VARIATION = 0.15;

/** Hunger: what `core:feed` acts on and `core:eat` lowers. */
export const hungerNeed: NeedType = {
  id: "core:hunger",
  version: "1.0.0",
  perHour: { awake: 1 / HUNGER_HOURS_TO_FULL, asleep: 1 / HUNGER_HOURS_TO_FULL / 10 },
  actAt: 0.4,
  triggers: [0.4, 0.9, 1],
  cue: { cue: "hungry", from: 0.8 },
  atMax: { speedFactor: 0.8 },
  rateTrait: "core:appetite",
  variation: INDIVIDUAL_VARIATION,
};

export const coreNeeds: NeedType[] = [
  hungerNeed,
  {
    id: "core:tiredness",
    version: "1.0.0",
    perHour: { awake: 1 / TIREDNESS_HOURS_TO_FULL, asleep: -1 / TIREDNESS_HOURS_TO_RESTED },
    actAt: 0.9,
    triggers: [0.9],
    variation: INDIVIDUAL_VARIATION,
  },
];

export const coreSenses: SenseType[] = [
  /** Range in metres. */
  {
    id: "core:vision",
    version: "1.0.0",
    default: 8,
    min: 1,
    max: 30,
    variation: INDIVIDUAL_VARIATION,
  },
];

export const coreTraits: TraitType[] = [
  /** 0 sleeps at night, 1 sleeps by day. */
  { id: "core:nocturnal", version: "1.0.0", default: 0, min: 0, max: 1, integer: true },
  /** Scales how fast hunger rises. */
  { id: "core:appetite", version: "1.0.0", default: 1, min: 0.5, max: 2 },
];
