import { expect, it } from "vitest";
import { randomNameSeed, SUGGESTION_COUNT, suggestName } from "./name-suggestion";

it("suggests the same two-part name for the same seed", () => {
  expect(suggestName(7)).toBe(suggestName(7));
  expect(suggestName(7)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
});

it("suggests different names for different seeds", () => {
  const names = new Set(Array.from({ length: 50 }, (_, seed) => suggestName(seed)));
  expect(names.size).toBeGreaterThan(40);
});

it("fits the name field", () => {
  for (let seed = 0; seed < SUGGESTION_COUNT * 4; seed++) {
    expect(suggestName(seed).length).toBeLessThanOrEqual(40);
  }
});

it("skips names already in the library, whatever their case", () => {
  const first = suggestName(3);
  const next = suggestName(3, [` ${first.toUpperCase()} `]);
  expect(next).not.toBe(first);
  expect(suggestName(3, [first, next])).not.toBe(next);
});

it("still suggests a name when every name is taken", () => {
  const taken = new Set<string>();
  for (let i = 0; i < SUGGESTION_COUNT; i++) taken.add(suggestName(0, taken));
  expect(taken.size).toBe(SUGGESTION_COUNT);
  expect(suggestName(3, taken)).toBe(suggestName(3));
});

it("makes whole 32-bit seeds", () => {
  const seed = randomNameSeed();
  expect(Number.isInteger(seed)).toBe(true);
  expect(seed).toBeGreaterThanOrEqual(0);
  expect(seed).toBeLessThan(2 ** 32);
});
