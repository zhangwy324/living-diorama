import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  formatDiagnostic,
  parseWorldEdit,
  type RegionPosition,
  type WorldEdit,
  type WorldEditInput,
} from "@living-diorama/content-schema";
import type { Registries } from "@living-diorama/extension-api";
import type { PathState, Simulation, SimulationEvent } from "@living-diorama/simulation";
import { describe, expect, it } from "vitest";
import { parseEditScript, randomEdits, scriptedEdits, type EditRequest } from "./edit-cycles";
import { fixtureRoundTree } from "./fixtures/far-shelter";
import { carp, newt, otter, pondWorld, registerHollowCreatures, registerPond } from "./index";
import {
  LIVING_BEHAVIOR_CHECKS,
  loadContent,
  runWithInvariants,
  type EditLog,
  type RunOptions,
} from "./simulation-run";

// Headless world-edit scenarios (ADR 0021, M17 PR 5): edits made while creatures live on, each run
// with every long-run invariant checked after every tick and after every edit
// (`runWithInvariants`). `world-edits.test.ts` covers the engine's edit mechanics step by step;
// these check that the world carries on well after them.

const MOSSLING = "hollow:mossling";
const hollow = { register: registerBuiltInContent, worldId: "hollow:woodland-hollow" };
/** Long runs take a few seconds locally and several times that on the CI runner. */
const slow = { timeout: 60_000 };
/** Runs at 2 Hz, as `pnpm check`'s long runs do. */
const HZ = 2;
const minutes = (n: number) => n * 60 * HZ;

const edit = (input: WorldEditInput): WorldEdit => {
  const parsed = parseWorldEdit(input);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  return parsed.value;
};

/** Decides an edit from the world as it is between two steps, or none yet. */
type Decide = (simulation: Simulation, step: number) => WorldEdit | undefined;

/**
 * Runs with one edit from each of `decide`, in turn, each applied between the steps where it first
 * returns one, collecting the edits' logs and every event. `afterEdit` sees the world right after
 * each edit, before the next step.
 */
function runWithEdits(
  options: Omit<RunOptions, "edits" | "onEdit" | "onTick">,
  decide: readonly Decide[],
  afterEdit?: (log: EditLog, simulation: Simulation) => void,
) {
  const logs: EditLog[] = [];
  const events: SimulationEvent[] = [];
  const pending = [...decide];
  let last: Simulation | undefined;
  const report = runWithInvariants({
    tickRateHz: HZ,
    ...options,
    edits: (step, simulation) => {
      last = simulation;
      const next = pending[0]?.(simulation, step);
      if (!next) return [];
      pending.shift();
      return [{ edit: next }];
    },
    onEdit: (log) => {
      logs.push(log);
      afterEdit?.(log, last as Simulation);
    },
    onTick: (_simulation, tickEvents) => events.push(...tickEvents),
  });
  return { report, logs, events, simulation: last as Simulation, pending };
}

/** A clean run: no invariant violations, nobody stuck, no failed paths. */
function expectClean(report: ReturnType<typeof runWithInvariants>) {
  expect(report.violations).toEqual([]);
  expect(report.eventCounts.creature_stuck ?? 0).toBe(0);
  expect(report.eventCounts.path_failed ?? 0).toBe(0);
}

describe("a prop dropped on a creature", () => {
  it("moves the creature to a walkable cell, and it lives on", slow, () => {
    const covered = new Set<string>();
    const { report, logs, events } = runWithEdits(
      { ...hollow, speciesId: MOSSLING, seed: 1, creatures: 3, ticks: minutes(60) },
      [
        (simulation, step) => {
          if (step < 20) return undefined;
          const [creature] = simulation.state.creatures.values();
          if (!creature) return undefined;
          covered.add(creature.id);
          const { x, z } = creature.position;
          return edit({
            ops: [{ op: "prop.add", prop: "hollow:round-tree", position: { x, z }, scale: 2 }],
          });
        },
      ],
    );
    expectClean(report);
    const [log] = logs;
    if (!log?.result.ok) throw new Error(`The edit was refused: ${JSON.stringify(log?.result)}`);
    expect(log.result.relocated.map((r) => r.creatureId)).toEqual([...covered]);
    expect(events.filter((e) => e.type === "creature_relocated")).toHaveLength(1);
    // It carries on moving from where it was put.
    const [moved] = covered;
    expect(report.creatures[moved!]!.decisions).toBeGreaterThan(1);
  });
});

