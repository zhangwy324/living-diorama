import { builtInDefinitions, mosslingAssembly } from "@living-diorama/built-in-content";
import {
  formatDiagnostic,
  parsePartDefinition,
  type VoxelPart,
} from "@living-diorama/content-schema";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Written by `pnpm parts`' default run (ADR 0022, M20 decisions "The mossling's assembly is a
// frozen asset"): the mossling built from the built-in pack's parts, as assembly JSON in the
// format of a library entry's. Each part in it is a frozen copy with its definition's ID as
// `source`, so it doesn't change when a part does until `pnpm parts` is run again; a test says
// when that's due.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The mossling species' appearance asset, generated; never edit it by hand. */
export const MOSSLING_ASSEMBLY_FILE = resolve(
  root,
  "packages/built-in-content/src/woodland-hollow/assets/voxels/mossling.json",
);

/** A part of `definitions`, by ID. */
function partIn(definitions: readonly { id: string }[], id: string): VoxelPart {
  const raw = definitions.find((d) => d.id === id);
  if (!raw) throw new Error(`The built-in pack has no part ${id}`);
  const parsed = parsePartDefinition(raw, id);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  return parsed.value.part;
}

/**
 * The mossling's assembly as the text of its asset: two-space JSON, each part's runs on one line
 * as in the part definitions `pnpm parts` writes. Built from `definitions`, by default the built-in
 * pack's registered ones; `pnpm parts` passes the definitions it has just written, since the
 * pack's imports of them were read before it wrote them.
 */
export function mosslingAssemblyText(
  definitions: readonly { id: string }[] = builtInDefinitions.parts,
): string {
  const assembly = mosslingAssembly((id) => partIn(definitions, id));
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
