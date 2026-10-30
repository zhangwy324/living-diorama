import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StarterPart } from "./starter-parts";
import { writeVox } from "./vox-writer";

// `pnpm parts:bootstrap`'s file handling: writes each recipe's `<file>.vox` and sidecar
// `<file>.json` into a source folder, keeping every file already there unless forced, since the
// files, once written, are the parts' sources and may have been edited.

/** A sidecar as written: two-space JSON, as Prettier keeps it. */
export const formatSidecar = (sidecar: StarterPart["sidecar"]): string =>
  `${JSON.stringify(sidecar, null, 2)}\n`;

export interface Bootstrapped {
  written: string[];
  kept: string[];
}

/**
 * Writes the `.vox` file and sidecar of every part into `dir`. A file that already exists is kept
 * unless `force`, which overwrites it with the recipe's.
 */
export function bootstrapParts(
  parts: readonly StarterPart[],
  dir: string,
  { force = false }: { force?: boolean } = {},
): Bootstrapped {
  mkdirSync(dir, { recursive: true });
  const result: Bootstrapped = { written: [], kept: [] };
  for (const part of parts) {
    const files: [string, () => Uint8Array | string][] = [
      [`${part.file}.vox`, () => writeVox(part.cubes())],
      [`${part.file}.json`, () => formatSidecar(part.sidecar)],
    ];
    for (const [file, contents] of files) {
      if (!force && existsSync(join(dir, file))) {
        result.kept.push(file);
        continue;
      }
      writeFileSync(join(dir, file), contents());
      result.written.push(file);
    }
  }
  return result;
}

/** The parts named by file (`round-eye`), or all of them when none are named. */
export function selectParts(
  parts: readonly StarterPart[],
  names: readonly string[],
): StarterPart[] {
  if (names.length === 0) return [...parts];
  const unknown = names.filter((name) => !parts.some((p) => p.file === name));
  if (unknown.length > 0) {
    throw new Error(
      `No starter part ${unknown.join(", ")}; the parts are ${parts.map((p) => p.file).join(", ")}`,
    );
  }
  return parts.filter((p) => names.includes(p.file));
}
