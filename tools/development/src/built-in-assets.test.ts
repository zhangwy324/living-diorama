import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtInAssets } from "@living-diorama/built-in-content";
import { expect, it } from "vitest";

// The pack's asset URLs are file URLs under Node, so every registered file can be checked here.

it("ships every file the built-in pack registers, models as binary glTF", () => {
  expect(builtInAssets.length).toBeGreaterThan(0);
  for (const asset of builtInAssets) {
    const bytes = readFileSync(fileURLToPath(asset.url));
    if (asset.kind === "model") {
      expect(bytes.subarray(0, 4).toString("latin1"), asset.id).toBe("glTF");
    } else {
      expect(bytes.length, asset.id).toBeGreaterThan(0);
    }
  }
});
