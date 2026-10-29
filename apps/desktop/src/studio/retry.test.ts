import { afterEach, describe, expect, it, vi } from "vitest";
import { keepTrying, retryDelay } from "./retry";

afterEach(() => vi.useRealTimers());

describe("asking again", () => {
  it("waits longer after each failure, up to a cap", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  });

  it("asks again after a failure until it succeeds", async () => {
    vi.useFakeTimers();
    const attempt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("timed out"))
      .mockRejectedValueOnce(new Error("timed out"))
      .mockResolvedValue(undefined);
    const onFailure = vi.fn();
    keepTrying(attempt, onFailure);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("stops asking once stopped, also with a failure still to come", async () => {
    vi.useFakeTimers();
    let fail: (error: Error) => void = () => {};
    const attempt = vi.fn(() => new Promise<void>((_, reject) => (fail = reject)));
    const onFailure = vi.fn();
    const stop = keepTrying(attempt, onFailure);
    fail(new Error("timed out"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(2);
    stop();
    fail(new Error("timed out"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
