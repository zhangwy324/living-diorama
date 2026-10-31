import { describe, expect, it } from "vitest";
import {
  DRAWING_GRID,
  PartDrawingSchema,
  fitDrawnPart,
  isContentId,
  parsePlayerPartEntry,
  playerPartId,
  voxelizeDrawing,
  type PlayerPartEntryInput,
} from "./index";

const UUID = "3f9c2a1e-7b4d-4c8a-9e2f-0123456789ab";

function entry(): PlayerPartEntryInput {
  const pixels = new Array<number>(DRAWING_GRID * DRAWING_GRID).fill(0);
  for (let y = 4; y < 10; y++) for (let x = 5; x < 8; x++) pixels[y * DRAWING_GRID + x] = 1;
  const drawing = PartDrawingSchema.parse({
    pixels,
    palette: ["#aa8855"],
    view: "side",
    rule: "tube",
    step: 0.025,
  });
  const fit = fitDrawnPart(voxelizeDrawing(drawing)!, {
    type: "hollow:leg",
    size: { x: 3, y: 3, z: 2 },
    step: 0.05,
    colors: ["#334455"],
    voxels: [18, 1],
    attach: { x: 1, y: 3, z: 1 },
    sockets: [],
  });
  if (!fit.ok) throw new Error(fit.refusal.message);
  return {
    schemaVersion: 1,
    id: playerPartId(UUID),
    name: "Long leg",
    version: 1,
    createdAt: "2026-10-30T12:00:00.000Z",
    updatedAt: "2026-10-30T12:05:00.000Z",
    part: fit.part,
    drawing,
  };
}

describe("PlayerPartEntrySchema", () => {
  it("reads back what it writes", () => {
    const first = parsePlayerPartEntry(entry());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = parsePlayerPartEntry(JSON.parse(JSON.stringify(first.value)));
    expect(again).toEqual(first);
  });

  it("has a content ID", () => {
    expect(isContentId(playerPartId(UUID))).toBe(true);
  });

  it.each([
    ["an ID that isn't user-part:<uuid>", { id: `user:${UUID}` }],
    ["an upper-case UUID", { id: playerPartId(UUID.toUpperCase()) }],
    ["another schema version", { schemaVersion: 2 }],
    ["version 0", { version: 0 }],
    ["an empty name", { name: "" }],
    ["a date without a time zone", { createdAt: "2026-10-30T12:00:00" }],
  ])("refuses %s", (_, change) => {
    expect(parsePlayerPartEntry({ ...entry(), ...change }).ok).toBe(false);
  });

  it("refuses a part with a source", () => {
    const input = entry();
    expect(parsePlayerPartEntry({ ...input, part: { ...input.part, source: "a:b" } }).ok).toBe(
      false,
    );
  });

  it("refuses a part whose step isn't its drawing's", () => {
    const input = entry();
    expect(parsePlayerPartEntry({ ...input, part: { ...input.part, step: 0.05 } }).ok).toBe(false);
  });

  it("refuses a drawing with a colour past its palette", () => {
    const input = entry();
    const pixels = [...input.drawing.pixels];
    pixels[0] = 2;
    expect(parsePlayerPartEntry({ ...input, drawing: { ...input.drawing, pixels } }).ok).toBe(
      false,
    );
  });
});
