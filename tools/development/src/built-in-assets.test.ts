import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { builtInAssets } from "@living-diorama/built-in-content";
import { formatDiagnostic, validate, VoxelAssemblySchema } from "@living-diorama/content-schema";
import { expect, it } from "vitest";

// The pack's asset URLs are file URLs under Node, so every registered file can be checked here.

it("ships every file the built-in pack registers, models as binary glTF and voxel assemblies as valid JSON", () => {
  expect(builtInAssets.length).toBeGreaterThan(0);
  for (const asset of builtInAssets) {
    const bytes = readFileSync(fileURLToPath(asset.url));
    if (asset.kind === "model") {
      expect(bytes.subarray(0, 4).toString("latin1"), asset.id).toBe("glTF");
    } else if (asset.kind === "voxel") {
      const parsed = validate(VoxelAssemblySchema, JSON.parse(bytes.toString("utf8")), asset.id);
      expect(parsed.ok ? [] : parsed.diagnostics.map(formatDiagnostic), asset.id).toEqual([]);
    } else {
      expect(bytes.length, asset.id).toBeGreaterThan(0);
    }
  }
});
