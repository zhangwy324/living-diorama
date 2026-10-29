import { expect, it } from "vitest";
import { anotherName, randomNameSeed, SUGGESTION_COUNT, suggestName } from "./name-suggestion";

it("suggests the same two-part name for the same seed", () => {
  expect(suggestName(7)).toBe(suggestName(7));
  expect(suggestName(7)).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
});

it("suggests different names for different seeds", () => {
  const names = new Set(Array.from({ length: 50 }, (_, seed) => suggestName(seed)));
  expect(names.size).toBeGreaterThan(40);
});

it("fits the name field and never pairs a word with itself", () => {
  for (let seed = 0; seed < SUGGESTION_COUNT * 4; seed++) {
    const name = suggestName(seed);
    expect(name.length).toBeLessThanOrEqual(40);
    const [first = "", second = ""] = name.toLowerCase().split(" ");
    expect(first.slice(0, 4)).not.toBe(second.slice(0, 4));
  }
});

it("moves to the next noun with the same adjective when a name is taken", () => {
  expect(suggestName(3, [suggestName(3)]).split(" ")[0]).toBe(suggestName(3).split(" ")[0]);
});

it("rerolls to a different name, skipping taken ones", () => {
  const seeds = [3, 3, 3, 8];
  const current = suggestName(3);
  const taken = [suggestName(8)];
  // Seed 3 repeats the current name and is skipped; seed 8 skips its taken name.
  expect(anotherName(current, taken, () => seeds.shift() ?? 0)).toBe(suggestName(8, taken));
  expect(suggestName(8, taken)).not.toBe(current);
});

it("settles for a repeat when every seed lands on the current name", () => {
  expect(anotherName(suggestName(3), [], () => 3)).toBe(suggestName(3));
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
