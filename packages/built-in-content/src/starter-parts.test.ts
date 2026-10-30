import {
  assembleParts,
  assemblyWarnings,
  decodeVoxels,
  formatDiagnostic,
  measureAssembly,
  validate,
  VoxelAssemblySchema,
  type VoxelAssembly,
} from "@living-diorama/content-schema";
import {
  checkAssemblyTypes,
  createRegistries,
  resolveReferences,
  sortedParts,
  type Registries,
} from "@living-diorama/extension-api";
import { describe, expect, it } from "vitest";
import { registerBuiltInContent } from "./index";
import { referenceCreatures } from "./reference-creatures";

// The starter parts (ADR 0022, M20 decisions "The starter set"): each loads, validates and fits
// the others. Their art is checked by eye from screenshots, not here.

function registered(): Registries {
  const registries = createRegistries();
  const results = registerBuiltInContent(registries);
  expect(results.flatMap((r) => (r.ok ? [] : r.diagnostics.map(formatDiagnostic)))).toEqual([]);
  return registries;
}

const partOf = (registries: Registries) => (id: string) => {
  const definition = registries.parts.get(id);
  if (!definition) throw new Error(`No part ${id}`);
  return definition.part;
};

/** Checks an assembly as a release would, and measures it. */
function check(registries: Registries, assembly: VoxelAssembly, name: string) {
  const parsed = validate(VoxelAssemblySchema, assembly, name);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map(formatDiagnostic).join("\n"));
  return {
    warnings: assemblyWarnings(parsed.value, name).map(formatDiagnostic),
    fit: checkAssemblyTypes(registries, parsed.value).map(formatDiagnostic),
    measure: measureAssembly(parsed.value, (type) => registries.partTypes.get(type)?.role),
  };
}

