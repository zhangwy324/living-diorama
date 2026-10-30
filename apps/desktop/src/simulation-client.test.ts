import { defaultBody } from "@living-diorama/content-schema";
import {
  envelope,
  openEnvelope,
  runSimulationHost,
  type CatchUpReport,
  type SimulationCommand,
  type SimulationMessage,
  type SimulationSnapshot,
  type WorldContent,
} from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { loadContent } from "./content";
import {
  creatureCap,
  parseCountOverride,
  startSimulation,
  type WorkerLike,
} from "./simulation-client";
import { STARTUP } from "./startup";
import type { WallClock } from "./time-of-day";

/** A wall clock that stays at `minutes` until changed, with no timers. */
function stillClock(minutes: { now: number }): WallClock {
  return {
    now: () => minutes.now * 60_000,
    minutesAt: (ms) => ms / 60_000,
    every: () => () => {},
    onVisible: () => () => {},
  };
}

/**
 * A worker that runs the real host in this thread; its timers fire only in `tick`. Its wall clock
 * is `wallNow`, which by default stands still.
 */
function fakeWorker(wallNow = () => 0) {
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
      wallNow,
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
  capabilities: { "core:land": 1 },
  baseSpeed: 0.5,
  behaviors: ["core:wander"],
};

function start(countOverride?: number, time = { now: 12 * 60 }) {
  // The worker reads the same wall clock as the main thread.
  const { worker, tick } = fakeWorker(() => time.now * 60_000);
  const callbacks = {
    onReady: vi.fn(),
    onSpeciesRegistered: vi.fn(),
    onRestored: vi.fn(),
    onCaughtUp: vi.fn<(report: CatchUpReport) => void>(),
    onWorldChanged: vi.fn<(content: Pick<WorldContent, "scene" | "navigations">) => void>(),
    onSnapshot: vi.fn<(snapshot: SimulationSnapshot) => void>(),
    onFailure: vi.fn(),
  };
  const client = startSimulation(callbacks, STARTUP, worker, countOverride, stillClock(time));
  return { client, callbacks, tick, worker };
}

