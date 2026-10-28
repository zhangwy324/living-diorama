import { describe, expect, it } from "vitest";
import {
  dayPhaseAt,
  formatClockTime,
  minutesAfter,
  parseClockTime,
  wrapMinutes,
} from "./time-of-day";

const at = (hours: number, minutes = 0) => hours * 60 + minutes;

describe("time of day", () => {
  it.each([
    [at(0), "night"],
    [at(5, 59), "night"],
    [at(6), "dawn"],
    [at(7, 59), "dawn"],
    [at(8), "day"],
    [at(17, 59), "day"],
    [at(18), "dusk"],
    [at(19, 59), "dusk"],
    [at(20), "night"],
    [at(23, 59), "night"],
  ])("puts minute %i in the %s", (minutes, phase) => {
    expect(dayPhaseAt(minutes)).toBe(phase);
  });

  it("treats a phase boundary as the start of the next phase, to the fraction of a minute", () => {
    expect(dayPhaseAt(at(7, 59) + 0.999)).toBe("dawn");
    expect(dayPhaseAt(at(8))).toBe("day");
  });

  it("wraps minutes around midnight both ways", () => {
    expect(wrapMinutes(at(24))).toBe(0);
    expect(wrapMinutes(at(25, 30))).toBe(at(1, 30));
    expect(wrapMinutes(-30)).toBe(at(23, 30));
    expect(Object.is(wrapMinutes(-at(24)), 0)).toBe(true);
    expect(dayPhaseAt(at(24 + 7))).toBe("dawn");
    expect(dayPhaseAt(-at(3))).toBe("night");
  });

  it("derives the time of day from simulation time, across midnight", () => {
    expect(minutesAfter(at(12), 0)).toBe(at(12));
    expect(minutesAfter(at(12), 90 * 60_000)).toBe(at(13, 30));
    expect(minutesAfter(at(23), 2 * 3_600_000)).toBe(at(1));
  });

  it("parses and formats clock times", () => {
    expect(parseClockTime("21:30")).toBe(at(21, 30));
    expect(parseClockTime(" 6:05 ")).toBe(at(6, 5));
    expect(parseClockTime("00:00")).toBe(0);
    for (const bad of ["24:00", "12:60", "12", "noon", "1:2", "-1:00"]) {
      expect(parseClockTime(bad)).toBeUndefined();
    }
    expect(formatClockTime(at(6, 5))).toBe("06:05");
    expect(formatClockTime(at(24) + 1.7)).toBe("00:01");
  });
});
