import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { bootstrapParts, selectParts } from "./bootstrap";
import { DEFAULT_SOURCE_DIR } from "./build";
import { STARTER_PARTS } from "./starter-parts";

// `pnpm parts:bootstrap [--out <dir>] [--force] [<part>…]`: writes the starter parts' first-pass
// `.vox` files and sidecars from their recipes (`starter-parts.ts`) into `--out`, keeping every
// file already there unless `--force`. Parts named by file (`round-eye`) limit it to those, so
// `--force round-eye` makes only the round eye again; `--force` with no names overwrites every
// part, losing any refinement made since. Then run `pnpm parts` to make the part definitions.

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", default: DEFAULT_SOURCE_DIR },
    force: { type: "boolean", default: false },
  },
});
const dir = resolve(values.out);
const parts = selectParts(STARTER_PARTS, positionals);
if (values.force && positionals.length === 0) {
  console.log("--force with no parts named: overwriting EVERY starter part with its recipe");
}
const { written, kept } = bootstrapParts(parts, dir, { force: values.force });
for (const file of written) console.log(`wrote ${file}`);
console.log(
  `wrote ${written.length} files to ${dir}, kept ${kept.length} already there` +
    (kept.length > 0 && !values.force ? " (--force <part> overwrites one)" : ""),
);
console.log("Now run `pnpm parts` to make the part definitions.");
