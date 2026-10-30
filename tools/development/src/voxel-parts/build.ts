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

/** A `.vox` file and its sidecar's file name. */
export interface PartSource {
  /** The output's name without `.json`: the `.vox` file's name without its extension. */
  name: string;
  vox: string;
  sidecar: string;
}

/**
 * Pairs each `.vox` in a folder's listing with its sidecar, matching names and extensions
 * ignoring case, as Windows does, so a folder builds the same on every system. Two files of one
 * kind whose names differ only by case, a `.vox` with no sidecar and a sidecar with no `.vox` are
 * errors. Other files are ignored.
 */
export function pairSources(files: readonly string[]): {
  sources: PartSource[];
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const key = (file: string) => basename(file, extname(file)).toLowerCase();
  const byName = (extension: string) => {
    const out = new Map<string, string>();
    for (const file of files.filter((f) => extname(f).toLowerCase() === extension).sort()) {
      const other = out.get(key(file));
      if (other === undefined) out.set(key(file), file);
      else {
        diagnostics.push(
          error("duplicate_name", `Its name differs from ${other}'s only by case`, [], file),
        );
      }
    }
    return out;
  };
  const voxFiles = byName(".vox");
  const sidecars = byName(".json");
  for (const [name, file] of sidecars) {
    if (!voxFiles.has(name)) {
      diagnostics.push(error("orphan_sidecar", "A sidecar with no .vox file beside it", [], file));
    }
  }
  const sources: PartSource[] = [];
  for (const [name, vox] of voxFiles) {
    const sidecar = sidecars.get(name);
    const base = basename(vox, extname(vox));
    if (sidecar === undefined) {
      diagnostics.push(error("missing_sidecar", `No sidecar ${base}.json beside it`, [], vox));
    } else {
      sources.push({ name: base, vox, sidecar });
    }
  }
  return { sources, diagnostics };
}

export interface BuiltParts {
  /** Output file name → its text. Empty when there are errors. */
  outputs: Map<string, string>;
  diagnostics: Diagnostic[];
}

/** Reads every `.vox` in `sourceDir` with its sidecar. All or nothing: any error, no outputs. */
export function buildParts(sourceDir: string): BuiltParts {
  const outputs = new Map<string, string>();
  const { sources, diagnostics } = pairSources(existsSync(sourceDir) ? readdirSync(sourceDir) : []);
  const ids = new Map<string, string>();
  for (const { name, vox, sidecar: sidecarFile } of sources) {
    const cubes = parseVox(new Uint8Array(readFileSync(join(sourceDir, vox))), vox);
    if (!cubes.ok) {
      diagnostics.push(...cubes.diagnostics);
      continue;
    }
    let sidecar: unknown;
    try {
      // Some Windows editors start UTF-8 files with a byte order mark, which JSON.parse refuses.
      const text = readFileSync(join(sourceDir, sidecarFile), "utf8");
      sidecar = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
    } catch (e) {
      diagnostics.push(error("invalid_json", String(e), [], sidecarFile));
      continue;
    }
    const definition = partDefinition(cubes.value, sidecar, {
      source: vox,
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

const BOM = String.fromCharCode(0xfeff);

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
