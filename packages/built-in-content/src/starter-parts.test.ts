import {
  assembleParts,
  assemblyWarnings,
  decodeVoxels,
  formatDiagnostic,
  measureAssembly,
  placeInstances,
  replacePart,
  stepPart,
  stepUnits,
  validate,
  VoxelAssemblySchema,
  type VoxelAssembly,
  type VoxelPart,
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

  it.each(Object.keys(creatures))("%s has every part's attach point on its socket", (name) => {
    // Every joint is on the finer grid already, so the snap (ADR 0022 §13, as amended in M21
    // PR 7) moves nothing: the creatures, the mossling's asset among them, place as they did.
    const assembly = creatures[name as keyof typeof creatures];
    const placements = placeInstances(assembly);
    const index = new Map(assembly.instances.map((instance, i) => [instance.id, i]));
    const at = (i: number, point: { x: number; y: number; z: number }, step: number) => {
      const { linear, offset } = placements[i]!;
      const p = [point.x * step, point.y * step, point.z * step];
      return [0, 1, 2].map(
        (r) =>
          linear[r * 3]! * p[0]! +
          linear[r * 3 + 1]! * p[1]! +
          linear[r * 3 + 2]! * p[2]! +
          offset[r]!,
      );
    };
    assembly.instances.forEach((instance, i) => {
      if (!instance.parent) return;
      const part = assembly.parts[instance.part]!;
      const p = index.get(instance.parent.instance)!;
      const parentPart = assembly.parts[assembly.instances[p]!.part]!;
      const socket = parentPart.sockets.find((s) => s.id === instance.parent?.socket)!;
      expect(at(i, part.attach, stepUnits(part.step)), instance.id).toEqual(
        at(p, socket.position, stepUnits(parentPart.step)),
      );
    });
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

describe("stepping the starter parts one at a time (ADR 0023 §8)", () => {
  // Each starter part, on the first reference creature with a part of its type (put in its place,
  // with its mirror twin), steps one rung up and one down with its twin. A joint a step moves half
  // a finer cube off the grid snaps onto it (ADR 0022 §13, as amended in M21 PR 7).
  const registries = registered();
  const creatures = Object.values(referenceCreatures(partOf(registries)));
  const lookup = {
    fitsOf: (type: string) => registries.partTypes.get(type)?.fits,
    isSocketType: (type: string) => registries.socketTypes.get(type) !== undefined,
    roleOf: (type: string) => registries.partTypes.get(type)?.role,
  };
  const MIRROR = { mirror: true };

  /** A reference creature with `id` in the place of the first part of its type, and where. */
  function wearing({ id, part }: { id: string; part: VoxelPart }) {
    for (const creature of creatures) {
      const instance = creature.instances.find((i) => creature.parts[i.part]?.type === part.type);
      if (!instance) continue;
      const placed = replacePart(creature, instance.id, { id, part }, lookup, MIRROR);
      if (!placed.ok) throw new Error(`${id}: ${placed.refusal.message}`);
      return { assembly: placed.assembly, instance: instance.id };
    }
    throw new Error(`No reference creature has a part of type ${part.type}`);
  }

  /** Whether every mirror pair's two parts are mirror images about their parent's middle. */
  function mirrored(assembly: VoxelAssembly): boolean {
    const placements = placeInstances(assembly);
    const index = new Map(assembly.instances.map((instance, i) => [instance.id, i]));
    // The root-frame z extent of an instance's part, in units, ignoring its holes.
    const zOf = (id: string) => {
      const i = index.get(id) ?? -1;
      const instance = assembly.instances[i];
      const placement = placements[i];
      const part = instance && assembly.parts[instance.part];
      if (!part || !placement) throw new Error(id);
      const z = placement.linear.slice(6, 9).map((m, a) => {
        const size = [part.size.x, part.size.y, part.size.z][a] ?? 0;
        return m * size * stepUnits(part.step);
      });
      const far = placement.offset[2] + z.reduce((sum, v) => sum + v, 0);
      return [Math.min(placement.offset[2], far), Math.max(placement.offset[2], far)];
    };
    return assembly.instances.every(({ id, parent }) => {
      const socket = parent && assembly.parts[byId(assembly, parent.instance).part]?.sockets;
      const pair = socket?.find((s) => s.id === parent?.socket)?.mirrors;
      if (!parent || pair === undefined) return true;
      const twin = assembly.instances.find(
        (i) => i.parent?.instance === parent.instance && i.parent.socket === pair,
      );
      if (!twin) return true;
      const [lo, hi] = zOf(parent.instance);
      const [a0, a1] = zOf(id);
      const [b0, b1] = zOf(twin.id);
      return a0! + b1! === lo! + hi! && a1! + b0! === lo! + hi!;
    });
  }

  const byId = (assembly: VoxelAssembly, id: string) => {
    const found = assembly.instances.find((instance) => instance.id === id);
    if (!found) throw new Error(id);
    return found;
  };

  it("steps every part up and down but face details up and heads down, valid and mirrored", () => {
    const refused: string[] = [];
    for (const entry of sortedParts(registries)) {
      const { assembly, instance } = wearing(entry);
      expect(mirrored(assembly), entry.id).toBe(true);
      for (const direction of [1, -1] as const) {
        const result = stepPart(assembly, instance, direction, MIRROR);
        if (!result.ok) {
          refused.push(`${entry.id} ${direction}: ${result.refusal.message}`);
          continue;
        }
        const name = `${entry.id} ${direction}`;
        expect(checkAssemblyTypes(registries, result.assembly).map(formatDiagnostic), name).toEqual(
          [],
        );
        expect(mirrored(result.assembly), name).toBe(true);
        // Stepping back puts every part where it was (a shared copy stays a copy of its own).
        const back = stepPart(result.assembly, instance, direction === 1 ? -1 : 1, MIRROR);
        expect(back.ok && placeInstances(back.assembly), name).toEqual(placeInstances(assembly));
      }
    }
    // Eyes, noses and mouths are thin raised parts sunk half a 5 cm cube into the face, one of their
    // 2.5 cm cubes (ADR 0022 §12). At 5 cm cubes their mount would have to lie a whole 5 cm cube
    // deep, and on a head of 2.5 cm cubes it lies only 1.25 cm deep, too shallow for the eyes.
    expect(refused.map((r) => r.replace(/: .*/, ""))).toEqual([
      "hollow:bead-eye 1",
      "hollow:button-nose 1",
      "hollow:mossling-head -1",
      "hollow:open-mouth 1",
      "hollow:pink-nose 1",
      "hollow:round-eye 1",
      "hollow:round-head -1",
      "hollow:smile 1",
      "hollow:snout-head -1",
      "hollow:wide-head -1",
    ]);
    for (const reason of refused) expect(reason).toMatch(/deep inside part/);
  });

  it("steps a head down once its face details have stepped down", () => {
    let fox = creatures[0]!;
    for (const id of ["eye-left", "nose", "mouth"]) {
      const result = stepPart(fox, id, -1, MIRROR);
      if (!result.ok) throw new Error(result.refusal.message);
      fox = result.assembly;
    }
    expect(stepPart(fox, "head", -1, MIRROR).ok).toBe(true);
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
