import { VoxelAssemblySchema } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { builtInParts } from "./fixtures/built-in-parts";
import { defaultRoot, partsKit, rootPartTypes, traySections } from "./parts-kit";

const studioParts = builtInParts();

describe("the parts kit", () => {
  it("takes the types with the root role as the roots: the torsos", () => {
    expect([...rootPartTypes(studioParts.partTypes)]).toEqual(["hollow:torso"]);
  });

  it("starts from the part its pack marks as the starter: the four-legged torso", () => {
    const roots = rootPartTypes(studioParts.partTypes);
    expect(studioParts.parts.filter((p) => p.starter).map((p) => p.id)).toEqual([
      "hollow:four-legged-torso",
    ]);
    expect(defaultRoot(studioParts.parts, roots)?.id).toBe("hollow:four-legged-torso");
    expect(defaultRoot(studioParts.parts, new Set())).toBeUndefined();
  });

  it("falls back to the first root part, and takes the first starter when several are marked", () => {
    const roots = rootPartTypes(studioParts.partTypes);
    const unmarked = studioParts.parts.map(({ id, name, version, part }) => ({
      id,
      name,
      version,
      part,
    }));
    expect(defaultRoot(unmarked, roots)?.id).toBe("hollow:fish-torso");
    const twice = unmarked.map((p) =>
      p.id === "hollow:mossling-torso" || p.id === "hollow:upright-torso"
        ? { ...p, starter: true }
        : p,
    );
    expect(defaultRoot(twice, roots)?.id).toBe("hollow:mossling-torso");
    // A starter that isn't of a root type is passed over.
    const eye = unmarked.map((p) => (p.id === "hollow:bead-eye" ? { ...p, starter: true } : p));
    expect(defaultRoot(eye, roots)?.id).toBe("hollow:fish-torso");
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
      "hollow:four-legged-torso",
    ]);
    expect(VoxelAssemblySchema.safeParse(kit?.start).success).toBe(true);
  });

  it("is undefined with nothing to build on", () => {
    expect(partsKit({ ...studioParts, parts: [] })).toBeUndefined();
  });
});
