import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  formatDiagnostic,
  parseWorldEdit,
  type WorldDefinition,
  type WorldEdit,
  type WorldEditInput,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import {
  applyWorldEdit,
  assignPlacementIds,
  hungerNeed,
  Simulation,
  type EditEnvironment,
  type PathState,
  type SimulationEvent,
} from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { fixtureRoundTree } from "./fixtures/far-shelter";
import { pondWorld, registerPond } from "./index";
import { createSimulation, loadContent } from "./simulation-run";

// World edits in the simulation (ADR 0021, M17 PR 2): applying and validating an edit, the
// rebuild, and reconciling creatures with the edited world.

const HOLLOW = { register: registerBuiltInContent, worldId: "hollow:woodland-hollow" };
const MOSSLING = "hollow:mossling";

const edit = (input: WorldEditInput): WorldEdit => {
  const parsed = parseWorldEdit(input);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  return parsed.value;
};

function hollowSim(seed = 1) {
  return createSimulation({ ...HOLLOW, seed });
}

function spawn(simulation: Simulation, speciesId = MOSSLING, spawnPointId?: string) {
  const spawned = simulation.spawn(speciesId, spawnPointId);
  if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
  return spawned.value;
}

function environment(registries: Registries, world: WorldDefinition): EditEnvironment {
  const created = Simulation.create(registries, { world, seed: 1 });
  if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
  const { terrain } = created.value.state.model;
  return {
    blockRadius: (id) => registries.props.get(id)?.blockRadius,
    groundHeight: (x, z) => terrain.heightAt(x, z),
  };
}

function hollowContent() {
  const content = loadContent(registerBuiltInContent);
  if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
  const world = content.value.worlds.get(HOLLOW.worldId);
  if (!world) throw new Error("No Woodland Hollow");
  return { registries: content.value, world, env: environment(content.value, world) };
}

