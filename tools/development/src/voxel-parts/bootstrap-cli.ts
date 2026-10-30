import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { bootstrapParts } from "./bootstrap";
import { DEFAULT_SOURCE_DIR } from "./build";
import { STARTER_PARTS } from "./starter-parts";

// `pnpm parts:bootstrap [--out <dir>] [--force]`: writes the starter parts' first-pass `.vox`
// files and sidecars from their recipes (`starter-parts.ts`) into `--out`, keeping every file
// already there unless `--force`. Then run `pnpm parts` to make the part definitions.

const { values } = parseArgs({
  options: {
    out: { type: "string", default: DEFAULT_SOURCE_DIR },
    force: { type: "boolean", default: false },
  },
});
const dir = resolve(values.out);
const { written, kept } = bootstrapParts(STARTER_PARTS, dir, { force: values.force });
for (const file of written) console.log(`wrote ${file}`);
console.log(
  `wrote ${written.length} files to ${dir}, kept ${kept.length} already there` +
    (kept.length > 0 && !values.force ? " (--force overwrites them)" : ""),
);
console.log("Now run `pnpm parts` to make the part definitions.");
