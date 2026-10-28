import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  envelope,
  openEnvelope,
  runSimulationHost,
  type SimulationCommand,
  type SimulationMessage,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { createSimulation, loadContent } from "./simulation-run";

const WORLD_ID = "hollow:woodland-hollow";
const SPECIES_ID = "hollow:mossling";

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
    init: (seed = 1) =>
      host.send({ type: "init", worldId: WORLD_ID, seed, tickRateHz: 10, maxCreatures: 20 }),
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
    host.send({ type: "init", worldId: WORLD_ID, seed: 1, tickRateHz: 10, maxCreatures: 2 });
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
    });
    expect(host.errorCodes()).toEqual(["unknown_world"]);
    host.send({ type: "init", worldId: WORLD_ID, seed: 1, tickRateHz: 0, maxCreatures: 20 });
    expect(host.errorCodes()).toEqual(["invalid_tick_rate"]);
    host.send({ type: "init", worldId: WORLD_ID, seed: 1, tickRateHz: 10, maxCreatures: 0 });
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
