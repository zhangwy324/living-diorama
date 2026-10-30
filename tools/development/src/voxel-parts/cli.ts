import { formatDiagnostic } from "@living-diorama/content-schema";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildParts, DEFAULT_OUTPUT_DIR, DEFAULT_SOURCE_DIR, writeParts } from "./build";
import { MOSSLING_ASSEMBLY_FILE, mosslingAssemblyText } from "./mossling";

// `pnpm parts [--in <dir>] [--out <dir>]`: turns every `<name>.vox` in `--in` and its sidecar
// `<name>.json` into a part definition `<name>.json` in `--out`, and removes outputs whose source
// is gone. Writes nothing if any part has an error. With neither option, the built-in pack's run,
// it then freezes the mossling species' assembly again from the parts it wrote.

const { values } = parseArgs({
  options: {
    in: { type: "string" },
    out: { type: "string" },
  },
});
const builtIn = values.in === undefined && values.out === undefined;
const sourceDir = resolve(values.in ?? DEFAULT_SOURCE_DIR);
const outputDir = resolve(values.out ?? DEFAULT_OUTPUT_DIR);

const { outputs, diagnostics } = buildParts(sourceDir);
for (const d of diagnostics) console.log(formatDiagnostic(d));
if (diagnostics.length > 0) {
  console.log(`${diagnostics.length} errors in ${sourceDir}; nothing written`);
  process.exitCode = 1;
} else {
  const removed = writeParts(outputs, outputDir);
  for (const file of removed) console.log(`removed ${file}`);
  console.log(`wrote ${outputs.size} parts from ${sourceDir} to ${outputDir}`);
  if (builtIn) {
    const definitions = [...outputs.values()].map((text) => JSON.parse(text) as { id: string });
    mkdirSync(dirname(MOSSLING_ASSEMBLY_FILE), { recursive: true });
    writeFileSync(MOSSLING_ASSEMBLY_FILE, mosslingAssemblyText(definitions));
    console.log(`wrote ${MOSSLING_ASSEMBLY_FILE}`);
  }
}