describe("removing what a creature relies on", () => {
  it("prunes food it was heading for, and it eats elsewhere", slow, () => {
    let removed: { creatureId: string; placementId: string } | undefined;
    const { report, logs, events, simulation } = runWithEdits(
      {
        ...hollow,
        speciesId: MOSSLING,
        seed: 2,
        creatures: 2,
        ticks: minutes(6 * 60),
        ...LIVING_BEHAVIOR_CHECKS,
      },
      [
        (simulation) => {
          for (const creature of simulation.state.creatures.values()) {
            if (creature.action?.id !== "core:eat") continue;
            const { placementId } = creature.action.state as { placementId: string };
            removed = { creatureId: creature.id, placementId };
            return edit({ ops: [{ op: "prop.remove", id: placementId }] });
          }
          return undefined;
        },
      ],
    );
    expectClean(report);
    expect(logs[0]?.result.ok).toBe(true);
    if (!removed) throw new Error("Nobody went to eat");
    const { creatureId, placementId } = removed;
    const creature = simulation.state.creatures.get(creatureId)!;
    expect(
      Object.values(creature.knowledge.places)
        .flat()
        .map((p) => p.placementId),
    ).not.toContain(placementId);
    // It ate again, somewhere else, after the edit.
    const edited = events.findIndex((e) => e.type === "world_edited");
    const meals = events
      .slice(edited)
      .filter((e) => e.type === "ate" && e.creatureId === creatureId);
    expect(meals.length).toBeGreaterThan(0);
    expect(meals.every((e) => e.type === "ate" && e.placementId !== placementId)).toBe(true);
  });

  it("prunes the home a creature sleeps at, and it sleeps elsewhere that night", slow, () => {
    let removed: { creatureId: string; placementId: string } | undefined;
    const { report, logs, events, simulation } = runWithEdits(
      {
        ...hollow,
        speciesId: MOSSLING,
        seed: 1,
        creatures: 2,
        // From the evening into the small hours.
        startMinutes: 19 * 60,
        ticks: minutes(7 * 60),
        ...LIVING_BEHAVIOR_CHECKS,
      },
      [
        (simulation) => {
          for (const creature of simulation.state.creatures.values()) {
            if (!creature.asleep || creature.home === null) continue;
            removed = { creatureId: creature.id, placementId: creature.home };
            return edit({ ops: [{ op: "prop.remove", id: creature.home }] });
          }
          return undefined;
        },
      ],
    );
    expectClean(report);
    expect(logs[0]?.result.ok).toBe(true);
    if (!removed) throw new Error("Nobody slept at home");
    const { creatureId, placementId } = removed;
    const creature = simulation.state.creatures.get(creatureId)!;
    expect(creature.home).not.toBe(placementId);
    // Woken by the edit, it fell asleep again, not at the removed home.
    const edited = events.findIndex((e) => e.type === "world_edited");
    const after = events
      .slice(edited)
      .filter((e) => "creatureId" in e && e.creatureId === creatureId);
    const slept = after.filter((e) => e.type === "fell_asleep");
    expect(slept.length).toBeGreaterThan(0);
    expect(slept.every((e) => e.type === "fell_asleep" && e.placementId !== placementId)).toBe(
      true,
    );
    expect(report.creatures[creatureId]!.asleepAtNightTicks).toBeGreaterThan(0);
  });
});

