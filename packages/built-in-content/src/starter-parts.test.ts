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
      "hollow:fin": ["hollow:side-fin"],
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
      "hollow:tail-fin": ["hollow:fan-fin"],
      "hollow:torso": [
        "hollow:fish-torso",
        "hollow:four-legged-torso",
        "hollow:mossling-torso",
        "hollow:upright-torso",
      ],
    });
  });

  it("have the torsos as roots, and a socket for every other part", () => {
    // The torsos' type has the `root` role and fits no socket, so a torso is only ever a root;
    // every other part's type fits a socket that some starter part offers, so none is left with
    // nowhere to go.
    const registries = registered();
    const offered = new Set(
      sortedParts(registries).flatMap(({ part }) => part.sockets.map((s) => s.type)),
    );
    for (const { id, part } of sortedParts(registries)) {
      const type = registries.partTypes.get(part.type);
      const canHang = (type?.fits ?? []).some((socket) => offered.has(socket));
      expect([id, type?.role === "root", canHang]).toEqual([
        id,
        id.endsWith("-torso"),
        !id.endsWith("-torso"),
      ]);
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
  // together without flush faces whichever it picks, and stay medium, as the mossling is.
  const registries = registered();
  const library = sortedParts(registries).map(({ id, part }) => ({ id, part }));
  const lookup = {
    fitsOf: (type: string) => registries.partTypes.get(type)?.fits,
    isSocketType: (type: string) => registries.socketTypes.get(type) !== undefined,
    roleOf: (type: string) => registries.partTypes.get(type)?.role,
  };
  const torsos = library.filter(({ part }) => lookup.roleOf(part.type) === "root");

  it.each(torsos.map((t) => t.id))(
    "%s gives valid, fitting, medium creatures with no flush faces",
    (id) => {
      const start = torsos.find((t) => t.id === id);
      if (!start) throw new Error(id);
      for (let seed = 0; seed < 32; seed++) {
        const assembly = assembleParts({ start, parts: library, lookup, seed });
        const { warnings, fit, measure } = check(registries, assembly, `${id} seed ${seed}`);
        expect(fit).toEqual([]);
        expect(warnings).toEqual([]);
        expect(measure.sizeClass).toBe("medium");
      }
    },
  );

  it("puts only plausible parts on each torso's sockets (#225)", () => {
    // Over fixed seeds, the part types each torso's sockets get: legs on leg mounts, arms on an
    // upright torso's shoulders, fins on a fish's sides and a tail fin behind it, never side fins
    // as arms or a bushy tail on a fish.
    const used = (id: string) => {
      const start = torsos.find((t) => t.id === id);
      if (!start) throw new Error(id);
      const bySocket = new Map<string, Set<string>>();
      for (let seed = 0; seed < 32; seed++) {
        const assembly = assembleParts({ start, parts: library, lookup, seed });
        const [root, ...rest] = assembly.instances;
        for (const { parent, part } of rest) {
          if (!parent || parent.instance !== root?.id) continue;
          const type = assembly.parts[part]?.type ?? "?";
          const { socket } = parent;
          bySocket.set(socket, (bySocket.get(socket) ?? new Set()).add(type));
        }
      }
      return Object.fromEntries([...bySocket].map(([socket, types]) => [socket, [...types]]));
    };
    expect(used("hollow:fish-torso")).toEqual({
      "left-fin": ["hollow:fin"],
      "right-fin": ["hollow:fin"],
      "tail-base": ["hollow:tail-fin"],
      neck: ["hollow:head"],
    });
    expect(used("hollow:four-legged-torso")).toEqual({
      "front-left": ["hollow:leg"],
      "front-right": ["hollow:leg"],
      "back-left": ["hollow:leg"],
      "back-right": ["hollow:leg"],
      neck: ["hollow:head"],
      "tail-base": ["hollow:tail"],
    });
    expect(used("hollow:upright-torso")).toEqual({
      "left-hip": ["hollow:leg"],
      "right-hip": ["hollow:leg"],
      "left-arm": ["hollow:arm"],
      "right-arm": ["hollow:arm"],
      neck: ["hollow:head"],
      "tail-base": ["hollow:tail"],
    });
    expect(used("hollow:mossling-torso")).toEqual({
      "left-hip": ["hollow:leg"],
      "right-hip": ["hollow:leg"],
      neck: ["hollow:head"],
    });
  });
});

describe("each pair of a starter part and a socket", () => {
  // A part on one socket of another part, alone, the way a creature is built up: every socket
  // takes some starter part cleanly (valid, fitting, no flush faces), and every part but a torso
  // goes cleanly on some socket.
  const registries = registered();
  const parts = sortedParts(registries);
  const fits = (type: string, socket: string) =>
    registries.partTypes.get(type)?.fits.includes(socket) ?? false;

  /** Whether `child` goes cleanly on `parent`'s socket `socketId`. */
  function clean(parent: (typeof parts)[number], socketId: string, child: (typeof parts)[number]) {
    const socket = parent.part.sockets.find((s) => s.id === socketId);
    if (!socket || !fits(child.part.type, socket.type)) return false;
    const assembly = {
      parts: { parent: parent.part, child: child.part },
      instances: [
        { id: "parent", part: "parent", rotation: [0, 0, 0, 1], mirrored: false },
        {
          id: "child",
          part: parent.id === child.id ? "parent" : "child",
          parent: { instance: "parent", socket: socketId },
          rotation: [0, 0, 0, 1],
          mirrored: socket.mirrors !== undefined,
        },
      ],
    };
    if (parent.id === child.id) delete (assembly.parts as Record<string, unknown>).child;
    const parsed = validate(VoxelAssemblySchema, assembly);
    return parsed.ok && assemblyWarnings(parsed.value).length === 0;
  }

  it("every socket takes some starter part cleanly", () => {
    const empty = parts.flatMap((parent) =>
      parent.part.sockets
        .filter((socket) => !parts.some((child) => clean(parent, socket.id, child)))
        .map((socket) => `${parent.id} ${socket.id}`),
    );
    expect(empty).toEqual([]);
  });

  it("every starter part but a torso goes cleanly on some socket", () => {
    const homeless = parts
      .filter(({ part }) => part.type !== "hollow:torso")
      .filter(
        (child) =>
          !parts.some((parent) => parent.part.sockets.some((s) => clean(parent, s.id, child))),
      )
      .map(({ id }) => id);
    expect(homeless).toEqual([]);
  });
});
