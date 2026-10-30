import { formatDiagnostic, type WorldDefinition } from "@living-diorama/content-schema";
import { builtInAssets, builtInDefinitions } from "@living-diorama/built-in-content";
import { createRegistries, resolveReferences } from "@living-diorama/extension-api";
import { checkWorld, registerCoreEngine } from "@living-diorama/simulation";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderDebugMap } from "./debug-map";
import { formatWorldJson } from "./format";
import { generateWoodlandHollow } from "./woodland-hollow";

// `pnpm worldgen`: regenerates the built-in world, checks it and writes a debug map.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const worldPath = resolve(root, "packages/built-in-content/src/woodland-hollow/world.json");
const mapPath = resolve(root, "tools/development/out/woodland-hollow.png");

const world = generateWoodlandHollow();
writeFileSync(worldPath, formatWorldJson(world));
console.log(`wrote ${worldPath}`);

const registries = createRegistries();
const results = [
  ...registerCoreEngine(registries),
  ...builtInAssets.map((a) => registries.assets.register(a)),
  ...builtInDefinitions.structures.map((d) => registries.structures.register(d)),
  ...builtInDefinitions.propCategories.map((d) => registries.propCategories.register(d)),
  ...builtInDefinitions.props.map((d) => registries.props.register(d)),
  ...builtInDefinitions.species.map((d) => registries.species.register(d)),
  registries.worlds.register(world),
];
const diagnostics = [
  ...results.flatMap((r) => (r.ok ? [] : r.diagnostics)),
  ...resolveReferences(registries).diagnostics,
];
const registered = registries.worlds.get(world.id) as WorldDefinition | undefined;
const check = registered ? checkWorld(registered, registries) : undefined;
diagnostics.push(...(check?.diagnostics ?? []));
for (const d of diagnostics) console.log(formatDiagnostic(d));

if (registered && check?.model && check.navigations[0]) {
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, renderDebugMap(registered, check.model, check.navigations[0]));
  console.log(`wrote ${mapPath}`);
}
console.log(`${world.props.length} props, ${diagnostics.length} diagnostics`);
process.exitCode = diagnostics.some((d) => d.severity === "error") ? 1 : 0;