describe("blocking a way out of the water", () => {
  it("warns, and the creatures in the water still get out", slow, () => {
    const register = (registries: Registries) => [
      registries.assets.register({
        id: fixtureRoundTree.model,
        version: "1.0.0",
        kind: "model",
        url: "-",
      }),
      registries.props.register(fixtureRoundTree),
      ...registerPond(registries, pondWorld),
    ];
    // Trees along the south shore exit's portal, from x = 1 to 4 at z = 2.
    const trees = edit({
      ops: [1, 2, 3, 4].map((x) => ({
        op: "prop.add" as const,
        prop: fixtureRoundTree.id,
        position: { x, z: 2.6 },
        scale: 2.5,
      })),
    });
    const landings: string[] = [];
    const { report, logs, events } = runWithEdits(
      {
        register,
        worldId: pondWorld.id,
        speciesId: newt.id,
        seed: 1,
        creatures: 3,
        ticks: minutes(30),
        // Short walks in a small world, as for the river-crossing fixture.
        maxDecisionsPer10Seconds: 2,
      },
      [
        (simulation, step) => {
          if (step < 10) return undefined;
          // Once a newt is in the water.
          const swimming = [...simulation.state.creatures.values()].some(
            (c) => c.position.regionId === "pond",
          );
          return swimming ? trees : undefined;
        },
      ],
    );
    expectClean(report);
    const result = logs[0]?.result;
    if (!result?.ok) throw new Error(`The edit was refused: ${JSON.stringify(result)}`);
    expect(result.blockedExits.map((b) => b.exit)).toContainEqual({
      kind: "connection",
      connectionId: "south-shore",
    });
    expect(result.warnings.map((w) => w.code)).toContain("water_exit_blocked");
    // Newts still leave the water after it, by the banks.
    const edited = events.findIndex((e) => e.type === "world_edited");
    for (const e of events.slice(edited)) {
      if (e.type === "entered_region" && e.fromRegionId === "pond") landings.push(e.toRegionId);
    }
    expect(landings.length).toBeGreaterThan(0);
  });
});

describe("a prop scaled up over a walking creature's route", () => {
  it("makes it replan round the prop to the same goal, and walk on", slow, () => {
    let walk: { path: PathState; before: RegionPosition[] } | undefined;
    let after: RegionPosition[] | undefined;
    const { report, logs } = runWithEdits(
      { ...hollow, speciesId: MOSSLING, seed: 3, creatures: 1, ticks: minutes(30) },
      [
        (simulation) => {
          const [creature] = simulation.state.creatures.values();
          if (creature?.action?.id !== "core:follow_path") return undefined;
          const path = creature.action.state as PathState;
          const found = propOverRoute(simulation, creature.position, path);
          if (!found) return undefined;
          walk = { path, before: path.points.map((p) => ({ ...p })) };
          return edit({ ops: [{ op: "prop.scale", id: found.id, scale: found.scale }] });
        },
      ],
      (_log, simulation) => {
        // Right after the edit, before the next step: the same walk on a new route.
        const [creature] = simulation.state.creatures.values();
        expect(creature?.action?.state).toBe(walk?.path);
        after = walk?.path.points.map((p) => ({ ...p }));
        const { masks } = simulation.state.pathfinderFor(MOSSLING)!.navigation;
        for (const p of after ?? []) {
          expect(masks.get(p.regionId)!.isWalkableAt(p.x, p.z)).toBe(true);
        }
      },
    );
    expectClean(report);
    expect(logs[0]?.result.ok).toBe(true);
    if (!walk || !after) throw new Error("No walk passed close to a prop");
    expect(after).not.toEqual(walk.before);
    expect(after.at(-1)).toEqual(walk.before.at(-1));
  });
});

/**
 * A prop beside the route still to walk, on open ground, and the scale that grows its footprint
 * over the route but clear of the walker and the route's goal; undefined if none is near enough.
 */
function propOverRoute(
  simulation: Simulation,
  at: RegionPosition,
  path: PathState,
): { id: string; scale: number } | undefined {
  const { model, registries } = simulation.state;
  const goal = path.points.at(-1);
  if (!goal || path.points.length - path.next < 3) return undefined;
  const distance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);
  for (let k = path.next; k < path.points.length - 1; k++) {
    const a = k === path.next ? at : path.points[k]!;
    const b = path.points[k + 1]!;
    if (a.regionId !== b.regionId || model.regions.get(b.regionId)?.structureId) continue;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    for (const prop of model.props) {
      const typeRadius = registries.props.get(prop.prop)?.blockRadius ?? 0;
      if (typeRadius === 0) continue;
      const center = { x: prop.transform.position.x, z: prop.transform.position.z };
      const reach = distance(center, mid) + 0.3;
      const scale = reach / typeRadius;
      if (scale <= prop.transform.scale || scale > 3 * prop.transform.scale) continue;
      if (distance(center, at) < reach + 1 || distance(center, goal) < reach + 1) continue;
      return { id: prop.id, scale };
    }
  }
  return undefined;
}

