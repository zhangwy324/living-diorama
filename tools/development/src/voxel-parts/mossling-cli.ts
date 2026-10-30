import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MOSSLING_ASSEMBLY_FILE, mosslingAssemblyText } from "./mossling";

// `pnpm mossling`: freezes the mossling's assembly from the built-in pack's parts as the mossling
// species' appearance asset. Run it after `pnpm parts` when a part the mossling uses changes.

mkdirSync(dirname(MOSSLING_ASSEMBLY_FILE), { recursive: true });
writeFileSync(MOSSLING_ASSEMBLY_FILE, mosslingAssemblyText());
console.log(`wrote ${MOSSLING_ASSEMBLY_FILE}`);
