import { expect, it } from "vitest";
import { formatForLog } from "./log";

it("joins a console call's arguments the way the console shows them", () => {
  expect(formatForLog(["Could not load", "hollow:tree", 3, { size: 2 }, null, undefined])).toBe(
    'Could not load hollow:tree 3 {"size":2} null undefined',
  );
});

it("keeps an error's stack", () => {
  const error = new Error("no WebGL");
  expect(formatForLog(["The view failed", error])).toBe(`The view failed ${error.stack}`);
});

it("falls back to String for values JSON cannot hold", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(formatForLog([cyclic, 10n])).toBe("[object Object] 10");
});
