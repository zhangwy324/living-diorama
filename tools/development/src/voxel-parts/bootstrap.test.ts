import { builtInDefinitions } from "@living-diorama/built-in-content";
import { formatDiagnostic } from "@living-diorama/content-schema";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapParts, selectParts } from "./bootstrap";
import { buildParts, DEFAULT_OUTPUT_DIR, DEFAULT_SOURCE_DIR, readParts } from "./build";
import { STARTER_PARTS } from "./starter-parts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "vox-bootstrap-"));
  dirs.push(dir);
  return dir;
};

describe("bootstrapParts", () => {
  it("writes every recipe as a .vox and a sidecar that build into valid parts", () => {
    const dir = tempDir();
    const { written, kept } = bootstrapParts(STARTER_PARTS, dir);
    expect(kept).toEqual([]);
    expect(written).toHaveLength(2 * STARTER_PARTS.length);
    const { outputs, diagnostics } = buildParts(dir);
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(outputs.size).toBe(STARTER_PARTS.length);
  });

  it("keeps files already there unless forced", () => {
    const dir = tempDir();
    const [eye] = STARTER_PARTS.filter((p) => p.file === "round-eye");
    if (!eye) throw new Error("No round eye");
    writeFileSync(join(dir, "round-eye.vox"), "edited");
    expect(bootstrapParts([eye], dir)).toEqual({
      written: ["round-eye.json"],
      kept: ["round-eye.vox"],
    });
    expect(readFileSync(join(dir, "round-eye.vox"), "utf8")).toBe("edited");
    expect(bootstrapParts([eye], dir, { force: true }).written).toEqual([
      "round-eye.vox",
      "round-eye.json",
    ]);
    expect(readFileSync(join(dir, "round-eye.vox"), "utf8")).not.toBe("edited");
  });
});

describe("selectParts", () => {
  it("picks parts by file name, all of them with none named, and refuses unknown names", () => {
    expect(selectParts(STARTER_PARTS, [])).toHaveLength(STARTER_PARTS.length);
    expect(selectParts(STARTER_PARTS, ["round-eye", "smile"]).map((p) => p.file)).toEqual([
      "round-eye",
      "smile",
    ]);
    expect(() => selectParts(STARTER_PARTS, ["round-eyes"])).toThrow(/No starter part round-eyes/);
  });
});

describe("the built-in pack's starter parts", () => {
  it("has a source for every recipe", () => {
    const sources = new Set(buildParts(DEFAULT_SOURCE_DIR).outputs.keys());
    for (const { file } of STARTER_PARTS) expect(sources).toContain(`${file}.json`);
  });

  it("registers every generated part definition", () => {
    const generated = [...readParts(DEFAULT_OUTPUT_DIR).values()].map(
      (text) => (JSON.parse(text) as { id: string }).id,
    );
    expect(builtInDefinitions.parts.map((d) => d.id).sort()).toEqual(generated.sort());
  });
});
