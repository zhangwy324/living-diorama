import { VoxelAssemblySchema } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { builtInParts } from "./build-fixtures";
import { defaultRoot, partsKit, rootPartTypes, traySections } from "./parts-kit";

const studioParts = builtInParts();

describe("the parts kit", () => {
  it("takes the types with the root role as the roots: the torsos", () => {
    expect([...rootPartTypes(studioParts.partTypes)]).toEqual(["hollow:torso"]);
  });

  it("starts from the first part of a root type", () => {
    const roots = rootPartTypes(studioParts.partTypes);
    expect(defaultRoot(studioParts.parts, roots)?.id).toBe("hollow:fish-torso");
    expect(defaultRoot([...studioParts.parts].reverse(), roots)?.id).toBe("hollow:upright-torso");
    expect(defaultRoot(studioParts.parts, new Set())).toBeUndefined();
  });

  it("lists torsos first, then what hangs from them, then theirs, each by name", () => {
    const roots = rootPartTypes(studioParts.partTypes);
    const sections = traySections(studioParts.partTypes, studioParts.parts, roots);
    expect(sections.map((s) => s.name)).toEqual([
      "Torso",
      "Arm",
      "Fin",
      "Head",
      "Leg",
      "Tail",
      "Tail fin",
      "Ear",
      "Eye",
      "Mouth",
      "Nose",
    ]);
    expect(sections[0]?.parts.map((p) => p.id)).toEqual([
      "hollow:fish-torso",
      "hollow:four-legged-torso",
      "hollow:mossling-torso",
      "hollow:upright-torso",
    ]);
    // Every part is in exactly one section.
    expect(sections.flatMap((s) => s.parts).length).toBe(studioParts.parts.length);
  });

  it("leaves out part types with no parts", () => {
    const [first] = studioParts.parts;
    if (!first) throw new Error("No parts");
    const sections = traySections(studioParts.partTypes, [first], new Set([first.part.type]));
    expect(sections).toHaveLength(1);
  });

  it("makes a valid start of the default torso alone", () => {
    const kit = partsKit(studioParts);
    expect(kit?.start.instances).toHaveLength(1);
    expect(Object.values(kit?.start.parts ?? {}).map((p) => p.source)).toEqual([
      "hollow:fish-torso",
    ]);
    expect(VoxelAssemblySchema.safeParse(kit?.start).success).toBe(true);
  });

  it("is undefined with nothing to build on", () => {
    expect(partsKit({ ...studioParts, parts: [] })).toBeUndefined();
  });
});
