import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  formatDiagnostic,
  parseWorldEdit,
  parseWorldSave,
  type WorldEditInput,
  type WorldSave,
} from "@living-diorama/content-schema";
import { minutesAfter, type Simulation } from "@living-diorama/simulation";
import { describe, expect, it, vi } from "vitest";
import { createSimulation } from "./simulation-run";

// Saving an edited world (ADR 0021 §4, M17 PR 4): a save of an edited world holds the world
// itself and the generated placement ID counter, and a restore rebuilds the world from it, not
// from the registry. A save of an unedited world still only names the registered one.

const HZ = 2;
const WORLD = "hollow:woodland-hollow";
const MOSSLING = "hollow:mossling";
const START = 19 * 60 + 15;
const SAVED_AT = Date.UTC(2026, 9, 29, 19, 45);

const create = (seed: number, minutes = START) =>
  createSimulation({
    register: registerBuiltInContent,
    worldId: WORLD,
    seed,
    tickRateHz: HZ,
    startMinutes: minutes,
  });

/** Runs `ticks` ticks with the time of day following simulation time; events per tick. */
function run(simulation: Simulation, ticks: number) {
  const events = [];
  for (let k = 0; k < ticks; k++) {
    simulation.setTimeOfDay(minutesAfter(START, (simulation.tick * 1000) / HZ));
    events.push(simulation.step());
  }
  return events;
}

function applyEdit(simulation: Simulation, input: WorldEditInput) {
  const parsed = parseWorldEdit(input);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  const result = simulation.applyEdit(parsed.value);
  if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
  return result;
}

/** What a save goes through on disk: JSON and back, then the schema. */
function throughDisk(save: WorldSave): WorldSave {
  const parsed = parseWorldSave(JSON.parse(JSON.stringify(save)));
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  return parsed.value;
}

/** A fresh world of another seed with `save` restored into it, at the moment of the save. */
function restored(save: WorldSave, into = create(999, 12 * 60)) {
  const result = into.restore(save, { nowMs: save.savedAt, minutes: save.minutes });
  if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
  return { simulation: into, report: result.value };
}

/** Three mosslings, run a while, then an edit that adds, moves, scales and removes props. */
function edited(seed = 7) {
  const simulation = create(seed);
  for (let k = 0; k < 3; k++) expect(simulation.spawn(MOSSLING).ok).toBe(true);
  run(simulation, 200);
  applyEdit(simulation, {
    ops: [
      { op: "prop.add", prop: "hollow:rock", position: { x: 5, z: -5 } },
      { op: "prop.add", prop: "hollow:mushroom", position: { x: -6, z: 4 } },
      { op: "prop.move", id: "pine-1", position: { x: -20, z: -6 }, rotationY: 1 },
      { op: "prop.scale", id: "rock-1", scale: 1.5 },
      { op: "prop.remove", id: "bush-1" },
    ],
  });
  run(simulation, 100);
  return simulation;
}

