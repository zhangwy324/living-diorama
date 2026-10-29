import { describe, expect, it } from "vitest";
import { creaturePhaseSpans, phaseSpans } from "./catch-up";
import {
  creaturePhaseAt,
  creatureShift,
  DAY_SHIFT_MINUTES,
  settleDay,
  type CreatureDay,
} from "./creature-day";
import { Rng } from "./rng";
import { DAY_PHASES, dayPhaseAt, minutesToNextPhase } from "./time-of-day";

const at = (hours: number, minutes = 0) => hours * 60 + minutes;

describe("shifted day phases", () => {
  const shift = (minutes: Partial<Record<string, number>>) => (phase: string) =>
    minutes[phase] ?? 0;

  it("moves each phase's start on its own, either way", () => {
    const late = shift({ dawn: 20, dusk: -15 });
    expect(dayPhaseAt(at(6, 19), late)).toBe("night");
    expect(dayPhaseAt(at(6, 20), late)).toBe("dawn");
    expect(dayPhaseAt(at(17, 44), late)).toBe("day");
    expect(dayPhaseAt(at(17, 45), late)).toBe("dusk");
    expect(dayPhaseAt(at(20), late)).toBe("night");
    expect(dayPhaseAt(at(12), shift({ day: -59 }))).toBe("day");
  });

  it("counts minutes to the next moved start", () => {
    const moved = shift({ dawn: 20, day: 20, dusk: -15, night: -15 });
    expect(minutesToNextPhase(at(6, 10), moved)).toBe(10);
    expect(minutesToNextPhase(at(7), moved)).toBe(80);
    // Already in its dusk, from 17:45: its night starts at 19:45.
    expect(minutesToNextPhase(at(17, 50), moved)).toBe(115);
    expect(minutesToNextPhase(at(23), moved)).toBe(7 * 60 + 20);
  });

  it("leaves the world's day alone without a shift", () => {
    for (let m = 0; m < 24 * 60; m += 7) {
      expect(dayPhaseAt(m, () => 0)).toBe(dayPhaseAt(m));
      expect(minutesToNextPhase(m, () => 0)).toBeCloseTo(minutesToNextPhase(m), 9);
    }
  });
});

describe("a creature's own day", () => {
  /** A stream that counts how often it is asked for. */
  function counted(seed = 1) {
    const asked = { count: 0 };
    const rng = () => {
      asked.count++;
      return Rng.fromSeed(seed + asked.count);
    };
    return { rng, asked };
  }

  it("draws the day's offset at its dawn, once, and moves the next morning at its night", () => {
    const { rng, asked } = counted();
    const day: CreatureDay = { phase: "night", morning: 10 };
    // Its dawn starts at 06:10.
    expect(settleDay(day, at(6, 5), rng)).toBe(false);
    expect(day.evening).toBeUndefined();
    expect(settleDay(day, at(6, 10), rng)).toBe(true);
    expect(day.phase).toBe("dawn");
    const evening = day.evening!;
    expect(Math.abs(evening)).toBeLessThanOrEqual(DAY_SHIFT_MINUTES);
    // Drawn once a day, however often it is settled.
    for (let m = at(6, 10); m < at(17); m += 13) settleDay(day, m, rng);
    expect(asked.count).toBe(1);
    expect(day).toEqual({ phase: "day", morning: 10, evening });
    // Its dusk and night start by the new offset; the night carries it into the next morning.
    expect(creaturePhaseAt(day, at(18) + evening - 0.01)).toBe("day");
    expect(creaturePhaseAt(day, at(18) + evening)).toBe("dusk");
    settleDay(day, at(20) + evening, rng);
    expect(day).toEqual({ phase: "night", morning: evening });
    expect(creaturePhaseAt(day, at(6) + evening)).toBe("dawn");
  });

  it("never puts a creature back into the phase it has just left", () => {
    for (let seed = 1; seed < 200; seed++) {
      const { rng } = counted(seed);
      const day: CreatureDay = { phase: "dusk", morning: (seed % 61) - 30 };
      let last = day.phase;
      let changes = 0;
      for (let m = at(19); m < at(19) + 3 * 24 * 60; m += 0.5) {
        settleDay(day, m, rng);
        // Only forwards, one phase at a time: four changes a day.
        const step = (DAY_PHASES.indexOf(day.phase) - DAY_PHASES.indexOf(last) + 4) % 4;
        expect(step === 0 || step === 1).toBe(true);
        if (step === 1) changes++;
        last = day.phase;
      }
      expect(changes).toBe(12);
    }
  });

  it("walks a gap as the ticks would have, and leaves the day as of the present", () => {
    const saved: CreatureDay = { phase: "night", morning: -20 };
    // 22:00 to 09:00: night from its start, dawn from 05:40, day from 07:40.
    const day = { ...saved };
    const spans = creaturePhaseSpans(day, at(9), 11 * 60 * 60_000, () => Rng.fromSeed(5));
    expect(spans.map((s) => s.phase)).toEqual(["night", "dawn", "day"]);
    expect(spans[0]!.hours).toBeCloseTo(7 + 40 / 60, 9);
    expect(spans[1]!.hours).toBeCloseTo(2, 9);
    expect(spans[2]!.hours).toBeCloseTo(1 + 20 / 60, 9);
    expect(day.phase).toBe("day");
    expect(day.evening).toBeDefined();
    // As each tick would have left it.
    const ticked = { ...saved };
    for (let m = at(22); m <= at(24 + 9); m += 1) settleDay(ticked, m, () => Rng.fromSeed(5));
    expect(ticked).toEqual(day);
    // The world's spans are those of a day moved by nothing.
    const still: CreatureDay = { phase: "night", morning: 0, evening: 0 };
    expect(
      creaturePhaseSpans(still, at(9), 11 * 60 * 60_000, () => Rng.fromSeed(5)).map((s) => s.phase),
    ).toEqual(phaseSpans(at(9), 11 * 60 * 60_000).map((s) => s.phase));
    // Its morning stayed; the gap's dawn drew the evening to come.
    expect(creatureShift(still)("dawn")).toBe(0);
    expect(creatureShift(still)("dusk")).toBe(still.evening);
  });
});
