import { decodeVoxels, formatDiagnostic } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { formatPartDefinition, partDefinition, type PartDefinition } from "./part-definition";
import type { VoxCubes } from "./vox-parser";

// A 2 × 2 × 2 head with its corner cube missing, of two colours.
const cubes: VoxCubes = {
  size: { x: 2, y: 2, z: 2 },
  colors: ["#7fae5a", "#1d1d1d"],
  grid: new Uint8Array([1, 1, 1, 1, 1, 1, 2, 0]),
};

const sidecar = {
  id: "hollow:round-head",
  version: "1.0.0",
  name: "Round head",
  type: "hollow:head",
  step: 0.05,
  attach: { x: 1, y: 0, z: 1 },
  sockets: [
    { id: "left-eye", type: "hollow:eye-mount", position: { x: 2, y: 1.5, z: 0.5 } },
    {
      id: "right-eye",
      type: "hollow:eye-mount",
      position: { x: 2, y: 1.5, z: 1.5 },
      mirrors: "left-eye",
    },
  ],
};

const messages = (result: ReturnType<typeof partDefinition>): string[] =>
  result.ok ? [] : result.diagnostics.map(formatDiagnostic);

describe("partDefinition", () => {
  it("merges the cubes and the sidecar into a part definition", () => {
    const result = partDefinition(cubes, sidecar);
    expect(messages(result)).toEqual([]);
    const definition = (result as { value: PartDefinition }).value;
    expect(definition).toMatchObject({
      schemaVersion: 1,
      id: "hollow:round-head",
      version: "1.0.0",
      name: "Round head",
      part: {
        type: "hollow:head",
        size: cubes.size,
        step: 0.05,
        colors: cubes.colors,
        attach: sidecar.attach,
        sockets: sidecar.sockets,
      },
    });
    expect(decodeVoxels(definition.part.voxels, definition.part.size)).toEqual(cubes.grid);
  });

  it("defaults to no sockets", () => {
    const bare = { ...sidecar, sockets: undefined };
    const result = partDefinition(cubes, bare);
    expect(result.ok && result.value.part.sockets).toEqual([]);
  });

  it("reports sidecar errors against the sidecar", () => {
    const source = { sidecarSource: "head.json" };
    const noId = { ...sidecar, id: undefined };
    expect(messages(partDefinition(cubes, noId, source))).toEqual([
      expect.stringMatching(/^error: head\.json id: /),
    ]);
    expect(messages(partDefinition(cubes, { ...sidecar, step: 0.03 }, source))).toEqual([
      "error: head.json step: A part's step must be one of 0.0125, 0.025, 0.05, 0.1 m (invalid_value)",
    ]);
    expect(messages(partDefinition(cubes, { ...sidecar, colour: "#ffffff" }, source))).toEqual([
      expect.stringMatching(/^error: head\.json: .*colour.* \(unrecognized_keys\)$/),
    ]);
    expect(
      messages(partDefinition(cubes, { ...sidecar, attach: { x: 0.25, y: 0, z: 0 } }, source)),
    ).toEqual([expect.stringMatching(/^error: head\.json attach\.x: .*half/)]);
    expect(messages(partDefinition(cubes, { ...sidecar, version: "one" }, source)).length).toBe(1);
    expect(messages(partDefinition(cubes, "not an object", source))).toHaveLength(1);
  });

  it("reports errors of the merged part against the .vox", () => {
    const source = { source: "head.vox", sidecarSource: "head.json" };
    expect(
      messages(partDefinition(cubes, { ...sidecar, attach: { x: 3, y: 0, z: 0 } }, source)),
    ).toEqual([expect.stringMatching(/^error: head\.vox part\.attach\.x: .*outside the part/)]);
    const mixed = {
      ...sidecar,
      sockets: [sidecar.sockets[0], { ...sidecar.sockets[1], type: "hollow:ear-mount" }],
    };
    expect(messages(partDefinition(cubes, mixed, source))).toEqual([
      expect.stringMatching(/^error: head\.vox part\.sockets\[1\]\.mirrors: /),
    ]);
    const empty = { ...cubes, colors: [], grid: new Uint8Array(8) };
    expect(messages(partDefinition(empty, sidecar, source))).toEqual([
      expect.stringMatching(/^error: head\.vox part\.voxels: A part needs at least one cube/),
    ]);
  });
});

describe("formatPartDefinition", () => {
  it("writes JSON that reads back as the definition, the cubes on one line", () => {
    const result = partDefinition(cubes, sidecar);
    const definition = (result as { value: PartDefinition }).value;
    const text = formatPartDefinition(definition);
    expect(JSON.parse(text)).toEqual(definition);
    expect(text).toContain(`"voxels": ${JSON.stringify(definition.part.voxels)},\n`);
    expect(text.endsWith("}\n")).toBe(true);
  });
});
