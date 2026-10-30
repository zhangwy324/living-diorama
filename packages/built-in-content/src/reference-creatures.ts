import {
  IDENTITY_QUATERNION,
  type Quaternion,
  type VoxelAssembly,
  type VoxelPart,
} from "@living-diorama/content-schema";

// Reference creatures built by hand from the starter parts, one per torso layout and the mossling,
// for the starter parts' tests and screenshots. They show that the parts fit together; they are not
// registered, and M21's Studio and the assembler make creatures of their own.

/** One instance: its ID, its part's ID and the socket of an earlier instance it hangs from. */
interface Placed {
  id: string;
  part: string;
  on?: [instance: string, socket: string];
}

/**
 * Builds an assembly from placed parts, with a frozen copy of each part keyed by its ID's name and
 * marked with its source, and each instance mirrored when its socket mirrors another.
 */
function assemble(partOf: (id: string) => VoxelPart, placed: Placed[]): VoxelAssembly {
  const parts: Record<string, VoxelPart> = {};
  const keyOf = (id: string) => id.slice(id.indexOf(":") + 1);
  const partByInstance = new Map<string, VoxelPart>();
  const instances = placed.map(({ id, part, on }) => {
    const copy = { ...partOf(part), source: part };
    parts[keyOf(part)] = copy;
    partByInstance.set(id, copy);
    let mirrored = false;
    if (on) {
      const socket = partByInstance.get(on[0])?.sockets.find((t) => t.id === on[1]);
      if (!socket) throw new Error(`No socket ${on[1]} on ${on[0]}`);
      mirrored = socket.mirrors !== undefined;
    }
    return {
      id,
      part: keyOf(part),
      ...(on ? { parent: { instance: on[0], socket: on[1] } } : {}),
      rotation: [...IDENTITY_QUATERNION] as Quaternion,
      mirrored,
    };
  });
  return { parts, instances };
}

/** A part on each socket of a mirrored pair. */
const pair = (
  instance: string,
  part: string,
  parent: string,
  [left, right]: [string, string],
): Placed[] => [
  { id: `${instance}-left`, part, on: [parent, left] },
  { id: `${instance}-right`, part, on: [parent, right] },
];

/** The reference creatures, by name, from a lookup of starter parts by ID. */
export function referenceCreatures(
  partOf: (id: string) => VoxelPart,
): Record<"fox" | "bear" | "fish" | "mossling", VoxelAssembly> {
  return {
    // The four-legged layout.
    fox: assemble(partOf, [
      { id: "torso", part: "hollow:four-legged-torso" },
      ...pair("front-leg", "hollow:paw-leg", "torso", ["front-left", "front-right"]),
      ...pair("back-leg", "hollow:paw-leg", "torso", ["back-left", "back-right"]),
      { id: "tail", part: "hollow:bushy-tail", on: ["torso", "tail-base"] },
      { id: "head", part: "hollow:snout-head", on: ["torso", "neck"] },
      ...pair("ear", "hollow:pointed-ear", "head", ["left-ear", "right-ear"]),
      ...pair("eye", "hollow:bead-eye", "head", ["left-eye", "right-eye"]),
      { id: "nose", part: "hollow:button-nose", on: ["head", "nose"] },
      { id: "mouth", part: "hollow:open-mouth", on: ["head", "mouth"] },
    ]),
    // The upright layout.
    bear: assemble(partOf, [
      { id: "torso", part: "hollow:upright-torso" },
      ...pair("leg", "hollow:stout-leg", "torso", ["left-hip", "right-hip"]),
      ...pair("arm", "hollow:paw-arm", "torso", ["left-arm", "right-arm"]),
      { id: "tail", part: "hollow:puff-tail", on: ["torso", "tail-base"] },
      { id: "head", part: "hollow:round-head", on: ["torso", "neck"] },
      ...pair("ear", "hollow:round-ear", "head", ["left-ear", "right-ear"]),
      ...pair("eye", "hollow:round-eye", "head", ["left-eye", "right-eye"]),
      { id: "nose", part: "hollow:pink-nose", on: ["head", "nose"] },
      { id: "mouth", part: "hollow:smile", on: ["head", "mouth"] },
    ]),
    // The fish layout.
    fish: assemble(partOf, [
      { id: "torso", part: "hollow:fish-torso" },
      ...pair("fin", "hollow:side-fin", "torso", ["left-fin", "right-fin"]),
      { id: "tail", part: "hollow:fan-fin", on: ["torso", "tail-base"] },
      { id: "head", part: "hollow:wide-head", on: ["torso", "neck"] },
      ...pair("eye", "hollow:round-eye", "head", ["left-eye", "right-eye"]),
      { id: "mouth", part: "hollow:open-mouth", on: ["head", "mouth"] },
    ]),
    // The mossling's own parts.
    mossling: assemble(partOf, [
      { id: "torso", part: "hollow:mossling-torso" },
      ...pair("foot", "hollow:mossling-foot", "torso", ["left-hip", "right-hip"]),
      { id: "head", part: "hollow:mossling-head", on: ["torso", "neck"] },
      ...pair("eye", "hollow:round-eye", "head", ["left-eye", "right-eye"]),
      { id: "mouth", part: "hollow:smile", on: ["head", "mouth"] },
    ]),
  };
}
