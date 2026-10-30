import { error, type Diagnostic } from "@living-diorama/content-schema";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPartDefinition, partDefinition } from "./part-definition";
import { parseVox } from "./vox-parser";

// `pnpm parts`' file handling: every `<name>.vox` in a source folder with its sidecar
// `<name>.json` becomes `<name>.json`, a part definition, in an output folder that holds nothing
// else.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const partsDir = resolve(root, "packages/built-in-content/src/woodland-hollow/voxel-parts");

/** The built-in pack's `.vox` files and sidecars. */
export const DEFAULT_SOURCE_DIR = join(partsDir, "vox");
/** The built-in pack's generated part definitions; never edit them by hand. */
export const DEFAULT_OUTPUT_DIR = join(partsDir, "parts");

const filesIn = (dir: string, extension: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((file) => extname(file).toLowerCase() === extension)
        .sort()
    : [];

export interface BuiltParts {
  /** Output file name → its text. Empty when there are errors. */
  outputs: Map<string, string>;
  diagnostics: Diagnostic[];
}

/** Reads every `.vox` in `sourceDir` with its sidecar. All or nothing: any error, no outputs. */
export function buildParts(sourceDir: string): BuiltParts {
  const outputs = new Map<string, string>();
  const diagnostics: Diagnostic[] = [];
  const voxFiles = filesIn(sourceDir, ".vox");
  const names = new Set(voxFiles.map((file) => basename(file, extname(file))));
  for (const file of filesIn(sourceDir, ".json")) {
    if (!names.has(basename(file, ".json"))) {
      diagnostics.push(error("orphan_sidecar", "A sidecar with no .vox file beside it", [], file));
    }
  }
  const ids = new Map<string, string>();
  for (const file of voxFiles) {
    const name = basename(file, extname(file));
    const sidecarFile = `${name}.json`;
    const sidecarPath = join(sourceDir, sidecarFile);
    if (!existsSync(sidecarPath)) {
      diagnostics.push(error("missing_sidecar", `No sidecar ${sidecarFile} beside it`, [], file));
      continue;
    }
    const cubes = parseVox(new Uint8Array(readFileSync(join(sourceDir, file))), file);
    if (!cubes.ok) {
      diagnostics.push(...cubes.diagnostics);
      continue;
    }
    let sidecar: unknown;
    try {
      sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    } catch (e) {
      diagnostics.push(error("invalid_json", String(e), [], sidecarFile));
      continue;
    }
    const definition = partDefinition(cubes.value, sidecar, {
      source: file,
      sidecarSource: sidecarFile,
    });
    if (!definition.ok) {
      diagnostics.push(...definition.diagnostics);
      continue;
    }
    const { id } = definition.value;
    const other = ids.get(id);
    if (other !== undefined) {
      diagnostics.push(
        error("duplicate_id", `Part ID "${id}" is also ${other}'s`, ["id"], sidecarFile),
      );
      continue;
    }
    ids.set(id, sidecarFile);
    outputs.set(`${name}.json`, formatPartDefinition(definition.value));
  }
  return { outputs: diagnostics.length > 0 ? new Map() : outputs, diagnostics };
}

/** The `.json` files in an output folder, name → text. */
export function readParts(outputDir: string): Map<string, string> {
  return new Map(
    filesIn(outputDir, ".json").map((file) => [file, readFileSync(join(outputDir, file), "utf8")]),
  );
}

/**
 * Writes `outputs` into `outputDir` and removes the `.json` files there that aren't among them,
 * so the folder matches its sources. Returns the files removed.
 */
export function writeParts(outputs: Map<string, string>, outputDir: string): string[] {
  const stale = filesIn(outputDir, ".json").filter((file) => !outputs.has(file));
  for (const file of stale) rmSync(join(outputDir, file));
  if (outputs.size > 0) mkdirSync(outputDir, { recursive: true });
  for (const [file, text] of outputs) writeFileSync(join(outputDir, file), text);
  return stale;
}