describe("many quick successive edits", () => {
  const run = () => {
    const logs: EditLog[] = [];
    let final: Simulation | undefined;
    // 60 random edits, undos among them, over the first 30 s: often several between two steps.
    const random = randomEdits(5, 60, { count: 60 });
    const report = runWithInvariants({
      register: registerHollowCreatures,
      worldId: "hollow:woodland-hollow",
      speciesId: MOSSLING,
      alsoSpawn: { [otter.id]: 1, [carp.id]: 1 },
      seed: 5,
      creatures: 3,
      tickRateHz: HZ,
      ticks: minutes(20),
      edits: random,
      onEdit: (log) => logs.push(log),
      onEnd: (simulation) => (final = simulation),
    });
    return {
      report,
      logs,
      save: JSON.stringify(final!.save(0)),
      world: final!.state.model.definition,
    };
  };

  it("keeps every creature where it may be, and gives the same world every time", slow, () => {
    const a = run();
    expectClean(a.report);
    expect(a.logs).toHaveLength(60);
    expect(a.report.edits.applied).toBeGreaterThan(40);
    expect(a.report.edits.undos).toBeGreaterThan(0);
    const steps = a.logs.map((l) => l.step);
    expect(steps.length - new Set(steps).size).toBeGreaterThan(0);
    const b = run();
    expect(b.save).toBe(a.save);
    expect(b.world).toEqual(a.world);
    const untimed = (logs: EditLog[]) => logs.map((log) => ({ ...log, ms: 0 }));
    expect(untimed(b.logs)).toEqual(untimed(a.logs));
  });
});

describe("edit scripts", () => {
  it("reads edits and undos by tick, in tick order, and refuses a bad entry", () => {
    const script = parseEditScript([
      { tick: 20, undo: true },
      { tick: 10, edit: { ops: [{ op: "prop.remove", id: "rock-1" }] } },
    ]);
    expect(script.map((e) => e.step)).toEqual([10, 20]);
    const requests: EditRequest[] = [...scriptedEdits(script)(10, undefined as never)];
    expect(requests).toEqual([{ edit: { ops: [{ op: "prop.remove", id: "rock-1" }] } }]);
    expect(() => parseEditScript({})).toThrow(/JSON array/);
    expect(() => parseEditScript([{ tick: -1, undo: true }])).toThrow(/\[0\]\.tick/);
    expect(() => parseEditScript([{ tick: 1, edit: { ops: [] } }])).toThrow(/\[0\]\.edit/);
    expect(() => parseEditScript([{ tick: 1, undo: true, extra: 1 }])).toThrow(/unknown keys/);
  });
});

describe("the edit history of a run", () => {
  it("keeps an undo that is refused, so a later undo tries it again", () => {
    const add = edit({
      ops: [{ op: "prop.add", prop: "hollow:rock", position: { x: 12, z: 3 }, id: "p" }],
    });
    const remove = edit({ ops: [{ op: "prop.remove", id: "p" }] });
    const addAgain = edit({
      ops: [{ op: "prop.add", prop: "hollow:rock", position: { x: 14, z: 3 }, id: "p" }],
    });
    const logs: EditLog[] = [];
    // Behind the history's back, the rock goes before the first undo and comes back before the
    // second.
    const source = (step: number, simulation: Simulation): EditRequest[] => {
      if (step === 1) return [{ edit: add }];
      const outside = step === 2 ? remove : step === 3 ? addAgain : undefined;
      if (!outside) return [];
      expect(simulation.applyEdit(outside).ok).toBe(true);
      return [{ undo: true }];
    };
    const report = runWithInvariants({
      ...hollow,
      speciesId: MOSSLING,
      seed: 1,
      creatures: 1,
      tickRateHz: HZ,
      ticks: 10,
      edits: source,
      onEdit: (log) => logs.push(log),
    });
    expect(report.violations).toEqual([]);
    const outcomes = logs.map((l) => (l.result.ok ? "applied" : l.result.diagnostics[0]?.code));
    expect(outcomes).toEqual(["applied", "unknown_placement", "applied"]);
    // Both undos tried the add's inverse.
    expect(logs[1]?.edit).toEqual(logs[2]?.edit);
    expect(logs[2]?.edit?.ops).toEqual([{ op: "prop.remove", id: "p" }]);
    expect(report.edits).toMatchObject({
      applied: 2,
      undos: 1,
      rejected: { unknown_placement: 1 },
    });
  });
});