describe("applying an edit to a world definition", () => {
  const { world, env } = hollowContent();
  const pine = world.props.find((p) => p.id === "pine-1")!;

  it("adds, moves, turns, scales and removes props, on the ground, with an inverse", () => {
    const { edit: applied, next } = assignPlacementIds(
      world,
      edit({
        ops: [
          { op: "prop.add", prop: "hollow:rock", position: { x: 5, z: -5 } },
          { op: "prop.move", id: "pine-1", position: { x: -20, z: -6 }, rotationY: 1 },
          { op: "prop.scale", id: "rock-1", scale: 1.5 },
          { op: "prop.remove", id: "bush-1" },
        ],
      }),
      1,
    );
    expect(next).toBe(2);
    expect(applied.ops[0]).toMatchObject({ op: "prop.add", id: "prop-1", rotationY: 0, scale: 1 });
    const result = applyWorldEdit(world, applied, env);
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    const { world: edited, inverse, added, changed, removed } = result.value;
    expect(added).toEqual(["prop-1"]);
    expect(changed).toEqual(["pine-1", "rock-1"]);
    expect(removed).toEqual(["bush-1"]);
    const byId = new Map(edited.props.map((p) => [p.id, p]));
    expect(byId.get("prop-1")?.transform.position).toEqual({
      x: 5,
      y: env.groundHeight(5, -5),
      z: -5,
    });
    expect(byId.get("pine-1")?.transform).toEqual({
      position: { x: -20, y: env.groundHeight(-20, -6), z: -6 },
      rotationY: 1,
      scale: pine.transform.scale,
    });
    expect(byId.get("rock-1")?.transform.scale).toBe(1.5);
    expect(byId.has("bush-1")).toBe(false);
    // The world it was given is left as it was.
    expect(world.props.find((p) => p.id === "pine-1")).toBe(pine);
    expect(world.props.some((p) => p.id === "bush-1")).toBe(true);

    // Each op's inverse, in reverse order.
    expect(inverse.ops.map((op) => op.op)).toEqual([
      "prop.add",
      "prop.scale",
      "prop.move",
      "prop.remove",
    ]);
    const undone = applyWorldEdit(edited, inverse, env);
    if (!undone.ok) throw new Error(undone.diagnostics.map(formatDiagnostic).join("\n"));
    // Back as it was, up to the ground snap and the order of the placement removed and added
    // back, which comes last.
    const snapped = (p: (typeof world.props)[number]) => ({
      ...p,
      transform: {
        ...p.transform,
        position: {
          ...p.transform.position,
          y: env.groundHeight(p.transform.position.x, p.transform.position.z),
        },
      },
    });
    const sort = (props: typeof world.props) => props.toSorted((a, b) => (a.id < b.id ? -1 : 1));
    const touched = new Set(["pine-1", "bush-1"]);
    expect(sort(undone.value.world.props)).toEqual(
      sort(world.props.map((p) => (touched.has(p.id) ? snapped(p) : p))),
    );
  });

  it("generates IDs from the counter, skipping IDs in use or named in the edit", () => {
    const withProp2 = { ...world, props: [...world.props, { ...pine, id: "prop-2" }] };
    const { edit: applied, next } = assignPlacementIds(
      withProp2,
      edit({
        ops: [
          { op: "prop.add", prop: "hollow:rock", position: { x: 5, z: -5 } },
          { op: "prop.add", prop: "hollow:rock", position: { x: 6, z: -5 }, id: "prop-3" },
          { op: "prop.add", prop: "hollow:rock", position: { x: 7, z: -5 } },
        ],
      }),
      1,
    );
    expect(applied.ops.map((op) => op.id)).toEqual(["prop-1", "prop-3", "prop-4"]);
    expect(next).toBe(5);
  });

  it("refuses the whole edit when an op doesn't fit the world", () => {
    const refused = (input: WorldEditInput) => {
      const result = applyWorldEdit(world, assignPlacementIds(world, edit(input), 1).edit, env);
      expect(result.ok).toBe(false);
      return result.ok ? [] : result.diagnostics.map((d) => [d.code, d.path.join(".")]);
    };
    const ok = { op: "prop.move", id: "pine-1", position: { x: 0, z: 0 } } as const;
    expect(refused({ ops: [ok, { op: "prop.remove", id: "nope" }] })).toEqual([
      ["unknown_placement", "ops.1.id"],
    ]);
    expect(
      refused({
        ops: [{ op: "prop.add", prop: "hollow:rock", position: { x: 0, z: 0 }, id: "river" }],
      }),
    ).toEqual([["placement_id_in_use", "ops.0.id"]]);
    expect(
      refused({ ops: [{ op: "prop.add", prop: "hollow:nope", position: { x: 0, z: 0 } }] }),
    ).toEqual([["unknown_prop", "ops.0.prop"]]);
    expect(refused({ ops: [{ ...ok, position: { x: 31.9, z: 0 } }] })).toEqual([
      ["outside_world", "ops.0.position"],
    ]);
    expect(refused({ ops: [{ op: "prop.scale", id: "pine-1", scale: 1000 }] })).toEqual([
      ["outside_world", "ops.0.scale"],
    ]);
    // Ops apply in order: a placement removed earlier in the edit is gone for later ops.
    expect(
      refused({
        ops: [
          { op: "prop.remove", id: "rock-1" },
          { op: "prop.scale", id: "rock-1", scale: 2 },
        ],
      }),
    ).toEqual([["unknown_placement", "ops.1.id"]]);
  });
});

