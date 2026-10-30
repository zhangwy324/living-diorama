import { registerBuiltInContent } from "@living-diorama/built-in-content";
import {
  formatDiagnostic,
  parseWorldEdit,
  type RegionPosition,
  type WorldEdit,
  type WorldEditInput,
} from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  buildWorldModel,
  CellState,
  checkWorld,
  describeScene,
  registerCoreEngine,
  speciesProfiles,
  WorldState,
  type Pathfinder,
  type Simulation,
} from "@living-diorama/simulation";
import { beaver, carp, otter, registerHollowCreatures } from "./fixtures/hollow-creatures";
import { createSimulation } from "./simulation-run";

// `pnpm rebuild-time`: times a full rebuild of Woodland Hollow, what a world edit costs (ADR
// 0021), once with the built-in content alone and once with the soak's test species too, which
// add navigation profiles. It times the parts (the world model, the world check with the
// navigation of every profile, `WorldState.create`, which adds the pathfinders, and the scene
// data) and a realistic edit: `WorldState.create`, then per profile the pathfinder data it builds
// lazily (every connection's crossings, every region's areas and the banks' crossings, as the
// relocation and blocked-exit checks need), then `ROUTES` route queries per profile between fixed
// walkable cells, as creatures replanning after the edit would make.
//
// Then it times the edit itself in a running world of `CREATURES` creatures (mosslings, plus the
// soak's amphibians and swimmer with the test species): `Simulation.validateEdit` and
// `Simulation.applyEdit`, which add the reconcile (relocations, pruning and every creature's
// replan) to the rebuild. Each timed apply is one of `EDITS` (a move, a scale, an add, a removal)
// or the undo of the one before, so the world comes back to where it started.

const WORLD = "hollow:woodland-hollow";
const MOSSLING = "hollow:mossling";
const RUNS = 30;
const WARMUP = 5;
const ROUTES = 20;
const CREATURES = 20;
const EDITS: WorldEditInput[] = [
  { ops: [{ op: "prop.move", id: "rock-2", position: { x: 10, z: -2 } }] },
  { ops: [{ op: "prop.scale", id: "pine-1", scale: 1.5 }] },
  { ops: [{ op: "prop.add", prop: "hollow:bush", position: { x: 12, z: 3 } }] },
  { ops: [{ op: "prop.remove", id: "bush-3" }] },
];

function load(register: (r: Registries) => unknown): Registries {
  const registries = createRegistries();
  registerCoreEngine(registries);
  register(registries);
  const res = resolveReferences(registries);
  if (res.diagnostics.some((d) => d.severity === "error")) {
    throw new Error(res.diagnostics.map(formatDiagnostic).join("\n"));
  }
  return registries;
}

function time(label: string, fn: () => unknown) {
  for (let i = 0; i < WARMUP; i++) fn();
  const ms: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const [min, median, max] = [ms[0], ms[Math.floor(ms.length / 2)], ms[ms.length - 1]].map((t) =>
    (t ?? NaN).toFixed(1),
  );
  console.log(`${label.padEnd(52)} min ${min}  median ${median}  max ${max} ms`);
}

function create(registries: Registries): WorldState {
  const r = WorldState.create(registries, { worldId: WORLD, seed: 1 });
  if (!r.ok) throw new Error(r.diagnostics.map(formatDiagnostic).join("\n"));
  return r.value;
}

/** The pathfinder data a rebuild needs at once: crossings, areas and bank crossings. */
function buildLazyData(pathfinder: Pathfinder): void {
  for (const connection of pathfinder.world.connections) pathfinder.crossings(connection);
  for (const [regionId, mask] of pathfinder.navigation.masks) {
    pathfinder.bankCrossings(regionId);
    const cell = mask.components()[0]?.[0];
    if (cell !== undefined) pathfinder.reachableCells({ regionId, ...mask.center(cell) });
  }
}