describe("the meal check after edits", () => {
  const food = () => {
    const content = loadContent(registerBuiltInContent);
    if (!content.ok) throw new Error(content.diagnostics.map(formatDiagnostic).join("\n"));
    const world = content.value.worlds.get(hollow.worldId)!;
    const registries = content.value;
    return world.props
      .filter((p) => Object.hasOwn(registries.props.get(p.prop)?.affordances ?? {}, "core:food"))
      .map((p) => p.id);
  };
  const run = (removed: readonly string[]) =>
    runWithEdits(
      {
        ...hollow,
        speciesId: MOSSLING,
        seed: 2,
        creatures: 2,
        ticks: minutes(6 * 60),
        ...LIVING_BEHAVIOR_CHECKS,
      },
      [
        (_simulation, step) =>
          step === 10
            ? edit({ ops: removed.map((id) => ({ op: "prop.remove" as const, id })) })
            : undefined,
      ],
    );

  it("still holds creatures that can reach other food", slow, () => {
    const { report, logs } = run(food().slice(0, 1));
    expect(logs[0]?.result.ok).toBe(true);
    expect(report.edits.foodCutOff).toBe(0);
    expectClean(report);
    // They went on eating, and were held to it.
    for (const c of Object.values(report.creatures)) expect(c.meals).toBeGreaterThan(0);
  });

  it("lets go of creatures only when no food is left in reach", slow, () => {
    const { report, logs } = run(food());
    expect(logs[0]?.result.ok).toBe(true);
    expect(report.edits.foodCutOff).toBe(2);
    expectClean(report);
    for (const c of Object.values(report.creatures)) expect(c.meals).toBe(0);
  });
});

describe("blocking the bridge", () => {
  it("leaves every creature where it may be, with no failed paths or stuck creatures", slow, () => {
    // Rocks over the bridge's west end (its portal runs from z = 0.3 to 1.7 at x = -5).
    const rocks = edit({
      ops: [0.4, 1, 1.6].map((z) => ({
        op: "prop.add" as const,
        prop: "hollow:rock",
        position: { x: -5.6, z },
        scale: 1.5,
      })),
    });
    const { report, logs, events } = runWithEdits(
      {
        ...hollow,
        speciesId: MOSSLING,
        seed: 1,
        creatures: 3,
        ticks: minutes(3 * 60),
        ...LIVING_BEHAVIOR_CHECKS,
      },
      [(_simulation, step) => (step === 600 ? rocks : undefined)],
    );
    const result = logs[0]?.result;
    if (!result?.ok) throw new Error(`The edit was refused: ${JSON.stringify(result)}`);
    // The portal is closed to mosslings: the edit warns that it is unusable.
    expect(result.warnings.map((w) => w.code)).toContain("portal_unusable");
    expect(result.warnings.find((w) => w.code === "portal_unusable")?.message).toContain(
      "bridge-west-end",
    );
    expectClean(report);
    // Nobody crosses the bridge after it.
    const edited = events.findIndex((e) => e.type === "world_edited");
    const crossings = events
      .slice(edited)
      .filter((e) => e.type === "entered_region" && e.connectionId === "bridge-west-end");
    expect(crossings).toEqual([]);
  });
});
