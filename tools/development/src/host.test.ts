import { builtInDefinitions, registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  defaultBody,
  parseWorldSave,
  WORLD_SAVE_SCHEMA_VERSION,
} from "@living-diorama/content-schema";
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
const HOUR = 3_600_000;

/** The fake wall clock's time at the fake monotonic clock's 0. */
const WALL_START = Date.UTC(2026, 9, 28, 12);

/**
 * Runs the host against a fake port and fake clocks whose timers fire only in `advance`: a
 * monotonic one and a wall clock that moves with it, and on its own in `sleep`.
 */
function startHost(register = registerBuiltInContent) {
  let time = 0;
  let slept = 0;
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
      wallNow: () => WALL_START + time + slept,
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
        // A timer overdue after a stall fires now, not in the past.
        time = Math.max(time, next.at);
        next.fn();
      }
      time = end;
    },
    /** Moves time forward without firing timers, like a worker that was not scheduled. */
    stall: (ms: number) => (time += ms),
    /** Moves only the wall clock forward, as an OS sleep may leave the monotonic one. */
    sleep: (ms: number) => (slept += ms),
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
    // The built-in mossling is a voxel walker: only the locomotion of its body plan is sent.
    expect(mossling).toEqual({
      appearance: expect.any(String),
      sizeClass: "medium",
      body: { locomotion: { land: { gait: "walk" } } },
    });
    expect(ready.assets[mossling!.appearance]).toMatchObject({ kind: "voxel" });
    for (const prop of ready.scene.props) expect(ready.assets[prop.model]).toBeDefined();
  });

  it("lists the registered voxel parts by ID, cubes and all", () => {
    const part = (id: string, name: string) => ({
      schemaVersion: 1,
      id,
      version: "1.2.0",
      name,
      part: {
        type: "hollow:leg",
        size: { x: 1, y: 2, z: 1 },
        step: 0.05,
        colors: ["#7fae5a"],
        voxels: [2, 1],
        attach: { x: 0.5, y: 2, z: 0.5 },
        sockets: [],
      },
    });
    const host = startHost((registries) => [
      ...registerBuiltInContent(registries),
      registries.parts.register(part("test:stump-leg", "Stump leg")),
      registries.parts.register(part("mod:long-leg", "Long leg")),
    ]);
    host.init();
    const [ready] = host.take();
    if (ready?.type !== "ready") throw new Error("Expected ready");
    // Sorted by ID, after the built-in pack's starter parts.
    const ids = ready.parts.map(({ id }) => id);
    expect(ids).toEqual([...ids].sort());
    expect(
      ready.parts
        .filter(({ id }) => !id.startsWith("hollow:"))
        .map(({ id, name, version }) => [id, name, version]),
    ).toEqual([
      ["mod:long-leg", "Long leg", "1.2.0"],
      ["test:stump-leg", "Stump leg", "1.2.0"],
    ]);
    expect(ready.parts.find(({ id }) => id === "test:stump-leg")?.part).toEqual(
      part("test:stump-leg", "Stump leg").part,
    );
    expect(structuredClone(ready.parts)).toEqual(ready.parts);
  });

  it("lists the part types with their names, fits and roles, and the socket types, by ID", () => {
    const host = startHost();
    host.init();
    const [ready] = host.take();
    if (ready?.type !== "ready") throw new Error("Expected ready");
    expect(ready.partTypes).toContainEqual({
      id: "hollow:leg",
      name: "Leg",
      fits: ["hollow:leg-mount"],
    });
    expect(ready.partTypes).toContainEqual({
      id: "hollow:torso",
      name: "Torso",
      fits: [],
      role: "root",
    });
    expect(ready.partTypes).toContainEqual({
      id: "hollow:tail",
      name: "Tail",
      fits: ["hollow:tail-base"],
      role: "tail",
    });
    expect(ready.socketTypes).toContain("hollow:leg-mount");
    expect(ready.socketTypes).toEqual([...ready.socketTypes].sort());
  });

  it("lists the suggested colours of every palette, by palette ID, each colour once", () => {
    const host = startHost((registries) => [
      ...registerBuiltInContent(registries),
      registries.palettes.register({
        schemaVersion: 1,
        id: "test:sea",
        version: "1.0.0",
        name: "Sea",
        colors: ["#2f5d8a", "#479571"],
      }),
    ]);
    host.init();
    const [ready] = host.take();
    if (ready?.type !== "ready") throw new Error("Expected ready");
    const [woodland] = builtInDefinitions.palettes;
    // The built-in palette first (`hollow:` before `test:`), then the pack's colour it lacks.
    expect(ready.suggestedColors).toEqual([...woodland.colors, "#2f5d8a"]);
  });

  it("describes the prop types with their categories, and the categories in tab order", () => {
    // A pack's tab sorts by order among the built-in ones, and a type without a category says so
    // by leaving it out (the drawer lists it under "Other").
    const host = startHost((registries) => [
      ...registerBuiltInContent(registries),
      registries.propCategories.register({
        schemaVersion: 1,
        id: "test:fences",
        version: "1.0.0",
        name: "Fences",
        order: 15,
      }),
      registries.props.register({
        schemaVersion: 2,
        id: "test:stump",
        version: "1.0.0",
        name: "Stump",
        model: "hollow:models/rock.glb",
        blockRadius: 0.4,
        affordances: {},
      }),
    ]);
    host.init();
    const [ready] = host.take();
    if (ready?.type !== "ready") throw new Error("Expected ready");
    expect(ready.propCategories).toEqual([
      { id: "hollow:trees", name: "Trees" },
      { id: "test:fences", name: "Fences" },
      { id: "hollow:rocks", name: "Rocks" },
      { id: "hollow:plants", name: "Plants" },
      { id: "hollow:mushrooms", name: "Mushrooms" },
    ]);
    expect(ready.props["hollow:rock"]).toEqual({
      name: "Rock",
      model: "hollow:models/rock.glb",
      blockRadius: 0.5,
      category: "hollow:rocks",
    });
    expect(ready.props["test:stump"]).toEqual({
      name: "Stump",
      model: "hollow:models/rock.glb",
      blockRadius: 0.4,
    });
    expect(
      Object.fromEntries(Object.entries(ready.props).map(([id, p]) => [id, p.category])),
    ).toEqual({
      "hollow:bush": "hollow:plants",
      "hollow:mushroom": "hollow:mushrooms",
      "hollow:pine": "hollow:trees",
      "hollow:rock": "hollow:rocks",
      "hollow:round-tree": "hollow:trees",
      "test:stump": undefined,
    });
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
      capabilities: { "core:land": 1 },
      baseSpeed: 0.5,
      behaviors: ["core:wander"],
    };
    const appearanceUrl = "blob:http://localhost/puddle";
    host.send({
      type: "register_species",
      requestId: "r1",
      species,
      appearanceUrl,
      appearanceKind: "image",
    });
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
          body: { ...defaultBody(), thickness: 0.6 },
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

  it("answers a limits query with the asked capabilities' locomotion rules, as content declares them", () => {
    // A pack's own way of moving comes back as it registered it (issue #136).
    const paddle = { regionKinds: ["water" as const], animation: "paddle", submersion: 0.8 };
    const host = startHost((registries) => [
      ...registerBuiltInContent(registries),
      registries.capabilities.register({ id: "test:paddle", version: "1.0.0", locomotion: paddle }),
      registries.capabilities.register({ id: "test:keen", version: "1.0.0" }),
    ]);
    host.init();
    host.take();
    host.send({
      type: "check_limits",
      requestId: "q",
      sizeClass: "small",
      capabilities: { "core:land": 1, "test:paddle": 1, "test:keen": 1 },
    });
    host.advance(100);
    const [answer] = host.take();
    expect(answer).toMatchObject({
      type: "limits",
      requestId: "q",
      locomotion: { "core:land": { animation: { fromStyle: "land" } }, "test:paddle": paddle },
    });
    // A capability that is no way of moving has no rule.
    expect(answer?.type === "limits" && Object.keys(answer.locomotion)).toEqual([
      "core:land",
      "test:paddle",
    ]);
    expect(structuredClone(answer)).toEqual(answer);
  });

  it("sends a voxel species' locomotion and its appearance's kind and URL, never its cubes", () => {
    const host = startHost();
    host.init();
    host.take();
    const species = {
      schemaVersion: 1,
      id: "user:cubes",
      version: "1.0.0",
      name: "Cubes",
      appearance: "user:cubes/assembly.json",
      sizeClass: "medium",
      body: { locomotion: { land: { gait: "hop" } } },
      capabilities: { "core:land": 1 },
      baseSpeed: 0.5,
      behaviors: ["core:wander"],
    };
    const appearanceUrl = "blob:http://localhost/assembly";
    host.send({
      type: "register_species",
      requestId: "r1",
      species,
      appearanceUrl,
      appearanceKind: "voxel",
    });
    host.advance(100);
    const [registered] = host.take();
    expect(registered).toEqual({
      type: "species_registered",
      requestId: "r1",
      speciesId: "user:cubes",
      species: {
        appearance: species.appearance,
        sizeClass: "medium",
        // Only how it moves: no thickness or anchors, and nothing of its cubes.
        body: { locomotion: { land: { gait: "hop" } } },
      },
      asset: { kind: "voxel", url: appearanceUrl },
      limits: [],
    });
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
      appearanceKind: "image",
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
    expect(unstamped(host.take())).toEqual(unstamped(unbroken));
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
      [
        text({ ...valid, schemaVersion: WORLD_SAVE_SCHEMA_VERSION + 1 }),
        ["unsupported_save_version"],
      ],
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

  it("sends what to draw after restoring an edited world, and only then", () => {
    const edited = running(7, 1000);
    const ops = [{ op: "prop.add", prop: "hollow:rock", position: { x: 5, z: -5 } }];
    edited.send({ type: "edit", requestId: "e", edit: { ops } });
    edited.advance(100);
    edited.take();
    const { json: editedJson } = save(edited);
    const { json: plainJson } = save(running(7, 1000));
    const host = startHost();
    host.init(99);
    host.advance(100);
    host.take();
    const restore = (json: string) => {
      host.send({ type: "restore", json, nowMs: SAVED_AT, minutes: NOON });
      host.advance(100);
      return host.take().filter((m) => m.type !== "snapshot");
    };
    // The registered world is already running: nothing new to draw.
    expect(restore(plainJson).map((m) => m.type)).toEqual(["restored"]);
    const [restored, changed, ...rest] = restore(editedJson);
    expect(rest).toEqual([]);
    expect(restored?.type).toBe("restored");
    if (changed?.type !== "world_changed") throw new Error("Expected world_changed");
    expect(changed.scene.props.some((p) => p.id === "prop-1")).toBe(true);
    // Back to a save of the registered world: the added rock goes again.
    const [, back] = restore(plainJson);
    if (back?.type !== "world_changed") throw new Error("Expected world_changed");
    expect(back.scene.props.some((p) => p.id === "prop-1")).toBe(false);
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

  /** Snapshots and their events, without the wall-clock stamp, which differs between hosts. */
  const unstamped = (messages: SimulationMessage[]) =>
    messages.flatMap((m) =>
      m.type === "snapshot" ? [{ snapshot: m.snapshot, events: m.events }] : [],
    );

  it("stamps each snapshot with the worker's wall-clock time", () => {
    const host = running(7, 1000);
    host.sleep(3 * HOUR);
    host.advance(100);
    expect(host.snapshots().map((m) => m.wallMs)).toEqual([WALL_START + 1100 + 3 * HOUR]);
  });

  it("catches up in place as a relaunch after the same gap would, with no burst of ticks", () => {
    const GAP = 8 * HOUR;
    const host = running(7);
    // The worker wasn't scheduled for a while, so ticks are owed when the catch-up arrives.
    host.stall(5000);
    host.send({ type: "save", requestId: "save", savedAt: SAVED_AT });
    host.send({ type: "catch_up", requestId: "up", gapMs: GAP, minutes: 20 * 60 });
    host.advance(1);
    const applied = host.take();
    const saved = applied[0];
    if (saved?.type !== "saved") throw new Error("Expected saved");
    // No tick at the wake-up that caught up, then one per tick, from the tick after the gap.
    expect(applied.slice(1)).toEqual([
      {
        type: "caught_up",
        requestId: "up",
        report: { applied: true, gapMs: GAP, failures: [] },
      },
    ]);
    const tick = (JSON.parse(saved.json) as { tick: number }).tick + (GAP / 1000) * 10;
    host.advance(3000);
    const after = unstamped(host.take());
    expect(after.map((m) => m.snapshot.tick)).toEqual(
      Array.from({ length: 30 }, (_, k) => tick + 1 + k),
    );

    const relaunched = startHost();
    relaunched.init(99);
    relaunched.advance(500);
    relaunched.send({ type: "restore", json: saved.json, nowMs: SAVED_AT + GAP, minutes: 20 * 60 });
    relaunched.advance(1);
    relaunched.take();
    // Its wake-ups fall at other times, so it is run a little longer.
    relaunched.advance(3100);
    expect(unstamped(relaunched.take()).slice(0, after.length)).toEqual(after);
  });

  it("only sets the time of day for a short gap or a clock set back", () => {
    const host = running(7, 1000);
    host.send({ type: "catch_up", gapMs: 90_000, minutes: NOON + 5 });
    host.send({ type: "catch_up", gapMs: -HOUR, minutes: NOON + 5 });
    host.advance(100);
    const messages = host.take();
    expect(messages.map((m) => (m.type === "caught_up" ? m.report : m.type))).toEqual([
      { applied: false, skipped: "short_gap", gapMs: 0, failures: [] },
      { applied: false, skipped: "no_gap", gapMs: 0, failures: [] },
      "snapshot",
    ]);
    expect(unstamped(messages)[0]?.snapshot).toMatchObject({ tick: 11, timeOfDay: NOON + 5 });
  });

  it("rejects a gap or time of day it can't use", () => {
    const host = running(7, 1000);
    host.send({ type: "catch_up", gapMs: Number.NaN, minutes: NOON });
    host.send({ type: "catch_up", gapMs: HOUR, minutes: Number.POSITIVE_INFINITY });
    host.advance(100);
    const messages = host.take();
    const rejected = (code: string) => ({ id: undefined, command: "catch_up", codes: [code] });
    expect(rejections(messages)).toEqual([
      rejected("invalid_gap"),
      rejected("invalid_time_of_day"),
    ]);
    expect(unstamped(messages).map((m) => m.snapshot.tick)).toEqual([11]);
  });

  it("shows the caught-up world at once while paused", () => {
    const host = running(7, 1000);
    host.send({ type: "pause" });
    host.advance(100);
    host.take();
    host.send({ type: "catch_up", gapMs: HOUR, minutes: NOON + 60 });
    host.advance(1000);
    const messages = host.take();
    expect(messages.map((m) => m.type)).toEqual(["caught_up", "snapshot"]);
    expect(unstamped(messages)[0]?.snapshot).toMatchObject({
      tick: 10 + 3600 * 10,
      paused: true,
      timeOfDay: NOON + 60,
    });
  });

  it("is protocol version 21, and ignores a save sent with another", () => {
    expect(PROTOCOL_VERSION).toBe(21);
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

describe("world edits in the host", () => {
  it("validates and applies an edit between ticks, while paused too, and sends what to draw", () => {
    const host = startHost();
    host.init();
    host.advance(300);
    host.send({ type: "pause" });
    host.advance(100);
    host.take();
    const ops = [{ op: "prop.add", prop: "hollow:rock", position: { x: 5, z: -5 } }];
    host.send({ type: "validate_edit", requestId: "v", edit: { ops } });
    host.send({ type: "edit", requestId: "e", edit: { ops } });
    // Nothing applies before the next tick boundary.
    expect(host.take()).toEqual([]);
    host.advance(100);
    const [checked, edited, changed, snapshot, ...rest] = host.take();
    expect(rest).toEqual([]);
    expect(checked).toMatchObject({
      type: "edit_checked",
      requestId: "v",
      check: { ok: true, footprints: [{ placementId: "prop-1", center: { x: 5, z: -5 } }] },
    });
    expect(edited).toMatchObject({
      type: "edited",
      requestId: "e",
      result: {
        ok: true,
        edit: { ops: [{ op: "prop.add", id: "prop-1" }] },
        inverse: { ops: [{ op: "prop.remove", id: "prop-1" }] },
      },
    });
    if (changed?.type !== "world_changed") throw new Error("Expected world_changed");
    expect(structuredClone(changed)).toEqual(changed);
    expect(changed.scene.props.some((p) => p.id === "prop-1")).toBe(true);
    expect(changed.navigations).toHaveLength(1);
    expect(snapshot).toMatchObject({ type: "snapshot", snapshot: { tick: 3, paused: true } });
    // The edit's event comes with the first tick after it.
    host.send({ type: "resume" });
    host.advance(300);
    const events = host.snapshots().flatMap((m) => m.events);
    expect(events).toContainEqual({ type: "world_edited", tick: 3, edit: expect.any(Object) });
  });

  it("rejects an edit that is malformed or doesn't fit, and answers a validation either way", () => {
    const host = startHost();
    host.init();
    host.take();
    host.send({ type: "edit", requestId: "a", edit: { ops: [] } });
    host.send({ type: "edit", requestId: "b", edit: { ops: [{ op: "prop.remove", id: "nope" }] } });
    host.send({ type: "validate_edit", requestId: "c", edit: "nonsense" });
    host.advance(100);
    const answers = host.take().filter((m) => m.type !== "snapshot");
    expect(answers).toMatchObject([
      { type: "rejected", requestId: "a", command: "edit" },
      {
        type: "rejected",
        requestId: "b",
        command: "edit",
        diagnostics: [{ code: "unknown_placement", path: ["ops", 0, "id"] }],
      },
      { type: "edit_checked", requestId: "c", check: { ok: false } },
    ]);
  });
});
