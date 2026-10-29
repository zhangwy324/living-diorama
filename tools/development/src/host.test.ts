import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { parseWorldSave } from "@living-diorama/content-schema";
import {
  envelope,
  openEnvelope,
  PROTOCOL_VERSION,
  runSimulationHost,
  type SimulationCommand,
  type SimulationMessage,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { createSimulation, loadContent } from "./simulation-run";

const WORLD_ID = "hollow:woodland-hollow";
const SPECIES_ID = "hollow:mossling";
const NOON = 12 * 60;

/** Runs the host against a fake port and a fake clock whose timers fire only in `advance`. */
function startHost(register = registerBuiltInContent) {
  let time = 0;
  let timers: { at: number; fn: () => void }[] = [];
  let handler: ((data: unknown) => void) | undefined;
  let closed = false;
  const received: SimulationMessage[] = [];
  runSimulationHost(
    {
      postMessage: (data) => {
        const message = openEnvelope<SimulationMessage>(data);
        if (!message) throw new Error("Host sent a message without a valid envelope");
        received.push(message);
      },
      onMessage: (h) => (handler = h),
    },
    {
      loadContent: () => loadContent(register),
      now: () => time,
      schedule: (fn, delayMs) => timers.push({ at: time + delayMs, fn }),
      close: () => (closed = true),
    },
  );
  const host = {
    received,
    get closed() {
      return closed;
    },
    sendRaw: (data: unknown) => handler?.(data),
    send: (command: SimulationCommand) => handler?.(envelope(command)),
    init: (seed = 1, minutes = NOON) =>
      host.send({
        type: "init",
        worldId: WORLD_ID,
        seed,
        tickRateHz: 10,
        maxCreatures: 20,
        minutes,
      }),
    /** Moves time forward, firing due timers in order. */
    advance(ms: number) {
      const end = time + ms;
      for (;;) {
        const next = timers.toSorted((a, b) => a.at - b.at)[0];
        if (!next || next.at > end) break;
        timers = timers.filter((t) => t !== next);
        time = next.at;
        next.fn();
      }
      time = end;
    },
    /** Moves time forward without firing timers, like a worker that was not scheduled. */
    stall: (ms: number) => (time += ms),
    take() {
      return received.splice(0);
    },
    snapshots: () => host.take().filter((m) => m.type === "snapshot"),
    errorCodes: () =>
      host.take().flatMap((m) => (m.type === "error" ? m.diagnostics.map((d) => d.code) : [])),
  };
  return host;
}

describe("simulation host", () => {
  it("answers init with ready and then sends a snapshot every tick", () => {
    const host = startHost();
    host.init();
    expect(host.take()).toMatchObject([{ type: "ready", worldId: WORLD_ID }]);
    host.advance(1000);
    const ticks = host.snapshots().map((m) => m.snapshot.tick);
    expect(ticks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("describes the world in ready, as plain data the main thread can draw", () => {
    const host = startHost();
    host.init();
    const [ready] = host.take();
    if (ready?.type !== "ready") throw new Error("Expected ready");
    // Exactly what postMessage would deliver: no classes, functions or shared references lost.
    expect(structuredClone(ready)).toEqual(ready);
    expect(ready.scene.terrain.heights.length).toBeGreaterThan(0);
    expect(ready.navigations).toHaveLength(1);
    const mossling = ready.species[SPECIES_ID];
    // The built-in mossling says no thickness, so it gets the default.
    expect(mossling).toEqual({
      appearance: expect.any(String),
      sizeClass: expect.any(String),
      body: { thickness: 0.4 },
    });
    expect(ready.assets[mossling!.appearance]).toMatchObject({ kind: "image" });
    for (const prop of ready.scene.props) expect(ready.assets[prop.model]).toBeDefined();
  });

  it("sends one snapshot per tick when it catches up", () => {
    const host = startHost();
    host.init();
    host.stall(450);
    host.advance(100);
    expect(host.snapshots().map((m) => m.snapshot.tick)).toEqual([1, 2, 3, 4, 5]);
  });

  it("applies a spawn before the next tick", () => {
    const host = startHost();
    host.init();
    host.take();
    host.send({ type: "spawn", speciesId: SPECIES_ID });
    expect(host.take()).toEqual([]);
    host.advance(100);
    const [first] = host.snapshots();
    expect(first?.snapshot.creatures).toHaveLength(1);
    expect(first?.events.map((e) => e.type)).toEqual(["creature_spawned", "species_introduced"]);
  });

  it("pauses and resumes, sending a snapshot for each", () => {
    const host = startHost();
    host.init();
    host.advance(300);
    host.take();
    host.send({ type: "pause" });
    host.advance(1000);
    expect(host.snapshots().map((m) => [m.snapshot.tick, m.snapshot.paused])).toEqual([[3, true]]);
    host.send({ type: "resume" });
    host.advance(1000);
    const resumed = host.snapshots();
    expect(resumed[0]?.snapshot).toMatchObject({ tick: 3, paused: false });
    expect(resumed.slice(1).map((m) => m.snapshot.tick)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("adds routes to snapshots while debug is on", () => {
    const host = startHost();
    host.init(3);
    host.send({ type: "spawn", speciesId: SPECIES_ID });
    host.advance(30_000);
    const walking = (on: boolean) =>
      host
        .snapshots()
        .some((m) =>
          m.snapshot.creatures.some(
            (c) => (c.route !== undefined) === on && c.currentAction === "core:follow_path",
          ),
        );
    expect(walking(false)).toBe(true);
    host.send({ type: "set_debug", enabled: true });
    host.advance(30_000);
    const snapshots = host.snapshots();
    const routed = snapshots.flatMap((m) => m.snapshot.creatures).filter((c) => c.route);
    expect(routed.length).toBeGreaterThan(0);
    expect(
      snapshots
        .flatMap((m) => m.snapshot.creatures)
        .filter((c) => c.currentAction === "core:follow_path" && !c.route),
    ).toEqual([]);
  });

  it("scales ticks by the speed multiplier", () => {
    const host = startHost();
    host.init();
    host.send({ type: "set_speed", multiplier: 2 });
    host.advance(100); // the command applies at the first wake-up
    host.take();
    host.advance(1000);
    expect(host.snapshots()).toHaveLength(20);
  });

  it("runs a dev speed of 60 at 60 times real time, past the speed-1 catch-up limit", () => {
    const host = startHost();
    host.init();
    host.send({ type: "set_speed", multiplier: 60 });
    host.advance(100);
    host.take();
    host.advance(1000);
    expect(host.snapshots()).toHaveLength(600);
  });

  it("rejects a speed above 100 and keeps the speed it had", () => {
    const host = startHost();
    host.init();
    host.send({ type: "set_speed", multiplier: 2 });
    host.send({ type: "set_speed", multiplier: 101 });
    host.advance(100);
    expect(host.errorCodes()).toEqual(["invalid_speed"]);
    host.take();
    host.advance(1000);
    expect(host.snapshots()).toHaveLength(20);
  });

  it("rejects commands it cannot apply and keeps running", () => {
    const host = startHost();
    host.send({ type: "pause" });
    host.sendRaw({ protocolVersion: 0, message: { type: "pause" } });
    expect(host.errorCodes()).toEqual(["not_initialized", "protocol_mismatch"]);
    host.init();
    host.init();
    host.send({ type: "set_speed", multiplier: 0 });
    host.sendRaw(envelope({ type: "dance" }));
    host.advance(100);
    const messages = host.take();
    expect(messages.map((m) => m.type)).toEqual(["ready", "error", "error", "error", "snapshot"]);
    expect(
      messages.flatMap((m) => (m.type === "error" ? m.diagnostics.map((d) => d.code) : [])),
    ).toEqual(["already_initialized", "invalid_speed", "unknown_command"]);
  });

  it("registers species, spawns and despawns on request, and answers each request", () => {
    const host = startHost();
    host.init();
    host.take();
    const species = {
      schemaVersion: 1,
      id: "user:puddle",
      version: "1.0.0",
      name: "Puddle",
      appearance: "user:puddle/appearance.png",
      sizeClass: "medium",
      body: { thickness: 0.6 },
      capabilities: { "core:walk": 1 },
      baseSpeed: 0.5,
      behaviors: ["core:wander"],
    };
    const appearanceUrl = "blob:http://localhost/puddle";
    host.send({ type: "register_species", requestId: "r1", species, appearanceUrl });
    host.send({ type: "spawn", requestId: "r2", speciesId: "user:puddle" });
    host.advance(100);
    const messages = host.take();
    expect(messages.slice(0, 2)).toEqual([
      {
        type: "species_registered",
        requestId: "r1",
        speciesId: "user:puddle",
        species: {
          appearance: species.appearance,
          sizeClass: "medium",
          body: { thickness: 0.6 },
        },
        asset: { kind: "image", url: appearanceUrl },
        limits: [],
      },
      { type: "spawned", requestId: "r2", creatureId: "creature-1" },
    ]);
    expect(messages.slice(0, 2).map((m) => structuredClone(m))).toEqual(messages.slice(0, 2));
    const [snapshot] = messages.filter((m) => m.type === "snapshot");
    expect(snapshot?.events.map((e) => e.type)).toEqual(["creature_spawned", "species_introduced"]);

    host.send({ type: "despawn", requestId: "r3", creatureId: "creature-1" });
    host.send({ type: "despawn", requestId: "r4", creatureId: "creature-1" });
    host.advance(100);
    const after = host.take();
    expect(after.slice(0, 2)).toEqual([
      { type: "despawned", requestId: "r3", creatureId: "creature-1" },
      {
        type: "rejected",
        requestId: "r4",
        command: "despawn",
        diagnostics: [expect.objectContaining({ code: "unknown_creature" })],
      },
    ]);
    const [next] = after.filter((m) => m.type === "snapshot");
    expect(next?.snapshot.creatures).toEqual([]);
    expect(next?.events.map((e) => e.type)).toEqual(["creature_despawned"]);
  });

  it("rejects requests it can't apply without stopping the world", () => {
    const host = startHost();
    host.init();
    host.take();
    host.send({
      type: "register_species",
      requestId: "bad",
      species: { id: "user:nothing" },
      appearanceUrl: "blob:x",
    });
    host.send({ type: "spawn", speciesId: "hollow:nobody" });
    host.advance(100);
    const messages = host.take();
    expect(messages.map((m) => m.type)).toEqual(["rejected", "rejected", "snapshot"]);
    expect(messages[0]).toMatchObject({ requestId: "bad", command: "register_species" });
    expect(messages[1]).toMatchObject({
      command: "spawn",
      diagnostics: [expect.objectContaining({ code: "unknown_species" })],
    });
    expect(messages[1]).not.toHaveProperty("requestId");
    host.advance(1000);
    expect(host.snapshots()).toHaveLength(10);
  });

  it("enforces the creature cap set by init", () => {
    const host = startHost();
    host.send({
      type: "init",
      worldId: WORLD_ID,
      seed: 1,
      tickRateHz: 10,
      maxCreatures: 2,
      minutes: NOON,
    });
    for (let n = 0; n < 3; n++) host.send({ type: "spawn", speciesId: SPECIES_ID });
    host.advance(100);
    const rejected = host.take().filter((m) => m.type === "rejected");
    expect(rejected).toEqual([
      {
        type: "rejected",
        command: "spawn",
        diagnostics: [
          expect.objectContaining({
            code: "world_full",
            message: "The world is full (2 creatures). Remove one to add another.",
          }),
        ],
      },
    ]);
  });

  it("stays idle when init fails", () => {
    const host = startHost();
    host.send({
      type: "init",
      worldId: "hollow:nowhere",
      seed: 1,
      tickRateHz: 10,
      maxCreatures: 20,
      minutes: NOON,
    });
    expect(host.errorCodes()).toEqual(["unknown_world"]);
    host.send({
      type: "init",
      worldId: WORLD_ID,
      seed: 1,
      tickRateHz: 0,
      maxCreatures: 20,
      minutes: NOON,
    });
    expect(host.errorCodes()).toEqual(["invalid_tick_rate"]);
    host.send({
      type: "init",
      worldId: WORLD_ID,
      seed: 1,
      tickRateHz: 10,
      maxCreatures: 0,
      minutes: NOON,
    });
    expect(host.errorCodes()).toEqual(["invalid_max_creatures"]);
    host.send({ type: "spawn", speciesId: SPECIES_ID });
    host.advance(1000);
    expect(host.errorCodes()).toEqual(["not_initialized"]);
  });

  it("stops on shutdown", () => {
    const host = startHost();
    host.init();
    host.send({ type: "shutdown" });
    host.advance(1000);
    expect(host.closed).toBe(true);
    expect(host.snapshots()).toEqual([]);
  });

  it("produces the same trajectory as driving the simulation directly", () => {
    const host = startHost();
    host.init(7);
    host.send({ type: "spawn", speciesId: SPECIES_ID });
    host.advance(30_000);
    const fromHost = host.snapshots().map((m) => m.snapshot);

    const direct = createSimulation({
      register: registerBuiltInContent,
      worldId: WORLD_ID,
      seed: 7,
    });
    direct.spawn(SPECIES_ID);
    const expected = fromHost.map(() => {
      direct.step();
      return direct.snapshot();
    });
    expect(fromHost).toHaveLength(300);
    expect(fromHost).toEqual(expected);
  });
});

describe("time of day in the host", () => {
  const phaseEvents = (messages: SimulationMessage[]) =>
    messages.flatMap((m) =>
      m.type === "snapshot" ? m.events.filter((e) => e.type === "day_phase_changed") : [],
    );

  it("starts at the time of day init carries, without announcing its phase", () => {
    const host = startHost();
    host.init(1, 19 * 60 + 30);
    host.advance(1000);
    const messages = host.take();
    expect(phaseEvents(messages)).toEqual([]);
    const snapshots = messages.flatMap((m) => (m.type === "snapshot" ? [m.snapshot] : []));
    expect(snapshots.map((s) => s.timeOfDay)).toEqual(Array(10).fill(19 * 60 + 30));
  });

  it("applies set_time_of_day at the next tick boundary, announcing the new phase there", () => {
    const host = startHost();
    host.init();
    host.advance(300);
    host.take();
    host.send({ type: "set_time_of_day", minutes: 20 * 60 + 5 });
    expect(host.take()).toEqual([]);
    host.advance(200);
    const messages = host.take();
    expect(
      messages.map((m) => (m.type === "snapshot" ? [m.snapshot.tick, m.snapshot.timeOfDay] : [])),
    ).toEqual([
      [4, 20 * 60 + 5],
      [5, 20 * 60 + 5],
    ]);
    // Day jumps straight to night: one event across dusk, on the first tick that sees it.
    expect(phaseEvents(messages)).toEqual([
      { type: "day_phase_changed", tick: 3, from: "day", to: "night" },
    ]);
    // Exactly what postMessage would deliver.
    for (const message of messages) expect(structuredClone(message)).toEqual(message);
  });

  it("announces nothing for a new time in the same phase, and wraps minutes into a day", () => {
    const host = startHost();
    host.init();
    host.send({ type: "set_time_of_day", minutes: 17 * 60 });
    host.advance(100);
    host.send({ type: "set_time_of_day", minutes: 24 * 60 + 9 * 60 });
    host.advance(100);
    const messages = host.take();
    expect(phaseEvents(messages)).toEqual([]);
    expect(messages.at(-1)).toMatchObject({ snapshot: { timeOfDay: 9 * 60 } });
  });

  it("shows a new time of day while paused", () => {
    const host = startHost();
    host.init();
    host.send({ type: "pause" });
    host.advance(100);
    host.take();
    host.send({ type: "set_time_of_day", minutes: 23 * 60 });
    host.advance(100);
    expect(host.snapshots().map((m) => [m.snapshot.paused, m.snapshot.timeOfDay])).toEqual([
      [true, 23 * 60],
    ]);
  });

  it("rejects a time of day that is not a number", () => {
    const host = startHost();
    host.init(1, Number.NaN);
    expect(host.errorCodes()).toEqual(["invalid_time_of_day"]);
    host.init();
    host.send({ type: "set_time_of_day", minutes: Number.POSITIVE_INFINITY });
    host.advance(100);
    expect(host.errorCodes()).toEqual(["invalid_time_of_day"]);
  });
});

describe("saving and restoring in the host", () => {
  const SAVED_AT = Date.UTC(2026, 9, 28, 19, 45);
  type Host = ReturnType<typeof startHost>;

  /** A host with three mosslings, run for `ms`, its messages so far taken. */
  function running(seed = 7, ms = 20_000) {
    const host = startHost();
    host.init(seed);
    for (let k = 0; k < 3; k++) host.send({ type: "spawn", speciesId: SPECIES_ID });
    host.advance(ms);
    host.take();
    return host;
  }

  /** Saves at the next wake-up; the save's JSON and every message of that wake-up. */
  function save(host: Host) {
    host.send({ type: "save", requestId: "save", savedAt: SAVED_AT });
    host.advance(100);
    const messages = host.take();
    const saved = messages.find((m) => m.type === "saved");
    if (saved?.type !== "saved") throw new Error(`Expected saved, got ${JSON.stringify(messages)}`);
    expect(saved.requestId).toBe("save");
    return { json: saved.json, messages };
  }

  const rejections = (messages: SimulationMessage[]) =>
    messages.flatMap((m) =>
      m.type === "rejected"
        ? [{ id: m.requestId, command: m.command, codes: m.diagnostics.map((d) => d.code) }]
        : [],
    );

  it("saves between ticks, after the commands sent before the save", () => {
    const host = startHost();
    host.init();
    host.advance(1000);
    host.take();
    host.send({ type: "spawn", speciesId: SPECIES_ID });
    const { json, messages } = save(host);
    expect(messages.map((m) => m.type)).toEqual(["spawned", "saved", "snapshot"]);
    const parsed = parseWorldSave(JSON.parse(json));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.value).toMatchObject({ savedAt: SAVED_AT, seed: 1, tick: 10, minutes: NOON });
    expect(parsed.value.creatures.map((c) => c.id)).toEqual(["creature-1"]);
  });

  it("saves while paused, without a tick", () => {
    const host = running();
    host.send({ type: "pause" });
    host.advance(100);
    const [paused] = host.snapshots();
    host.advance(5000);
    const { json, messages } = save(host);
    expect(messages.map((m) => m.type)).toEqual(["saved"]);
    expect(JSON.parse(json)).toMatchObject({ tick: paused?.snapshot.tick });
  });

  it("restores a save into another world, which carries on as if it never stopped", () => {
    const original = running(7);
    const { json, messages } = save(original);
    original.advance(3000);
    const unbroken = [...messages, ...original.take()].filter((m) => m.type === "snapshot");
    expect(unbroken.map((m) => m.snapshot.tick)).toEqual(
      Array.from({ length: 31 }, (_, k) => 201 + k),
    );

    const host = startHost();
    host.init(99);
    host.advance(500);
    host.take();
    host.send({
      type: "restore",
      requestId: "restore",
      json,
      nowMs: SAVED_AT + 1000,
      minutes: NOON,
    });
    host.advance(100);
    // Time owed to the replaced world doesn't tick: the restored one starts at the next wake-up.
    const restored = host.take();
    expect(restored).toMatchObject([
      {
        type: "restored",
        requestId: "restore",
        report: { gapMs: 1000, droppedCreatures: [], prunedPlacements: [] },
      },
    ]);
    expect(structuredClone(restored)).toEqual(restored);
    host.advance(3100);
    expect(host.take()).toEqual(unbroken);
  });

  it("shows the restored world at once while paused", () => {
    const { json } = save(running(7));
    const host = startHost();
    host.init(99);
    host.send({ type: "pause" });
    host.advance(100);
    host.take();
    host.send({ type: "restore", json, nowMs: SAVED_AT, minutes: 20 * 60 });
    host.advance(100);
    const messages = host.take();
    expect(messages.map((m) => m.type)).toEqual(["restored", "snapshot"]);
    const shown = messages[1];
    if (shown?.type !== "snapshot") throw new Error("Expected a snapshot");
    expect(shown.snapshot).toMatchObject({ tick: 200, paused: true, timeOfDay: 20 * 60 });
    expect(shown.snapshot.creatures.map((c) => c.id)).toEqual([
      "creature-1",
      "creature-2",
      "creature-3",
    ]);
  });

  it("rejects an unusable save, leaving the world running as it was", () => {
    const host = running(7, 5000);
    const { json: saved } = save(host);
    const valid = JSON.parse(saved) as Record<string, unknown>;
    const text = (value: unknown) => JSON.stringify(value);
    const unusable: [string, string[]?][] = [
      ["", ["invalid_save_json"]],
      ["{ not json", ["invalid_save_json"]],
      [saved.slice(0, -1), ["invalid_save_json"]],
      ['"not a save"'],
      ["null"],
      [text({})],
      [text([1, 2, 3])],
      [text({ ...valid, creatures: "many" })],
      [text({ ...valid, schemaVersion: 2 }), ["unsupported_save_version"]],
      [
        text({ ...valid, world: { id: "hollow:elsewhere", version: "1.0.0" } }),
        ["save_world_mismatch"],
      ],
      [text({ ...valid, nextCreature: 1 }), ["save_inconsistent"]],
    ];
    unusable.forEach(([json], k) =>
      host.send({ type: "restore", requestId: `r${k}`, json, nowMs: SAVED_AT, minutes: NOON }),
    );
    host.advance(100);
    const messages = host.take();
    const rejected = rejections(messages);
    expect(rejected.map((r) => [r.id, r.command])).toEqual(
      unusable.map((_, k) => [`r${k}`, "restore"]),
    );
    unusable.forEach(([, codes], k) => {
      expect(rejected[k]?.codes.length).toBeGreaterThan(0);
      if (codes) expect(rejected[k]?.codes).toEqual(codes);
    });
    expect(messages.some((m) => m.type === "error" || m.type === "restored")).toBe(false);
    // The world carries on from where it was, with its creatures.
    const snapshots = messages.filter((m) => m.type === "snapshot");
    expect(snapshots.map((m) => m.snapshot.tick)).toEqual([52]);
    expect(snapshots[0]?.snapshot.creatures).toHaveLength(3);
  });

  it("rejects a wall-clock time, time of day or save time it can't use", () => {
    const host = running(7, 1000);
    const { json } = save(host);
    const restore = (nowMs: number, minutes: number) =>
      host.send({ type: "restore", json, nowMs, minutes });
    restore(Number.NaN, NOON);
    restore(Number.POSITIVE_INFINITY, NOON);
    restore(SAVED_AT, Number.NaN);
    restore(SAVED_AT, Number.NEGATIVE_INFINITY);
    for (const savedAt of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      host.send({ type: "save", savedAt });
    }
    host.advance(100);
    const messages = host.take();
    const rejected = (command: string, code: string) => ({ id: undefined, command, codes: [code] });
    expect(rejections(messages)).toEqual([
      rejected("restore", "invalid_wall_clock"),
      rejected("restore", "invalid_wall_clock"),
      rejected("restore", "invalid_time_of_day"),
      rejected("restore", "invalid_time_of_day"),
      ...Array(4).fill(rejected("save", "invalid_saved_at")),
    ]);
    const ticks = messages.filter((m) => m.type === "snapshot").map((m) => m.snapshot.tick);
    expect(ticks).toEqual([12]);
  });

  it("is protocol version 10, and ignores a save sent with another", () => {
    expect(PROTOCOL_VERSION).toBe(10);
    const host = running(7, 1000);
    host.sendRaw({
      protocolVersion: PROTOCOL_VERSION - 1,
      message: { type: "save", savedAt: SAVED_AT },
    });
    host.advance(100);
    const messages = host.take();
    expect(messages.map((m) => m.type)).toEqual(["error", "snapshot"]);
    expect(messages[0]).toMatchObject({ diagnostics: [{ code: "protocol_mismatch" }] });
  });
});
