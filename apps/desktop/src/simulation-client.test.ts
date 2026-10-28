import { runSimulationHost, type SimulationSnapshot } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { loadContent } from "./content";
import {
  creatureCap,
  parseCountOverride,
  startSimulation,
  type WorkerLike,
} from "./simulation-client";
import { STARTUP } from "./startup";

/** A worker that runs the real host in this thread; its timers fire only in `tick`. */
function fakeWorker() {
  let time = 0;
  let timers: (() => void)[] = [];
  let toHost: ((data: unknown) => void) | undefined;
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (data: unknown) => toHost?.(structuredClone(data)),
    terminate: () => (timers = []),
  };
  runSimulationHost(
    {
      postMessage: (data) =>
        worker.onmessage?.(new MessageEvent("message", { data: structuredClone(data) })),
      onMessage: (handler) => (toHost = handler),
    },
    {
      loadContent,
      now: () => time,
      schedule: (callback) => timers.push(callback),
    },
  );
  return {
    worker,
    /** Moves time forward by `ms` and runs one host wake-up, which applies queued commands. */
    tick(ms = 0) {
      time += ms;
      const due = timers;
      timers = [];
      for (const fn of due) fn();
    },
  };
}

const drawn = {
  schemaVersion: 1,
  id: "user:puddle",
  version: "1.0.0",
  name: "Puddle",
  appearance: "user:puddle/appearance.png",
  sizeClass: "medium",
  capabilities: { "core:walk": 1 },
  baseSpeed: 0.5,
  behaviors: ["core:wander"],
};

function start(countOverride?: number) {
  const { worker, tick } = fakeWorker();
  const callbacks = {
    onReady: vi.fn(),
    onSpeciesRegistered: vi.fn(),
    onSnapshot: vi.fn<(snapshot: SimulationSnapshot) => void>(),
    onFailure: vi.fn(),
  };
  const client = startSimulation(callbacks, STARTUP, worker, countOverride);
  return { client, callbacks, tick };
}

describe("simulation client", () => {
  it("starts the world and spawns the starting creatures", () => {
    const { callbacks, tick } = start();
    expect(callbacks.onReady).toHaveBeenCalledOnce();
    tick(100);
    const [snapshot] = callbacks.onSnapshot.mock.calls.at(-1) ?? [];
    const starting = STARTUP.creatures.reduce((sum, c) => sum + c.count, 0);
    expect(snapshot?.creatures).toHaveLength(starting);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it.each([0, 25])("starts with %i of each starting species under a count override", (count) => {
    const { callbacks, tick } = start(count);
    tick(100);
    const [snapshot] = callbacks.onSnapshot.mock.calls.at(-1) ?? [];
    expect(snapshot?.creatures).toHaveLength(count * STARTUP.creatures.length);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("registers a species, then spawns and despawns its creature", async () => {
    const { client, callbacks, tick } = start();
    const registering = client.registerSpecies(drawn, "blob:http://localhost/puddle");
    tick();
    await expect(registering).resolves.toEqual({
      ok: true,
      value: { speciesId: "user:puddle", limits: [] },
    });
    expect(callbacks.onSpeciesRegistered).toHaveBeenCalledWith(
      "user:puddle",
      { appearance: drawn.appearance, sizeClass: "medium", body: { thickness: 0.4 } },
      { kind: "image", url: "blob:http://localhost/puddle" },
    );

    const spawning = client.spawn("user:puddle");
    tick();
    const spawned = await spawning;
    expect(spawned.ok).toBe(true);
    const despawning = client.despawn(spawned.ok ? spawned.value : "");
    tick();
    await expect(despawning).resolves.toEqual(spawned);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("resolves rejected requests with diagnostics instead of failing", async () => {
    const { client, callbacks, tick } = start();
    const registering = client.registerSpecies({ ...drawn, behaviors: [] }, "blob:x");
    const despawning = client.despawn("creature-404");
    tick();
    const registered = await registering;
    expect(registered.ok ? [] : registered.diagnostics.map((d) => d.code)).toEqual(["too_small"]);
    const despawned = await despawning;
    expect(despawned.ok ? [] : despawned.diagnostics.map((d) => d.code)).toEqual([
      "unknown_creature",
    ]);
    expect(callbacks.onSpeciesRegistered).not.toHaveBeenCalled();
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("checks the limits of a size without registering a species", async () => {
    const { client, callbacks, tick } = start();
    const checking = client.checkLimits("large", { "core:walk": 1 });
    const unknown = client.checkLimits("large", { "core:fly": 1 });
    tick();
    const checked = await checking;
    const bridge = checked.ok ? checked.value.filter((d) => d.code === "portal_unusable") : [];
    expect(bridge.map((d) => d.structure)).toEqual([
      { id: "bridge", name: "Wooden bridge" },
      { id: "bridge", name: "Wooden bridge" },
    ]);
    const rejected = await unknown;
    expect(rejected.ok ? [] : rejected.diagnostics.map((d) => d.code)).toEqual([
      "unknown_capability",
    ]);
    expect(callbacks.onSpeciesRegistered).not.toHaveBeenCalled();
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });
});

describe("creatureCap", () => {
  it("is the startup cap, raised by a larger count override", () => {
    expect(creatureCap(STARTUP, undefined)).toBe(20);
    expect(creatureCap(STARTUP, 0)).toBe(20);
    expect(creatureCap(STARTUP, 5)).toBe(20);
    expect(creatureCap({ ...STARTUP, creatures: [{ speciesId: "a:b", count: 2 }] }, 30)).toBe(30);
  });
});

describe("parseCountOverride", () => {
  it("reads a whole number from 0, and nothing from an unset or empty variable", () => {
    expect(parseCountOverride(undefined)).toBeUndefined();
    expect(parseCountOverride("")).toBeUndefined();
    expect(parseCountOverride(" ")).toBeUndefined();
    expect(parseCountOverride("0")).toBe(0);
    expect(parseCountOverride("20")).toBe(20);
  });

  it("ignores anything else, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const raw of ["-1", "2.5", "many"]) expect(parseCountOverride(raw)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});
