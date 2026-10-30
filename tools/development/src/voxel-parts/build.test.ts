import { formatDiagnostic } from "@living-diorama/content-schema";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildParts, DEFAULT_OUTPUT_DIR, DEFAULT_SOURCE_DIR, readParts, writeParts } from "./build";
import { writeVox } from "./vox-writer";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "vox-parts-"));
  dirs.push(dir);
  return dir;
};

const eye = writeVox({
  size: { x: 1, y: 1, z: 1 },
  colors: ["#1d1d1d"],
  grid: new Uint8Array([1]),
});
const sidecar = (id: string) =>
  JSON.stringify({
    id,
    version: "1.0.0",
    name: "Eye",
    type: "hollow:eye",
    step: 0.025,
    attach: { x: 0, y: 0.5, z: 0.5 },
  });

describe("buildParts", () => {
  it("turns each .vox and its sidecar into a part definition", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "eye.vox"), eye);
    writeFileSync(join(dir, "eye.json"), sidecar("hollow:dot-eye"));
    const { outputs, diagnostics } = buildParts(dir);
    expect(diagnostics).toEqual([]);
    expect([...outputs.keys()]).toEqual(["eye.json"]);
    expect(JSON.parse(outputs.get("eye.json") ?? "")).toMatchObject({
      id: "hollow:dot-eye",
      part: { type: "hollow:eye", size: { x: 1, y: 1, z: 1 }, voxels: [1, 1] },
    });
  });

  it("is all or nothing, and reports missing and orphan sidecars and duplicate IDs", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.vox"), eye);
    writeFileSync(join(dir, "a.json"), sidecar("hollow:dot-eye"));
    writeFileSync(join(dir, "b.vox"), eye);
    writeFileSync(join(dir, "b.json"), sidecar("hollow:dot-eye"));
    writeFileSync(join(dir, "c.vox"), eye);
    writeFileSync(join(dir, "d.json"), sidecar("hollow:other-eye"));
    writeFileSync(join(dir, "e.vox"), new Uint8Array([1, 2, 3]));
    writeFileSync(join(dir, "e.json"), sidecar("hollow:e"));
    writeFileSync(join(dir, "f.vox"), eye);
    writeFileSync(join(dir, "f.json"), "{ not json");
    const { outputs, diagnostics } = buildParts(dir);
    expect(outputs.size).toBe(0);
    expect(diagnostics.map((d) => `${d.source} ${d.code}`)).toEqual([
      "d.json orphan_sidecar",
      "b.json duplicate_id",
      "c.vox missing_sidecar",
      "e.vox vox_not_vox",
      "f.json invalid_json",
    ]);
  });

  it("reads a missing source folder as no parts", () => {
    expect(buildParts(join(tempDir(), "none"))).toEqual({ outputs: new Map(), diagnostics: [] });
  });
});

describe("writeParts", () => {
  it("writes the outputs and removes stale ones", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "old.json"), "{}\n");
    writeFileSync(join(dir, "notes.txt"), "kept\n");
    expect(writeParts(new Map([["new.json", "{}\n"]]), dir)).toEqual(["old.json"]);
    expect(readdirSync(dir).sort()).toEqual(["new.json", "notes.txt"]);
  });
});

describe("the built-in pack's voxel parts", () => {
  // Like world.json and `pnpm worldgen`: the committed definitions must be what the sources give.
  // With no sources yet both sides are empty.
  it("match their .vox sources (run `pnpm parts` after changing a part)", () => {
    const { outputs, diagnostics } = buildParts(DEFAULT_SOURCE_DIR);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(readParts(DEFAULT_OUTPUT_DIR)).toEqual(outputs);
  });
});
