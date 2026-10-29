import { describe, expect, it } from "vitest";
import { creaturePhaseSpans, phaseSpans } from "./catch-up";
import {
  creaturePhaseAt,
  creaturePhaseStarts,
  DAY_SHIFT_MINUTES,
  settleDay,
  type CreatureDay,
} from "./creature-day";
import { Rng } from "./rng";
import {
  DAY_PHASES,
  dayPhaseAt,
  MINUTES_PER_DAY,
  minutesToNextPhase,
  WORLD_PHASE_STARTS,
  type PhaseStarts,
} from "./time-of-day";

const at = (hours: number, minutes = 0) => hours * 60 + minutes;

describe("day phases from starts of their own", () => {
  const starts = (moved: Partial<PhaseStarts>): PhaseStarts => ({
    ...WORLD_PHASE_STARTS,
    ...moved,
  });

  it("puts each phase from its own start to the next, wherever they are", () => {
    const late = starts({ dawn: at(6, 20), dusk: at(17, 45) });
    expect(dayPhaseAt(at(6, 19), late)).toBe("night");
    expect(dayPhaseAt(at(6, 20), late)).toBe("dawn");
    expect(dayPhaseAt(at(17, 44), late)).toBe("day");
    expect(dayPhaseAt(at(17, 45), late)).toBe("dusk");
    expect(minutesToNextPhase(at(6, 10), late)).toBe(10);
    expect(minutesToNextPhase(at(17, 50), late)).toBe(130);
    // Far from the world's, as a user's baseline might be (#101): night from midnight.
    const owl = starts({ dusk: at(22), night: at(24) });
    expect(dayPhaseAt(at(23, 59), owl)).toBe("dusk");
    expect(dayPhaseAt(at(0), owl)).toBe("night");
    expect(minutesToNextPhase(at(21), owl)).toBe(60);
    expect(minutesToNextPhase(at(23), owl)).toBe(60);
  });

  it("agrees with itself for arbitrary offsets: the phase changes where the next start is", () => {
    // Full-precision offsets, unlike the stream's multiples of 60 / 2^32.
    let k = 0;
    const offset = () => ((++k * 0.6180339887498949) % 1) * 60 - 30;
    for (let n = 0; n < 2_000; n++) {
      const day = { morning: offset(), evening: offset() };
      const own = creaturePhaseStarts(day);
      for (const phase of DAY_PHASES) {
        // At its moved start, a phase has begun, and the next start is a whole phase away.
        const start = own[phase];
        expect(dayPhaseAt(start, own)).toBe(phase);
        const to = minutesToNextPhase(start, own);
        expect(to).toBeGreaterThan(30);
        expect(to).toBeLessThan(MINUTES_PER_DAY - 30);
      }
      const now = offset() * 48 + 720;
      const gapMs = (offset() + 30) * 12 * 60_000 + 1;
      const spans = phaseSpans(now, gapMs, own);
      expect(spans.at(-1)?.phase).toBe(dayPhaseAt(now, own));
      expect(spans.reduce((h, s) => h + s.hours, 0)).toBeCloseTo(gapMs / 3_600_000, 6);
      const walked: CreatureDay = { phase: creaturePhaseAt(day, now - gapMs / 60_000), ...day };
      const ownSpans = creaturePhaseSpans(walked, now, gapMs, () => Rng.fromSeed(n));
      expect(ownSpans.at(-1)?.phase).toBe(walked.phase);
      expect(walked.phase).toBe(creaturePhaseAt(walked, now));
    }
  });

  it("gives the world's day by default", () => {
    for (let m = 0; m < 24 * 60; m += 7) {
      expect(dayPhaseAt(m, starts({}))).toBe(dayPhaseAt(m));
      expect(minutesToNextPhase(m, starts({}))).toBe(minutesToNextPhase(m));
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
    expect(creaturePhaseStarts(still).dawn).toBe(WORLD_PHASE_STARTS.dawn);
    expect(creaturePhaseStarts(still).dusk).toBe(WORLD_PHASE_STARTS.dusk + still.evening!);
  });
});
