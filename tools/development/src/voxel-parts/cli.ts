import { formatDiagnostic } from "@living-diorama/content-schema";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildParts, DEFAULT_OUTPUT_DIR, DEFAULT_SOURCE_DIR, writeParts } from "./build";

// `pnpm parts [--in <dir>] [--out <dir>]`: turns every `<name>.vox` in `--in` and its sidecar
// `<name>.json` into a part definition `<name>.json` in `--out`, and removes outputs whose source
// is gone. Writes nothing if any part has an error.

const { values } = parseArgs({
  options: {
    in: { type: "string", default: DEFAULT_SOURCE_DIR },
    out: { type: "string", default: DEFAULT_OUTPUT_DIR },
  },
});
const sourceDir = resolve(values.in);
const outputDir = resolve(values.out);

const { outputs, diagnostics } = buildParts(sourceDir);
for (const d of diagnostics) console.log(formatDiagnostic(d));
if (diagnostics.length > 0) {
  console.log(`${diagnostics.length} errors in ${sourceDir}; nothing written`);
  process.exitCode = 1;
} else {
  const removed = writeParts(outputs, outputDir);
  for (const file of removed) console.log(`removed ${file}`);
  console.log(`wrote ${outputs.size} parts from ${sourceDir} to ${outputDir}`);
}