describe("simulation client", () => {
  const creaturesShown = (callbacks: ReturnType<typeof start>["callbacks"]) =>
    callbacks.onSnapshot.mock.calls.at(-1)?.[0].creatures ?? [];

  it("starts the world empty, then spawns the starting creatures when asked", async () => {
    const { client, callbacks, tick } = start();
    expect(callbacks.onReady).toHaveBeenCalledOnce();
    tick(100);
    expect(creaturesShown(callbacks)).toHaveLength(0);
    const spawning = client.spawnStartingCreatures();
    tick(100);
    await spawning;
    const starting = STARTUP.creatures.reduce((sum, c) => sum + c.count, 0);
    expect(creaturesShown(callbacks)).toHaveLength(starting);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("saves the world and restores it into another one", async () => {
    const first = start();
    const spawning = first.client.spawnStartingCreatures();
    first.tick(100);
    await spawning;
    const saving = first.client.save();
    first.tick(100);
    const saved = await saving;
    if (!saved.ok) throw new Error("save failed");
    const ids = creaturesShown(first.callbacks).map((c) => c.id);

    const second = start();
    const restoring = second.client.restore(saved.value);
    second.tick(100);
    const restored = await restoring;
    expect(restored.ok && restored.value.droppedCreatures).toEqual([]);
    expect(second.callbacks.onRestored).toHaveBeenCalledOnce();
    second.tick(100);
    expect(creaturesShown(second.callbacks).map((c) => c.id)).toEqual(ids);
    expect(second.callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("reports the new scene after an edit and after restoring an edited world", async () => {
    const first = start();
    // Nothing in the app sends edits yet (ADR 0021, PR 6), so this goes straight to the worker.
    const edit = { ops: [{ op: "prop.add", prop: "hollow:rock", position: { x: 5, z: -5 } }] };
    first.worker.postMessage(envelope<SimulationCommand>({ type: "edit", edit }));
    first.tick(100);
    const hasRock = (content: Pick<WorldContent, "scene"> | undefined) =>
      content?.scene.props.some((p) => p.id === "prop-1");
    expect(first.callbacks.onWorldChanged).toHaveBeenCalledOnce();
    expect(hasRock(first.callbacks.onWorldChanged.mock.calls[0]?.[0])).toBe(true);
    const saving = first.client.save();
    first.tick(100);
    const saved = await saving;
    if (!saved.ok) throw new Error("save failed");

    const second = start();
    const restoring = second.client.restore(saved.value);
    second.tick(100);
    expect((await restoring).ok).toBe(true);
    expect(second.callbacks.onWorldChanged).toHaveBeenCalledOnce();
    expect(hasRock(second.callbacks.onWorldChanged.mock.calls[0]?.[0])).toBe(true);
  });

  it("resolves a rejected restore with its diagnostics", async () => {
    const { client, callbacks, tick } = start();
    const restoring = client.restore("{not json");
    tick();
    const restored = await restoring;
    expect(restored.ok ? [] : restored.diagnostics.map((d) => d.code)).toEqual([
      "invalid_save_json",
    ]);
    expect(callbacks.onRestored).not.toHaveBeenCalled();
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it.each([0, 25])(
    "starts with %i of each starting species under a count override",
    async (count) => {
      const { client, callbacks, tick } = start(count);
      const spawning = client.spawnStartingCreatures();
      tick(100);
      await spawning;
      tick(100);
      const [snapshot] = callbacks.onSnapshot.mock.calls.at(-1) ?? [];
      expect(snapshot?.creatures).toHaveLength(count * STARTUP.creatures.length);
      expect(callbacks.onFailure).not.toHaveBeenCalled();
    },
  );

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
      { appearance: drawn.appearance, sizeClass: "medium", body: defaultBody() },
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

  it("sends the time of day at init, on resume and when fixed", () => {
    const time = { now: 21 * 60 };
    const { client, callbacks, tick } = start(0, time);
    const shown = () => callbacks.onSnapshot.mock.calls.at(-1)?.[0].timeOfDay;
    tick(100);
    expect(shown()).toBe(21 * 60);
    client.setPaused(true);
    time.now = 22 * 60 + 30;
    client.setPaused(false);
    tick(100);
    expect(shown()).toBe(22 * 60 + 30);
    client.fixTimeOfDay(6 * 60);
    client.setSpeed(2);
    tick(100);
    expect(shown()).toBe(6 * 60);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("follows the clock on snapshots, with no timer firing", () => {
    const time = { now: 21 * 60 };
    const { callbacks, tick } = start(0, time);
    const shown = () => callbacks.onSnapshot.mock.calls.at(-1)?.[0].timeOfDay;
    tick(100);
    time.now = 21 * 60 + 1;
    // This snapshot's check sends the new minute, which the next tick shows.
    tick(100);
    tick(100);
    expect(shown()).toBe(21 * 60 + 1);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("catches the world up after the OS slept with it running, at the time of day now", () => {
    const time = { now: 21 * 60 };
    const { callbacks, tick } = start(0, time);
    tick(100);
    tick(100);
    // Three hours asleep; the worker's monotonic clock may not have moved at all.
    time.now += 3 * 60;
    tick(100);
    expect(callbacks.onCaughtUp).not.toHaveBeenCalled();
    tick(100);
    // Lost: the wall-clock gap less the one tick simulated across it.
    expect(callbacks.onCaughtUp.mock.calls).toEqual([
      [{ applied: true, gapMs: 3 * 3_600_000 - 100, failures: [] }],
    ]);
    tick(100);
    const shown = callbacks.onSnapshot.mock.calls.at(-1)?.[0];
    expect(shown?.timeOfDay).toBe(0);
    // On from tick 3 by the gap, with no tick at the wake-up that caught up, then one more.
    expect(shown?.tick).toBe(3 + (3 * 3_600_000 - 100) / 100 + 1);
    for (let k = 0; k < 10; k++) tick(100);
    expect(callbacks.onCaughtUp).toHaveBeenCalledOnce();
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("counts no lost time across a change from a very slow dev speed", () => {
    const time = { now: 21 * 60 };
    const { client, callbacks, tick } = start(0, time);
    tick(100);
    client.setSpeed(0.0005);
    // At this speed a tick takes 200 s; the speed goes back to 1 after 150 s, mid-tick.
    tick(0);
    time.now += 150 / 60;
    tick(150_000);
    client.setSpeed(1);
    for (let k = 0; k < 10; k++) tick(100);
    expect(callbacks.onCaughtUp).not.toHaveBeenCalled();
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  it("catches up nothing for an OS sleep while paused, nor on resuming", () => {
    const time = { now: 21 * 60 };
    const { client, callbacks, tick } = start(0, time);
    tick(100);
    client.setPaused(true);
    tick(100);
    time.now += 3 * 60;
    tick(100);
    client.setPaused(false);
    for (let k = 0; k < 10; k++) tick(100);
    expect(callbacks.onCaughtUp).not.toHaveBeenCalled();
    expect(callbacks.onSnapshot.mock.calls.at(-1)?.[0].timeOfDay).toBe(0);
    expect(callbacks.onFailure).not.toHaveBeenCalled();
  });

  describe("a restore pending", () => {
    /** A worker the test answers by hand, recording the commands the client sends. */
    function scripted() {
      const sent: SimulationCommand[] = [];
      const worker: WorkerLike = {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        postMessage: (data: unknown) => {
          const command = openEnvelope<SimulationCommand>(data);
          if (command) sent.push(command);
        },
        terminate: () => {},
      };
      const reply = (message: SimulationMessage) =>
        worker.onmessage?.(new MessageEvent("message", { data: envelope(message) }));
      const callbacks = { onReady: vi.fn(), onSnapshot: vi.fn(), onFailure: vi.fn() };
      const client = startSimulation(callbacks, STARTUP, worker, 0, stillClock({ now: 12 * 60 }));
      reply({ type: "ready", worldId: STARTUP.worldId } as SimulationMessage);
      /** A running snapshot at simulation time `timeMs`, sent at wall-clock `wallMs`. */
      const snapshot = (timeMs: number, wallMs: number) =>
        reply({
          type: "snapshot",
          snapshot: { tick: timeMs / 100, timeMs, paused: false, timeOfDay: 720, creatures: [] },
          events: [],
          wallMs,
        });
      const catchUps = () => sent.filter((c) => c.type === "catch_up");
      const idOf = (type: SimulationCommand["type"]) =>
        (sent.findLast((c) => c.type === type) as { requestId?: string } | undefined)?.requestId;
      return { client, callbacks, reply, snapshot, catchUps, idOf };
    }
    const HOUR = 3_600_000;

    it.each(["restored", "rejected"] as const)(
      "catches up none of the replaced world's lost time, then works again once %s",
      async (answer) => {
        const { client, callbacks, reply, snapshot, catchUps, idOf } = scripted();
        snapshot(0, 0);
        snapshot(100, 100);
        const restoring = client.restore("{}");
        // Snapshots of the world being replaced, sent before the worker applied the restore, one
        // after the OS slept for three hours.
        snapshot(200, 200);
        snapshot(300, 3 * HOUR);
        snapshot(400, 3 * HOUR + 100);
        expect(catchUps()).toEqual([]);

        const requestId = idOf("restore");
        reply(
          answer === "restored"
            ? ({ type: "restored", requestId, report: {} } as SimulationMessage)
            : { type: "rejected", requestId, command: "restore", diagnostics: [] },
        );
        await restoring;
        snapshot(500, 3 * HOUR + 200);
        snapshot(600, 3 * HOUR + 300);
        expect(catchUps()).toEqual([]);
        // The OS sleeps again, now with the world the restore left.
        snapshot(700, 6 * HOUR);
        expect(catchUps()).toMatchObject([{ gapMs: 6 * HOUR - (3 * HOUR + 300) - 100 }]);
        expect(callbacks.onFailure).not.toHaveBeenCalled();
      },
    );

    it("forgets lost time counted before the restore was sent", async () => {
      const { client, reply, snapshot, catchUps, idOf } = scripted();
      snapshot(0, 0);
      snapshot(100, 100);
      const restoring = client.restore("{}");
      // Rejected before any snapshot, so the wait is over when the next one comes.
      reply({ type: "rejected", requestId: idOf("restore"), command: "restore", diagnostics: [] });
      await restoring;
      // Its gap is measured from the last snapshot before the restore: that baseline is gone.
      snapshot(200, 3 * HOUR);
      expect(catchUps()).toEqual([]);
    });

    it("keeps waiting when another request is rejected", () => {
      const { client, reply, snapshot, catchUps, idOf } = scripted();
      snapshot(0, 0);
      void client.restore("{}");
      void client.despawn("nobody");
      reply({ type: "rejected", requestId: idOf("despawn"), command: "despawn", diagnostics: [] });
      snapshot(100, 100);
      snapshot(200, 3 * HOUR);
      expect(catchUps()).toEqual([]);
    });
  });

  it("ignores messages that arrive after it stopped", () => {
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: () => {},
      terminate: () => {},
    };
    let listeners = 0;
    const clock: WallClock = {
      ...stillClock({ now: 12 * 60 }),
      every: () => (listeners++, () => listeners--),
      onVisible: () => (listeners++, () => listeners--),
    };
    const onReady = vi.fn();
    const callbacks = { onReady, onSnapshot: vi.fn(), onFailure: vi.fn() };
    const client = startSimulation(callbacks, STARTUP, worker, 0, clock);
    client.stop();
    // A `ready` the worker sent before it was terminated.
    worker.onmessage?.(
      new MessageEvent("message", { data: envelope({ type: "ready", worldId: "x" }) }),
    );
    expect(onReady).not.toHaveBeenCalled();
    expect(listeners).toBe(0);
  });

  it("checks the limits of a size without registering a species", async () => {
    const { client, callbacks, tick } = start();
    const checking = client.checkLimits("large", { "core:land": 1 });
    const amphibian = client.checkLimits("small", { "core:land": 1, "core:swim": 1 });
    const unknown = client.checkLimits("large", { "core:fly": 1 });
    tick();
    const checked = await checking;
    const bridge = checked.ok
      ? checked.value.limits.filter((d) => d.code === "portal_unusable")
      : [];
    expect(bridge.map((d) => d.structure)).toEqual([
      { id: "bridge", name: "Wooden bridge" },
      { id: "bridge", name: "Wooden bridge" },
    ]);
    // With the rules of the capabilities asked about, as the engine registered them.
    expect(checked.ok && Object.keys(checked.value.locomotion)).toEqual(["core:land"]);
    const both = await amphibian;
    expect(both.ok && Object.keys(both.value.locomotion)).toEqual(["core:land", "core:swim"]);
    expect(both.ok && both.value.locomotion["core:swim"]).toMatchObject({
      animation: "swim",
      submersion: 0.5,
    });
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