describe("the starter parts", () => {
  it("register and resolve: their part and socket types are registered", () => {
    const registries = registered();
    const diagnostics = resolveReferences(registries).diagnostics.filter((d) =>
      d.source?.startsWith("parts/"),
    );
    expect(diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it("are the starter set: three torsos and heads, two of each other kind, and the mossling's", () => {
    const byType = new Map<string, string[]>();
    for (const { id, part } of sortedParts(registered())) {
      byType.set(part.type, [...(byType.get(part.type) ?? []), id]);
    }
    expect(Object.fromEntries(byType)).toEqual({
      "hollow:arm": ["hollow:mitten-arm", "hollow:paw-arm"],
      "hollow:ear": ["hollow:pointed-ear", "hollow:round-ear"],
      "hollow:eye": ["hollow:bead-eye", "hollow:round-eye"],
      "hollow:fin": ["hollow:fan-fin", "hollow:side-fin"],
      "hollow:head": [
        "hollow:mossling-head",
        "hollow:round-head",
        "hollow:snout-head",
        "hollow:wide-head",
      ],
      "hollow:leg": ["hollow:mossling-foot", "hollow:paw-leg", "hollow:stout-leg"],
      "hollow:mouth": ["hollow:open-mouth", "hollow:smile"],
      "hollow:nose": ["hollow:button-nose", "hollow:pink-nose"],
      "hollow:tail": ["hollow:bushy-tail", "hollow:puff-tail"],
      "hollow:torso": [
        "hollow:fish-torso",
        "hollow:four-legged-torso",
        "hollow:mossling-torso",
        "hollow:upright-torso",
      ],
    });
  });

  it("have torsos as roots only, and a socket for every other part type", () => {
    // A torso fits no socket any starter part offers, so it can only be a root (the development
    // console's spawn hook picks roots this way); every other part type fits one that some
    // starter part offers, so none is left with nowhere to go.
    const registries = registered();
    const offered = new Set(
      sortedParts(registries).flatMap(({ part }) => part.sockets.map((s) => s.type)),
    );
    const types = new Set(sortedParts(registries).map(({ part }) => part.type));
    for (const type of types) {
      const fits = registries.partTypes.get(type)?.fits ?? [];
      const canHang = fits.some((socket) => offered.has(socket));
      expect([type, canHang]).toEqual([type, type !== "hollow:torso"]);
    }
  });

  it("use 5 cm cubes, and 2.5 cm for eyes, noses and mouths", () => {
    const fine = new Set(["hollow:eye", "hollow:nose", "hollow:mouth"]);
    for (const { id, part } of sortedParts(registered())) {
      expect([id, part.step]).toEqual([id, fine.has(part.type) ? 0.025 : 0.05]);
    }
  });

  it("have no pure black or white, and every colour is used", () => {
    for (const { id, part } of sortedParts(registered())) {
      for (const color of part.colors) {
        expect([id, color.toLowerCase()]).not.toEqual([id, "#000000"]);
        expect([id, color.toLowerCase()]).not.toEqual([id, "#ffffff"]);
      }
      const used = new Set(decodeVoxels(part.voxels, part.size));
      used.delete(0);
      expect([id, used.size]).toEqual([id, part.colors.length]);
    }
  });

  it("mirror each pair of sockets in the part's middle plane", () => {
    for (const { id, part } of sortedParts(registered())) {
      for (const socket of part.sockets.filter((s) => s.mirrors !== undefined)) {
        const base = part.sockets.find((s) => s.id === socket.mirrors);
        expect([id, socket.id, socket.position]).toEqual([
          id,
          socket.id,
          { ...base?.position, z: part.size.z - (base?.position.z ?? 0) },
        ]);
      }
    }
  });
});

describe("the reference creatures", () => {
  // One creature per torso layout and the mossling, built by hand: valid (joint depth and the
  // finer grid are checked by the schema), fitting their sockets, with no flush faces.
  const registries = registered();
  const creatures = referenceCreatures(partOf(registries));

  it.each(Object.keys(creatures))("%s is valid and fits, with no flush faces", (name) => {
    const { warnings, fit } = check(registries, creatures[name as keyof typeof creatures], name);
    expect(fit).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("are all medium, the mossling about 52 × 60 × 45 cm", () => {
    const sizes = Object.fromEntries(
      Object.entries(creatures).map(([name, assembly]) => {
        const { measure } = check(registries, assembly, name);
        return [name, measure.sizeClass];
      }),
    );
    expect(sizes).toEqual({ fox: "medium", bear: "medium", fish: "medium", mossling: "medium" });
    const { measure } = check(registries, creatures.mossling, "mossling");
    expect(measure.bounds.max.x - measure.bounds.min.x).toBeCloseTo(0.525);
    expect(measure.height).toBeCloseTo(0.6);
    expect(measure.bounds.max.z - measure.bounds.min.z).toBeCloseTo(0.45);
  });
});

describe("assembled at random from each torso", () => {
  // The assembler fills every free socket with a part that fits; the starter parts should go
  // together without flush faces whichever it picks.
  const registries = registered();
  const library = sortedParts(registries).map(({ id, part }) => ({ id, part }));
  const lookup = {
    fitsOf: (type: string) => registries.partTypes.get(type)?.fits,
    isSocketType: (type: string) => registries.socketTypes.get(type) !== undefined,
  };
  const torsos = library.filter(({ part }) => part.type === "hollow:torso");

  it.each(torsos.map((t) => t.id))(
    "%s gives valid, fitting creatures with no flush faces",
    (id) => {
      const start = torsos.find((t) => t.id === id);
      if (!start) throw new Error(id);
      for (let seed = 0; seed < 16; seed++) {
        const assembly = assembleParts({ start, parts: library, lookup, seed });
        const { warnings, fit, measure } = check(registries, assembly, `${id} seed ${seed}`);
        expect(fit).toEqual([]);
        expect(warnings).toEqual([]);
        expect(measure.sizeClass).toBeDefined();
      }
    },
  );
});
