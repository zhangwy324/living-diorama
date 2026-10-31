import {
  PlayerPartEntrySchema,
  fitDrawnPart,
  parsePlayerPartEntry,
  playerPartId,
  voxelizeDrawing,
} from "@living-diorama/content-schema";
import { createMemoryPartsStore } from "@living-diorama/desktop-integration";
import { describe, expect, it } from "vitest";
import {
  NEW_PART,
  defaultBase,
  defaultPartName,
  drawKey,
  drawingOf,
  partEntry,
  recordOf,
  MUCH_BIGGER,
  sameSnapshot,
  savePart,
  sizeAgainst,
  type DrawSetup,
} from "./draw-entry";
import { NO_PLACED_POINTS } from "./drawn-points";
import { builtInParts } from "./fixtures/built-in-parts";
import { emptyGrid, paint } from "./grid-editor";
import { partsKit } from "./parts-kit";

const UUID = "3f9c2a1e-7b4d-4c8a-9e2f-0123456789ab";
const kit = partsKit(builtInParts())!;
const torsoType = kit.sections[0]!.type;
const base = defaultBase(kit.parts, torsoType, kit.roots)!;

const setup: DrawSetup = {
  partType: torsoType,
  baseId: base.id,
  step: base.part.step,
  view: "side",
  rule: "puffy",
  chubby: 1,
  flatThickness: 1,
};

function drawnPart() {
  const cells: [number, number][] = [];
  for (let y = 10; y < 18; y++) for (let x = 8; x < 22; x++) cells.push([x, y]);
  const grid = paint(paint(emptyGrid(), cells, 2), [[8, 10]], 1);
  const drawing = drawingOf(grid, ["#112233", "#7fae5a", "#ffffff"], setup);
  const fit = fitDrawnPart(voxelizeDrawing(drawing)!, base.part);
  return { drawing, part: fit.part };
}

describe("a drawn part's entry", () => {
  it("is a valid player part, version 1 under a new ID when first saved", () => {
    const { drawing, part } = drawnPart();
    const entry = partEntry({
      record: NEW_PART,
      name: "  Round body ",
      part,
      drawing,
      now: "2026-10-30T12:00:00.000Z",
      newUuid: () => UUID,
    });
    expect(PlayerPartEntrySchema.safeParse(entry).success).toBe(true);
    expect(entry).toMatchObject({
      schemaVersion: 2,
      id: playerPartId(UUID),
      name: "Round body",
      version: 1,
      createdAt: "2026-10-30T12:00:00.000Z",
      updatedAt: "2026-10-30T12:00:00.000Z",
    });
    expect(entry.part.type).toBe(torsoType);
    expect(entry.part.source).toBeUndefined();
    // Only the colours used, in the palette's order.
    expect(entry.drawing.palette).toEqual(["#112233", "#7fae5a"]);
  });

  it("keeps its ID and creation date and raises its version when saved after an edit", () => {
    const { drawing, part } = drawnPart();
    const first = partEntry({
      record: NEW_PART,
      name: "Round body",
      part,
      drawing,
      now: "2026-10-30T12:00:00.000Z",
      newUuid: () => UUID,
    });
    const second = partEntry({
      record: recordOf(first),
      name: "Rounder body",
      part,
      drawing,
      now: "2026-10-30T13:00:00.000Z",
      newUuid: () => {
        throw new Error("An edit keeps its ID");
      },
    });
    expect(second).toMatchObject({
      id: first.id,
      version: 2,
      createdAt: first.createdAt,
      updatedAt: "2026-10-30T13:00:00.000Z",
      name: "Rounder body",
    });
    expect(recordOf(second)).toEqual({ uuid: UUID, version: 2, createdAt: first.createdAt });
  });

  it.each([
    ["no name", "   "],
    ["a name over 40 characters", "A".repeat(41)],
  ])("is refused with %s", (_, name) => {
    const { drawing, part } = drawnPart();
    expect(() =>
      partEntry({
        record: NEW_PART,
        name,
        part,
        drawing,
        now: "2026-10-30T12:00:00Z",
        newUuid: () => UUID,
      }),
    ).toThrow("can't be saved");
  });

  it("goes into the parts store under its UUID, and reads back", async () => {
    const store = createMemoryPartsStore();
    const { drawing, part } = drawnPart();
    const entry = partEntry({
      record: NEW_PART,
      name: "Round body",
      part,
      drawing,
      now: "2026-10-30T12:00:00.000Z",
      newUuid: () => UUID,
    });
    await savePart(store, entry);
    const [stored] = await store.list();
    expect(stored?.id).toBe(UUID);
    const parsed = parsePlayerPartEntry(stored?.entry);
    expect(parsed.ok && parsed.value).toEqual(entry);
  });
});

describe("a drawing's start", () => {
  it("draws on the root type's starter, else the first part of the type", () => {
    expect(base.starter).toBe(true);
    const other = kit.sections.find((section) => !kit.roots.has(section.type))!;
    expect(defaultBase(kit.parts, other.type, kit.roots)).toBe(other.parts[0]);
    expect(defaultBase(kit.parts, "nobody:nothing", kit.roots)).toBeUndefined();
  });

  it("names a new part after its type", () => {
    expect(defaultPartName("Torso")).toBe("My torso");
  });

  it("has a key that changes with what decides the part, and not otherwise", () => {
    const { drawing } = drawnPart();
    const key = drawKey("Round body", drawing, NO_PLACED_POINTS);
    expect(drawKey(" Round body", drawing, NO_PLACED_POINTS)).toBe(key);
    expect(drawKey("Round", drawing, NO_PLACED_POINTS)).not.toBe(key);
    expect(drawKey("Round body", { ...drawing, rule: "flat" }, NO_PLACED_POINTS)).not.toBe(key);
    expect(drawKey("Round body", drawing, { sockets: { neck: { u: 1, v: 1, d: 0 } } })).not.toBe(
      key,
    );
    expect(
      drawKey("Round body", { ...drawing, baseId: "hollow:other" }, NO_PLACED_POINTS),
    ).not.toBe(key);
  });

  it("measures a part against its base part by its largest size", () => {
    const { part } = drawnPart();
    expect(sizeAgainst(base.part, base.part)).toBe(1);
    const twice = {
      ...part,
      step: base.part.step,
      size: { ...base.part.size, y: base.part.size.y * 2 },
    };
    expect(sizeAgainst(twice, base.part)).toBe(2);
    expect(MUCH_BIGGER).toBe(2);
  });

  it("finds snapshots with the same content the same, so they make no undo step", () => {
    const grid = emptyGrid();
    const frame = { partType: torsoType, baseId: base.id, view: "side" as const };
    const placed = { sockets: { neck: { u: 1, v: 2, d: 0 } } };
    const snapshot = { grid, placed, frame };
    expect(
      sameSnapshot(snapshot, {
        grid: new Uint8Array(grid),
        placed: { sockets: { neck: { u: 1, v: 2, d: 0 } } },
        frame: { ...frame },
      }),
    ).toBe(true);
    expect(sameSnapshot(snapshot, { ...snapshot, placed: { sockets: {} } })).toBe(false);
    expect(sameSnapshot(snapshot, { ...snapshot, frame: { ...frame, view: "front" } })).toBe(false);
    expect(sameSnapshot(snapshot, { ...snapshot, grid: paint(grid, [[0, 0]], 1) })).toBe(false);
  });

  it("keeps its base part in the drawing", () => {
    expect(drawnPart().drawing.baseId).toBe(base.id);
  });
});