/** `count` start and goal positions on walkable cells of a profile, drawn from a fixed seed. */
function routeQueries(pathfinder: Pathfinder, count: number) {
  const cells: RegionPosition[] = [];
  for (const [regionId, mask] of pathfinder.navigation.masks) {
    for (let cell = 0; cell < mask.states.length; cell++) {
      if (mask.state(cell) === CellState.walkable) cells.push({ regionId, ...mask.center(cell) });
    }
  }
  let seed = 12345;
  const draw = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    const position = cells[seed % cells.length];
    if (!position) throw new Error("No walkable cell");
    return position;
  };
  return Array.from({ length: count }, () => ({ from: draw(), to: draw() }));
}

/** `EDITS` as the worker would take them. */
function parsedEdits(): WorldEdit[] {
  return EDITS.map((input) => {
    const parsed = parseWorldEdit(input);
    if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
    return parsed.value;
  });
}

/** Woodland Hollow with `CREATURES` creatures of `species`, in turn, a minute into their day. */
function livingWorld(register: (r: Registries) => unknown, species: readonly string[]) {
  const simulation = createSimulation({ register, worldId: WORLD, seed: 1 });
  for (let n = 0; n < CREATURES; n++) {
    const spawned = simulation.spawn(species[n % species.length] ?? "");
    if (!spawned.ok) throw new Error(spawned.diagnostics.map(formatDiagnostic).join("\n"));
  }
  for (let n = 0; n < 600; n++) simulation.step();
  return simulation;
}

/** Times `validateEdit` and `applyEdit`, each apply an edit of `EDITS` or the undo of the last. */
function timeEdits(simulation: Simulation): void {
  const edits = parsedEdits();
  let next = 0;
  time("validateEdit", () => simulation.validateEdit(edits[next++ % edits.length] as WorldEdit));
  let undo: WorldEdit | undefined;
  time("applyEdit (an edit, then its undo)", () => {
    const edit = undo ?? (edits[next++ % edits.length] as WorldEdit);
    const result = simulation.applyEdit(edit);
    if (!result.ok) throw new Error(result.diagnostics.map(formatDiagnostic).join("\n"));
    undo = undo ? undefined : result.inverse;
  });
}

for (const [name, register, species] of [
  ["built-in content", registerBuiltInContent, [MOSSLING]],
  [
    "built-in + hollow creatures (soak set)",
    registerHollowCreatures,
    [MOSSLING, MOSSLING, MOSSLING, otter.id, beaver.id, carp.id],
  ],
] as const) {
  const registries = load(register);
  const world = registries.worlds.get(WORLD);
  if (!world) throw new Error(`${WORLD} is not registered`);
  console.log(`\n${name}: ${speciesProfiles(registries).length} profiles`);
  time("world model only", () => buildWorldModel(world, registries));
  time("checkWorld (model + nav per profile)", () => checkWorld(world, registries));
  time("WorldState.create (+ pathfinders)", () => create(registries));
  const state = create(registries);
  time("describeScene (scene data)", () => describeScene(state.model));

  const pathfinders = (s: WorldState) =>
    [...registries.species.values()]
      .map((species) => s.pathfinderFor(species.id))
      .filter((p, i, all): p is Pathfinder => p !== undefined && all.indexOf(p) === i);
  const queries = new Map(
    pathfinders(state).map((p) => [p.navigation.profile.key, routeQueries(p, ROUTES)]),
  );

  time("create + crossings, areas, banks per profile", () => {
    for (const p of pathfinders(create(registries))) buildLazyData(p);
  });
  time(`realistic edit (+ ${ROUTES} routes per profile)`, () => {
    for (const p of pathfinders(create(registries))) {
      buildLazyData(p);
      for (const { from, to } of queries.get(p.navigation.profile.key) ?? []) {
        p.findRoute(from, to);
      }
    }
  });
  timeEdits(livingWorld(register, species));
}