describe("a save of an edited world", () => {
  it("holds the world and the placement ID counter, and restores both", () => {
    const simulation = edited();
    const save = throughDisk(simulation.save(SAVED_AT));
    const { definition } = simulation.state.model;
    expect(save.world).toEqual({ id: WORLD, version: definition.version, definition });
    expect(save.nextPropId).toBe(3);

    const { simulation: back } = restored(save);
    expect(back.state.model.definition).toEqual(definition);
    expect(back.state.nextPropId).toBe(3);
    const props = back.state.model.propsById;
    expect(props.has("prop-1") && props.has("prop-2")).toBe(true);
    expect(props.has("bush-1")).toBe(false);
    // The restored world is built from the save: changing the save later doesn't reach it.
    save.world.definition?.props.splice(0);
    expect(back.state.model.definition).toEqual(definition);
  });

  it("then carrying on equals an unbroken run", () => {
    const unbroken = edited();
    const save = throughDisk(unbroken.save(SAVED_AT));
    const expected = run(unbroken, 1000);
    const { simulation, report } = restored(save);
    expect(report.droppedCreatures).toEqual([]);
    expect(report.prunedPlacements).toEqual([]);
    expect(report.droppedActions).toEqual([]);
    expect(run(simulation, 1000)).toEqual(expected);
    expect(simulation.save(0)).toEqual(unbroken.save(0));
  });

  it("never generates a placement ID again after a restore, even one an undo removed", () => {
    const simulation = create(3);
    const added = applyEdit(simulation, {
      ops: [{ op: "prop.add", prop: "hollow:rock", position: { x: 5, z: -5 } }],
    });
    // Undo: prop-1 is gone, but the inverse of this undo (a redo) still names it.
    applyEdit(simulation, added.inverse);
    expect(simulation.state.model.propsById.has("prop-1")).toBe(false);
    const { simulation: back } = restored(throughDisk(simulation.save(SAVED_AT)));
    const next = applyEdit(back, {
      ops: [{ op: "prop.add", prop: "hollow:rock", position: { x: 6, z: -5 } }],
    });
    expect(next.edit.ops[0]).toMatchObject({ op: "prop.add", id: "prop-2" });
    // The redo still applies after the restore, under the ID it had.
    const redo = applyEdit(back, added.edit);
    expect(redo.edit.ops[0]).toMatchObject({ op: "prop.add", id: "prop-1" });
  });

  it("keeps references to added placements, and prunes those its world no longer has", () => {
    const simulation = edited();
    const save = throughDisk(simulation.save(SAVED_AT));
    const creature = save.creatures[0]!;
    creature.home = "prop-1";
    const kept = restored(throughDisk(save));
    expect(kept.report.prunedPlacements).toEqual([]);
    expect(kept.simulation.state.creatures.get(creature.id)?.home).toBe("prop-1");

    // The same save, its world without the added rock.
    const definition = save.world.definition!;
    definition.props = definition.props.filter((p) => p.id !== "prop-1");
    const pruned = restored(throughDisk(save));
    expect(pruned.report.prunedPlacements).toContainEqual({
      creatureId: creature.id,
      placementId: "prop-1",
      where: "home",
    });
  });

  it("keeps a running action whose target was added, and drops it once its world lacks it", () => {
    const simulation = edited();
    const save = throughDisk(simulation.save(SAVED_AT));
    const creature = save.creatures[0]!;
    // A creature about to sleep beside the added rock, where it stands.
    creature.action = {
      id: "core:sleep",
      behavior: "core:rest",
      state: {
        placementId: "prop-1",
        heading: 0,
        path: { points: [], next: 0 },
        arrived: true,
        asleep: false,
        moves: 0,
        nap: false,
        newHome: false,
      },
      startTick: save.tick,
    };
    expect(restored(throughDisk(save)).report.droppedActions).toEqual([]);
    const definition = save.world.definition!;
    definition.props = definition.props.filter((p) => p.id !== "prop-1");
    const { report } = restored(save);
    expect(report.droppedActions).toContainEqual({
      creatureId: creature.id,
      actionId: "core:sleep",
      reason: "invalid_state",
    });
  });

  it("is discarded, leaving the world as it was, if its world uses an unregistered prop type", () => {
    const save = throughDisk(edited().save(SAVED_AT));
    const index = save.world.definition!.props.findIndex((p) => p.id === "prop-1");
    save.world.definition!.props[index]!.prop = "hollow:unicorn";
    const into = create(999);
    expect(into.spawn(MOSSLING).ok).toBe(true);
    const before = into.save(0);
    const model = into.state.model;
    const result = into.restore(save, { nowMs: SAVED_AT, minutes: save.minutes });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["save_world_invalid", ["world", "definition"]],
      ["unresolved_reference", ["world", "definition", "props", index, "prop"]],
    ]);
    expect(into.state.model).toBe(model);
    expect(into.save(0)).toEqual(before);
  });

  it("is discarded if its world can't be built", () => {
    const save = throughDisk(edited().save(SAVED_AT));
    // Every spawn point moved to a region that isn't there.
    for (const spawn of save.world.definition!.spawnPoints) spawn.position.regionId = "nowhere";
    const into = create(999);
    const model = into.state.model;
    const result = into.restore(save, { nowMs: SAVED_AT, minutes: save.minutes });
    expect(!result.ok && result.diagnostics[0]?.code).toBe("save_world_invalid");
    expect(into.state.model).toBe(model);
  });

  it("is discarded, not thrown, if building its world throws", () => {
    const save = throughDisk(edited().save(SAVED_AT));
    const into = create(999);
    const model = into.state.model;
    vi.spyOn(into.state, "derive").mockImplementation(() => {
      throw new Error("bad heights");
    });
    const result = into.restore(save, { nowMs: SAVED_AT, minutes: save.minutes });
    expect(result.ok ? [] : result.diagnostics.map((d) => [d.code, d.message])).toEqual([
      ["save_world_invalid", "The saved world could not be built: bad heights"],
    ]);
    expect(into.state.model).toBe(model);
  });

  it.each([
    [
      "a surface",
      (save: WorldSave) => (save.world.definition!.regions[0]!.surface.type = "hollow:lava"),
      ["regions", 0, "surface", "type"],
    ],
    [
      "a capability",
      (save: WorldSave) =>
        (save.world.definition!.connections[0]!.requiredCapabilities[0] = "hollow:wings"),
      ["connections", 0, "requiredCapabilities", 0],
    ],
  ])("is discarded if its world needs %s that isn't registered", (_, unregister, path) => {
    const save = throughDisk(edited().save(SAVED_AT));
    unregister(save);
    const into = create(999);
    const model = into.state.model;
    const result = into.restore(save, { nowMs: SAVED_AT, minutes: save.minutes });
    expect(result.ok ? [] : result.diagnostics.map((d) => [d.code, d.path])).toEqual([
      ["save_world_invalid", ["world", "definition"]],
      ["unresolved_reference", ["world", "definition", ...path]],
    ]);
    expect(into.state.model).toBe(model);
  });

  it("needs no registered world of its ID and version", () => {
    const save = throughDisk(edited().save(SAVED_AT));
    const definition = { ...save.world.definition!, version: "9.9.9" };
    const { simulation } = restored(
      throughDisk({ ...save, world: { id: WORLD, version: "9.9.9", definition } }),
    );
    expect(simulation.state.model.definition.version).toBe("9.9.9");
  });
});

describe("a save of an unedited world", () => {
  it("names the registered world only, and still restores", () => {
    const simulation = create(7);
    expect(simulation.spawn(MOSSLING).ok).toBe(true);
    run(simulation, 50);
    const save = throughDisk(simulation.save(SAVED_AT));
    expect(save.world).toEqual({ id: WORLD, version: expect.any(String) });
    expect(save.nextPropId).toBe(1);
    const into = create(999);
    const model = into.state.model;
    const { simulation: back } = restored(save, into);
    expect(back.state.model).toBe(model);
    expect(back.save(0)).toEqual(simulation.save(0));
  });

  it("restored into an edited world brings back the registered world", () => {
    const plain = throughDisk(create(7).save(SAVED_AT));
    const { simulation } = restored(plain, edited(9));
    const registered = simulation.state.registries.worlds.get(WORLD);
    expect(simulation.state.model.definition).toBe(registered);
    expect(simulation.state.model.propsById.has("prop-1")).toBe(false);
    expect(simulation.state.nextPropId).toBe(1);
    expect(simulation.save(0).world.definition).toBeUndefined();
  });
});
