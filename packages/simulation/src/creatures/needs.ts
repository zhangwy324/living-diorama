import type { NeedType, SenseType, TraitType } from "@living-diorama/extension-api";

// The core needs, senses and traits (ADR 0018 §1, §4 and its amendments). They are data; the
// engine and behaviors read them. All numbers are starting values, to tune.

/** Rises from 0 to 1 in 90 minutes awake. */
const HUNGER_HOURS_TO_FULL = 1.5;
/**
 * Asleep, hunger rises at a fifteenth of its awake rate: about 0.44 over a 10-hour night. A
 * creature goes to bed with hunger below about `actAt` 0.4, so it almost always reaches dawn short
 * of the trigger at 0.9 that wakes a sleeper (ADR 0018 §13), and now and then is hungry enough to
 * show the bubble.
 */
const HUNGER_ASLEEP_FACTOR = 1 / 15;

/**
 * Rises from 0 to 1 in 18 hours awake, so a creature up at dawn reaches `actAt` 0.9 only near
 * midnight and dusk, not tiredness, sends it to bed. Falls to 0 in 8 hours asleep.
 */
const TIREDNESS_HOURS_TO_FULL = 18;
const TIREDNESS_HOURS_TO_RESTED = 8;
/**
 * A spawned creature starts with tiredness below this, as if it had just woken, so even one
 * spawned at dawn reaches `actAt` 0.9 no earlier than dusk and bedtime follows the night (§13).
 * Drawn below `actAt`, one spawned by day close to 0.9 napped at once, and a nap that ran into
 * the evening lasted until dawn.
 */
const TIREDNESS_START_BELOW = 0.1;

/** Individuals differ by up to 15% in need rates and vision range (ADR 0018 §16). */
const INDIVIDUAL_VARIATION = 0.15;

/** Hunger: what `core:feed` acts on and `core:eat` lowers. */
export const hungerNeed: NeedType = {
  id: "core:hunger",
  version: "1.0.0",
  perHour: { awake: 1 / HUNGER_HOURS_TO_FULL, asleep: HUNGER_ASLEEP_FACTOR / HUNGER_HOURS_TO_FULL },
  actAt: 0.4,
  triggers: [0.4, 0.9, 1],
  cue: { cue: "hungry", from: 0.8 },
  atMax: { speedFactor: 0.8 },
  rateTrait: "core:appetite",
  variation: INDIVIDUAL_VARIATION,
};

/** Tiredness: what `core:rest` acts on and sleeping lowers. */
export const tirednessNeed: NeedType = {
  id: "core:tiredness",
  version: "1.0.0",
  perHour: { awake: 1 / TIREDNESS_HOURS_TO_FULL, asleep: -1 / TIREDNESS_HOURS_TO_RESTED },
  actAt: 0.9,
  triggers: [0.9],
  startBelow: TIREDNESS_START_BELOW,
  variation: INDIVIDUAL_VARIATION,
};

export const coreNeeds: NeedType[] = [hungerNeed, tirednessNeed];

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
