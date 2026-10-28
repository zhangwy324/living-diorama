import { expect, it } from "vitest";
import { followPixelRatio, type PixelRatioSource } from "./pixel-ratio";

/** A window whose ratio the test sets; a change notifies the query for the old ratio only. */
function fakeWindow(ratio: number) {
  const listeners = new Map<string, Set<() => void>>();
  const source = {
    devicePixelRatio: ratio,
    matchMedia(query: string) {
      const set = listeners.get(query) ?? new Set();
      listeners.set(query, set);
      return {
        addEventListener: (_: string, listener: () => void) => {
          set.add(listener);
        },
        removeEventListener: (_: string, listener: () => void) => {
          set.delete(listener);
        },
      };
    },
  };
  const setRatio = (next: number) => {
    const old = `(resolution: ${source.devicePixelRatio}dppx)`;
    source.devicePixelRatio = next;
    for (const listener of [...(listeners.get(old) ?? [])]) listener();
  };
  const listening = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { source: source satisfies PixelRatioSource, setRatio, listening };
}

it("applies the ratio now and on every change, capped at 2", () => {
  const window = fakeWindow(2);
  const applied: number[] = [];
  followPixelRatio(window.source, (ratio) => applied.push(ratio));
  // Moved from the 200% monitor to the 100% one, then to a 300% one and back.
  window.setRatio(1);
  window.setRatio(3);
  window.setRatio(1.5);
  expect(applied).toEqual([2, 1, 2, 1.5]);
  expect(window.listening()).toBe(1);
});

it("stops listening", () => {
  const window = fakeWindow(1);
  const applied: number[] = [];
  const stop = followPixelRatio(window.source, (ratio) => applied.push(ratio));
  stop();
  window.setRatio(2);
  expect(applied).toEqual([1]);
  expect(window.listening()).toBe(0);
});
