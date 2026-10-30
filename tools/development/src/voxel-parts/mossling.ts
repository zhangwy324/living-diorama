import { builtInDefinitions, mosslingAssembly } from "@living-diorama/built-in-content";
import {
  formatDiagnostic,
  parsePartDefinition,
  type VoxelPart,
} from "@living-diorama/content-schema";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `pnpm mossling`'s output (ADR 0022, M20 decisions "The mossling's assembly is a frozen asset"):
// the mossling built from the built-in pack's parts, as assembly JSON in the format of a library
// entry's. Each part in it is a frozen copy with its definition's ID as `source`, so it doesn't
// change when a part does until `pnpm mossling` is run again; a test says when that's due.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The mossling species' appearance asset, generated; never edit it by hand. */
export const MOSSLING_ASSEMBLY_FILE = resolve(
  root,
  "packages/built-in-content/src/woodland-hollow/assets/voxels/mossling.json",
);

/** The built-in pack's parts as registered, by ID. */
function builtInPart(id: string): VoxelPart {
  const raw = builtInDefinitions.parts.find((d) => d.id === id);
  if (!raw) throw new Error(`The built-in pack has no part ${id}`);
  const parsed = parsePartDefinition(raw, id);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  return parsed.value.part;
}

/**
 * The mossling's assembly as the text of its asset: two-space JSON, each part's runs on one line
 * as in the part definitions `pnpm parts` writes.
 */
export function mosslingAssemblyText(): string {
  const assembly = mosslingAssembly(builtInPart);
  const runs: number[][] = [];
  const json = JSON.stringify(
    assembly,
    (key, value: unknown) => {
      if (key !== "voxels") return value;
      runs.push(value as number[]);
      return `@@voxels-${runs.length - 1}@@`;
    },
    2,
  );
  return `${json.replace(/"@@voxels-(\d+)@@"/g, (_, i: string) => JSON.stringify(runs[Number(i)]))}\n`;
}
