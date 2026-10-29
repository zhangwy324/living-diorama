import { registerBuiltInContent } from "@living-diorama/built-in-content";
import { formatDiagnostic } from "@living-diorama/content-schema";
import {
  createRegistries,
  resolveReferences,
  type Registries,
} from "@living-diorama/extension-api";
import {
  buildWorldModel,
  checkWorld,
  describeScene,
  registerCoreEngine,
  speciesProfiles,
  WorldState,
} from "@living-diorama/simulation";
import { registerHollowCreatures } from "./fixtures/hollow-creatures";

// `pnpm exec tsx tools/development/src/rebuild-time.ts`: times a full rebuild of Woodland Hollow,
// what an edit costs (ADR 0021): the world model, the navigation of every registered profile and
// their pathfinders (`WorldState.create`), and the scene data. Once with the built-in content
// alone, once with the test species of the soak too, which add profiles.

const WORLD = "hollow:woodland-hollow";
const RUNS = 30;
const WARMUP = 5;

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
  console.log(`${label.padEnd(48)} min ${min}  median ${median}  max ${max} ms`);
}

for (const [name, register] of [
  ["built-in content", registerBuiltInContent],
  ["built-in + hollow creatures (soak set)", registerHollowCreatures],
] as const) {
  const registries = load(register);
  const world = registries.worlds.get(WORLD);
  if (!world) throw new Error(`${WORLD} is not registered`);
  console.log(`\n${name}: ${speciesProfiles(registries).length} profiles`);
  time("world model only", () => buildWorldModel(world, registries));
  time("checkWorld (model + nav per profile)", () => checkWorld(world, registries));
  time("WorldState.create (+ pathfinders)", () => {
    const r = WorldState.create(registries, { worldId: WORLD, seed: 1 });
    if (!r.ok) throw new Error(r.diagnostics.map(formatDiagnostic).join("\n"));
    return r;
  });
  const state = WorldState.create(registries, { worldId: WORLD, seed: 1 });
  if (state.ok) time("describeScene (scene data)", () => describeScene(state.value.model));
}
