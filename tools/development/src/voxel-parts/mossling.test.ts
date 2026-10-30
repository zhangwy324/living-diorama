import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MOSSLING_ASSEMBLY_FILE, mosslingAssemblyText } from "./mossling";

// Like world.json and `pnpm worldgen`: the committed asset must be what its generator gives.
it("the mossling's frozen assembly matches its parts (run `pnpm mossling` after `pnpm parts`)", () => {
  expect(readFileSync(MOSSLING_ASSEMBLY_FILE, "utf8")).toBe(mosslingAssemblyText());
});