describe("Simulation edits", () => {
  it("validates without changing anything, then applies what it validated", () => {
    const simulation = hollowSim();
    spawn(simulation, MOSSLING, "meadow");
    for (let n = 0; n < 20; n++) simulation.step();
    const model = simulation.state.model;
    const before = JSON.stringify(simulation.save(0));
    const input = edit({
      ops: [
        { op: "prop.add", prop: "hollow:bush", position: { x: 10, z: 2 } },
        { op: "prop.scale", id: "rock-2", scale: 2 },
      ],
    });
    const check = simulation.validateEdit(input);
    expect(check.ok).toBe(true);
    expect(simulation.state.model).toBe(model);
    expect(simulation.state.nextPropId).toBe(1);
    expect(JSON.stringify(simulation.save(0))).toBe(before);

    const result = simulation.applyEdit(input);
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    if (!check.ok) throw new Error("unreachable");
    expect(result.footprints).toEqual(check.footprints);
    expect(result.footprints.map((f) => f.placementId)).toEqual(["prop-1", "rock-2"]);
    expect(result.edit.ops[0]).toMatchObject({ op: "prop.add", id: "prop-1" });
    expect(simulation.state.model).not.toBe(model);
    expect(simulation.state.model.propsById.has("prop-1")).toBe(true);
    expect(model.propsById.has("prop-1")).toBe(false);
    expect(simulation.state.nextPropId).toBe(2);
    const events = simulation.step();
    expect(events[0]).toEqual({ type: "world_edited", tick: 20, edit: result.edit });
  });

  it("moves a creature a prop is dropped on to the nearest walkable cell, interrupting it", () => {
    const simulation = hollowSim();
    const creature = spawn(simulation, MOSSLING, "meadow");
    simulation.step();
    expect(creature.action).toBeDefined();
    const { x, z } = creature.position;
    const result = simulation.applyEdit(
      edit({ ops: [{ op: "prop.add", prop: "hollow:round-tree", position: { x, z }, scale: 2 }] }),
    );
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    expect(result.relocated).toHaveLength(1);
    const [moved] = result.relocated;
    expect(moved).toMatchObject({ creatureId: creature.id, from: { x, z } });
    expect(creature.position).toEqual(moved!.to);
    const pathfinder = simulation.state.pathfinderFor(MOSSLING)!;
    expect(
      pathfinder.navigation.masks
        .get(creature.position.regionId)!
        .isWalkableAt(creature.position.x, creature.position.z),
    ).toBe(true);
    // Just clear of the tree: within a cell or two of its blocked circle.
    const tree = simulation.state.model.propsById.get("prop-1")!;
    const distance = Math.hypot(creature.position.x - x, creature.position.z - z);
    expect(distance).toBeGreaterThan(tree.blockRadius);
    expect(distance).toBeLessThan(tree.blockRadius + 2);
    expect(creature.action).toBeUndefined();
    expect(creature.lastResult).toMatchObject({ outcome: "interrupted", reason: "world_edited" });
    const events = simulation.step();
    expect(events.map((e) => e.type).slice(0, 2)).toEqual(["world_edited", "creature_relocated"]);
  });

  it("prunes home and knowledge of removed props, and forgets back-offs at moved ones", () => {
    const simulation = hollowSim();
    const creature = spawn(simulation, MOSSLING, "meadow");
    creature.home = "round-tree-10";
    const failures = { noRoute: 2, stuck: 0, retryTick: 999_999, cell: { x: 0, z: 0 } };
    creature.knowledge.places["core:food"] = [
      { placementId: "bush-3", lastSeenTick: 0 },
      { placementId: "bush-4", lastSeenTick: 0, failures: { ...failures } },
      { placementId: "bush-2", lastSeenTick: 0, failures: { ...failures } },
    ];
    creature.knowledge.places["core:shelter"] = [{ placementId: "round-tree-10", lastSeenTick: 0 }];
    const result = simulation.applyEdit(
      edit({
        ops: [
          { op: "prop.remove", id: "round-tree-10" },
          { op: "prop.remove", id: "bush-3" },
          { op: "prop.move", id: "bush-4", position: { x: 12, z: 16 } },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    expect(creature.home).toBeNull();
    expect(creature.knowledge.places["core:shelter"]).toEqual([]);
    expect(creature.knowledge.places["core:food"]).toEqual([
      { placementId: "bush-4", lastSeenTick: 0 },
      { placementId: "bush-2", lastSeenTick: 0, failures },
    ]);
  });

  it("interrupts an action whose target the edit moves", () => {
    const simulation = hollowSim();
    const creature = spawn(simulation, MOSSLING, "meadow");
    creature.needs[hungerNeed.id] = 0.95;
    creature.knowledge.places["core:food"] = [{ placementId: "bush-3", lastSeenTick: 0 }];
    simulation.step();
    expect(creature.action).toMatchObject({ id: "core:eat" });
    const target = (creature.action!.state as { placementId: string }).placementId;
    const events: SimulationEvent[] = [];
    const result = simulation.applyEdit(
      edit({ ops: [{ op: "prop.move", id: target, position: { x: 20, z: 12 } }] }),
    );
    expect(result.ok).toBe(true);
    expect(creature.action).toBeUndefined();
    expect(creature.lastResult).toEqual({
      action: "core:eat",
      outcome: "interrupted",
      reason: "world_edited",
    });
    expect(creature.decideAtTick).toBe(simulation.tick);
    events.push(...simulation.step());
    // It decides again at once; going back to that bush, it goes to where the bush is now.
    expect(creature.action).toMatchObject({ id: "core:eat" });
    const state = creature.action!.state as { placementId: string; path: PathState };
    if (state.placementId === target) {
      const last = state.path.points.at(-1)!;
      expect(Math.hypot(last.x - 20, last.z - 12)).toBeLessThan(2);
    }
  });

  it("interrupts a meal at food the edit removes, and forgets that food", () => {
    const simulation = hollowSim();
    const creature = spawn(simulation, MOSSLING, "meadow");
    creature.needs[hungerNeed.id] = 0.95;
    simulation.step();
    expect(creature.action).toMatchObject({ id: "core:eat" });
    const target = (creature.action!.state as { placementId: string }).placementId;
    expect(creature.knowledge.places["core:food"]?.map((p) => p.placementId)).toContain(target);
    expect(simulation.applyEdit(edit({ ops: [{ op: "prop.remove", id: target }] })).ok).toBe(true);
    expect(creature.lastResult).toEqual({
      action: "core:eat",
      outcome: "interrupted",
      reason: "world_edited",
    });
    expect(creature.knowledge.places["core:food"]?.map((p) => p.placementId)).not.toContain(target);
    simulation.step();
    expect((creature.action?.state as { placementId?: string }).placementId).not.toBe(target);
  });

  it("replans the route of an action that carries on", () => {
    const simulation = hollowSim(3);
    const creature = spawn(simulation, MOSSLING, "meadow");
    // Waits for a wander walk with a few waypoints.
    let path: PathState | undefined;
    for (let n = 0; n < 400 && !path; n++) {
      simulation.step();
      const state = creature.action?.state as Partial<PathState> | undefined;
      if (creature.action?.id === "core:follow_path" && state?.points && state.points.length > 4) {
        path = state as PathState;
      }
    }
    if (!path) throw new Error("The mossling never walked");
    const before = path.points.map((p) => ({ ...p }));
    // A rock on the route still to walk, on open ground (not the bridge, which it would close),
    // clear of the creature and of the goal.
    const goal = path.points.at(-1)!;
    const away = (p: { x: number; z: number }, q: { x: number; z: number }) =>
      Math.hypot(p.x - q.x, p.z - q.z) > 2;
    const rock = path.points.slice(path.next + 1).flatMap((b, k) => {
      const a = k === 0 ? creature.position : path!.points[path!.next + k]!;
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      const open = a.regionId === b.regionId && !b.regionId.startsWith("bridge");
      return open && away(mid, creature.position) && away(mid, goal) ? [mid] : [];
    })[0];
    if (!rock) throw new Error("No open ground on the route");
    const result = simulation.applyEdit(
      edit({ ops: [{ op: "prop.add", prop: "hollow:rock", position: rock }] }),
    );
    expect(result.ok).toBe(true);
    // The same walk, on a new route round the rock to the same goal.
    expect(creature.action?.state).toBe(path);
    expect(path.next).toBe(0);
    expect(path.points).not.toEqual(before);
    expect(path.points.at(-1)).toEqual(before.at(-1));
    const { masks } = simulation.state.pathfinderFor(MOSSLING)!.navigation;
    for (const p of path.points) expect(masks.get(p.regionId)!.isWalkableAt(p.x, p.z)).toBe(true);
    // And it walks it.
    const from = { ...creature.position };
    for (let n = 0; n < 20; n++) simulation.step();
    expect(creature.action?.state).toBe(path);
    expect(Math.hypot(creature.position.x - from.x, creature.position.z - from.z)).toBeGreaterThan(
      0.5,
    );
  });

  it("warns about a way out of the water it blocks", () => {
    const content = loadContent((registries) => [
      registries.assets.register({
        id: fixtureRoundTree.model,
        version: "1.0.0",
        kind: "model",
        url: "-",
      }),
      registries.props.register(fixtureRoundTree),
      ...registerPond(registries, pondWorld),
    ]);
    if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
    const created = Simulation.create(content.value, { worldId: pondWorld.id, seed: 1 });
    if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
    const simulation = created.value;
    // Trees along the south shore exit's portal, from x = 1 to 4 at z = 2.
    const trees = [1, 2, 3, 4].map((x) => ({
      op: "prop.add" as const,
      prop: fixtureRoundTree.id,
      position: { x, z: 2.6 },
      scale: 2.5,
    }));
    const check = simulation.validateEdit(edit({ ops: trees }));
    if (!check.ok) throw new Error(check.diagnostics.map(formatDiagnostic).join("\n"));
    const shore = check.blockedExits.find((b) => b.exit.kind === "connection");
    expect(shore?.exit).toEqual({ kind: "connection", connectionId: "south-shore" });
    expect(shore?.profiles.length).toBeGreaterThan(0);
    expect(check.warnings.map((w) => w.code)).toContain("water_exit_blocked");
    expect(check.warnings.find((w) => w.code === "water_exit_blocked")?.message).toContain(
      "south-shore",
    );
    // A warning, not a refusal.
    expect(simulation.applyEdit(edit({ ops: trees })).ok).toBe(true);
  });

  it("refuses an edit that leaves a creature's kind nowhere to be, changing nothing", () => {
    const content = loadContent((registries) => [
      registries.assets.register({
        id: fixtureRoundTree.model,
        version: "1.0.0",
        kind: "model",
        url: "-",
      }),
      registries.props.register(fixtureRoundTree),
      ...registerPond(registries, pondWorld),
    ]);
    if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
    const created = Simulation.create(content.value, { worldId: pondWorld.id, seed: 1 });
    if (!created.ok) throw new Error(created.diagnostics.map(formatDiagnostic).join("\n"));
    const simulation = created.value;
    const minnow = spawn(simulation, "fixture:minnow");
    const position = { ...minnow.position };
    const model = simulation.state.model;
    // The water, 12 × 4 m between the dry edges, covered with trees 2 m across: the minnow,
    // which only swims, has nowhere left.
    const ops = [];
    for (let x = -5; x <= 5; x++) {
      for (const z of [-1.5, -0.5, 0.5, 1.5]) {
        ops.push({
          op: "prop.add" as const,
          prop: fixtureRoundTree.id,
          position: { x, z },
          scale: 1 / fixtureRoundTree.blockRadius,
        });
      }
    }
    const result = simulation.applyEdit(edit({ ops }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(new Set(result.diagnostics.map((d) => d.code))).toEqual(
      new Set(["edit_breaks_navigation"]),
    );
    expect(simulation.state.model).toBe(model);
    expect(simulation.state.nextPropId).toBe(1);
    expect(minnow.position).toEqual(position);
  });

  it("never applies an edit in the middle of a step", () => {
    const attempts: boolean[] = [];
    const simulation: Simulation = createSimulation({
      ...HOLLOW,
      seed: 1,
      onTrace: () => {
        const result = simulation.applyEdit(edit({ ops: [{ op: "prop.remove", id: "rock-1" }] }));
        attempts.push(result.ok);
        if (!result.ok) expect(result.diagnostics[0]?.code).toBe("edit_during_step");
      },
    });
    spawn(simulation);
    const model = simulation.state.model;
    simulation.step();
    expect(attempts).toEqual([false]);
    expect(simulation.state.model).toBe(model);
    expect(simulation.applyEdit(edit({ ops: [{ op: "prop.remove", id: "rock-1" }] })).ok).toBe(
      true,
    );
  });

  it("gives the same world for the same edits at the same ticks", () => {
    const run = () => {
      const simulation = hollowSim(7);
      for (const point of ["meadow", "woods-glade", "woods-north"])
        spawn(simulation, MOSSLING, point);
      const events: SimulationEvent[] = [];
      const results: unknown[] = [];
      const edits: [number, WorldEdit][] = [
        [50, edit({ ops: [{ op: "prop.add", prop: "hollow:bush", position: { x: 12, z: 5 } }] })],
        [120, edit({ ops: [{ op: "prop.move", id: "round-tree-9", position: { x: 14, z: 4 } }] })],
        [
          200,
          edit({
            ops: [
              { op: "prop.remove", id: "bush-12" },
              { op: "prop.scale", id: "prop-1", scale: 1.6 },
            ],
          }),
        ],
      ];
      for (let tick = 0; tick < 600; tick++) {
        for (const [at, e] of edits) if (at === tick) results.push(simulation.applyEdit(e));
        events.push(...simulation.step());
      }
      return {
        save: JSON.stringify(simulation.save(0)),
        events,
        results,
        model: simulation.state.model,
      };
    };
    const a = run();
    const b = run();
    expect(a.results.every((r) => (r as { ok: boolean }).ok)).toBe(true);
    expect(b.save).toBe(a.save);
    expect(b.events).toEqual(a.events);
    expect(b.results).toEqual(a.results);
    expect(b.model.definition).toEqual(a.model.definition);
  });
});
