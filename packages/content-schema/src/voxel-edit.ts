import { HexColorSchema, type Vec3 } from "./primitives";
import {
  MAX_ASSEMBLY_INSTANCES,
  VOXEL_STEPS,
  VOXEL_UNIT,
  stepUnits,
  type VoxelPart,
} from "./voxel";
import {
  IDENTITY_QUATERNION,
  VoxelAssemblySchema,
  measureAssembly,
  placeInstances,
  type LibraryPart,
  type PartFitLookup,
  type Quaternion,
  type VoxelAssembly,
  type VoxelInstance,
} from "./voxel-assembly";
import { claimId, copyVoxelPart, partKeyOf } from "./voxel-internal";

// Editing a voxel assembly (ADR 0023 §4–§8, §12, §15, §16): pure, deterministic operations that
// each return a new assembly that passes `VoxelAssemblySchema`, or a refusal saying why not. An
// assembly is treated as immutable: an edit shares every part and instance it doesn't change with
// the assembly it was given (structural sharing), so the undo history keeps whole snapshots
// cheaply. Every operation expects a valid assembly.

/** One socket of one instance. */
export interface SocketRef {
  instance: string;
  socket: string;
}

/** Whether an edit also acts on the mirror twin (ADR 0023 §6): the Studio's Mirror toggle. */
export interface MirrorOption {
  mirror: boolean;
}

/** Why an edit was refused. */
export type AssemblyEditRefusalCode =
  /** No instance has the given ID. */
  | "unknown_instance"
  /** The instance's part has no socket of the given ID. */
  | "unknown_socket"
  /** The socket holds a part already. */
  | "socket_taken"
  /** The part's type doesn't fit the socket's type, or isn't registered. */
  | "does_not_fit"
  /** The edit would make the assembly more than `MAX_ASSEMBLY_INSTANCES` parts. */
  | "too_many_parts"
  /** The root hangs from no socket, so it can't be removed or turned. */
  | "root"
  /** Only a part whose type has the `root` role can replace the root (ADR 0023 §10). */
  | "not_root"
  /** No quarter turn about the socket's Y axis leaves the assembly valid. */
  | "no_turn"
  /** The step is at the end of the ladder (`VOXEL_STEPS`) already. */
  | "ladder_end"
  /** The part has no colour of the given index. */
  | "unknown_color"
  /** The colour isn't `#rrggbb`. */
  | "invalid_color"
  /** The result would fail `VoxelAssemblySchema`: a joint (ADR 0022 §12) or the face cap. */
  | "invalid";

export interface AssemblyEditRefusal {
  code: AssemblyEditRefusalCode;
  /** A readable reason, for logs and tests. */
  message: string;
}

/**
 * What an edit returns: the new assembly and the IDs of the instances it acted on (placed,
 * replaced, removed, turned, stepped or recoloured), the one asked for first, or a refusal.
 */
export type AssemblyEditResult =
  | { ok: true; assembly: VoxelAssembly; instances: readonly string[] }
  | { ok: false; refusal: AssemblyEditRefusal };

const refuse = (code: AssemblyEditRefusalCode, message: string): AssemblyEditResult => ({
  ok: false,
  refusal: { code, message },
});

/** The candidate if it passes the validator, otherwise an `invalid` refusal. */
function settle(candidate: VoxelAssembly, instances: readonly string[]): AssemblyEditResult {
  // Parsed only to check: the result keeps the candidate's objects, which share with the input.
  const parsed = VoxelAssemblySchema.safeParse(candidate);
  if (parsed.success) return { ok: true, assembly: candidate, instances };
  return refuse("invalid", parsed.error.issues[0]?.message ?? "The assembly isn't valid");
}

const findInstance = (assembly: VoxelAssembly, id: string) =>
  assembly.instances.find((instance) => instance.id === id);

function partOf(assembly: VoxelAssembly, instance: VoxelInstance): VoxelPart {
  const part = assembly.parts[instance.part];
  if (!part) throw new Error(`Unknown part "${instance.part}"`);
  return part;
}

/** The instance hanging from `socket` of `instance`, if any. */
const holderOf = (assembly: VoxelAssembly, { instance, socket }: SocketRef) =>
  assembly.instances.find(
    ({ parent }) => parent?.instance === instance && parent.socket === socket,
  );

/** The other socket of the mirror pair `socketId` of `part` is in, if it is in one. */
function pairedSocket(part: VoxelPart, socketId: string): string | undefined {
  const socket = part.sockets.find((s) => s.id === socketId);
  if (!socket) return undefined;
  return socket.mirrors ?? part.sockets.find((s) => s.mirrors === socketId)?.id;
}

/**
 * The socket a part on `at` mirrors onto (ADR 0023 §6, whole-branch mirroring): the other socket
 * of the pair when `at` is one of a mirror pair; otherwise the socket of the same ID on the
 * parent's mirror image (`mirrorImage`), if the parent has one and its part has that socket.
 */
function mirrorSocket(assembly: VoxelAssembly, at: SocketRef): SocketRef | undefined {
  const parent = findInstance(assembly, at.instance);
  if (!parent) return undefined;
  const pair = pairedSocket(partOf(assembly, parent), at.socket);
  if (pair !== undefined) return { instance: parent.id, socket: pair };
  const image = mirrorImage(assembly, parent.id);
  if (!image || !partOf(assembly, image).sockets.some((s) => s.id === at.socket)) return undefined;
  return { instance: image.id, socket: at.socket };
}

/**
 * An instance's mirror image (ADR 0023 §6; ADR 0022 §16), its twin: found from the nearest
 * instance on its path to the root, itself included, that hangs from a socket of a mirror pair,
 * by following the same sockets down from the instance on that pair's other socket. A hand on the
 * left arm has the hand on the right arm as its image. Only the nearest pair counts, so images
 * come in twos, never fours. None for the root, for a part with no pair above it, and when the
 * other side has no instance at the end of that path.
 */
export function mirrorImage(assembly: VoxelAssembly, id: string): VoxelInstance | undefined {
  let instance = findInstance(assembly, id);
  // The sockets from the paired ancestor down to the instance, the lowest first.
  const path: string[] = [];
  while (instance?.parent) {
    const at: SocketRef = instance.parent;
    const parent = findInstance(assembly, at.instance);
    if (!parent) return undefined;
    const pair = pairedSocket(partOf(assembly, parent), at.socket);
    if (pair !== undefined) {
      let image = holderOf(assembly, { instance: parent.id, socket: pair });
      for (let i = path.length - 1; image && i >= 0; i--) {
        image = holderOf(assembly, { instance: image.id, socket: path[i] ?? "" });
      }
      return image;
    }
    path.push(at.socket);
    instance = parent;
  }
  return undefined;
}

/** `instance` and its mirror image when mirroring and it has one. */
function withTwin(assembly: VoxelAssembly, instance: VoxelInstance, { mirror }: MirrorOption) {
  const twin = mirror ? mirrorImage(assembly, instance.id) : undefined;
  return twin ? [instance, twin] : [instance];
}

/** The IDs of the instances that hang below any of `roots`, `roots` included. */
function subtreeOf(assembly: VoxelAssembly, roots: readonly string[]): Set<string> {
  const ids = new Set(roots);
  // Every instance is listed after its parent.
  for (const { id, parent } of assembly.instances) {
    if (parent && ids.has(parent.instance)) ids.add(id);
  }
  return ids;
}

/** `parts` without the ones no instance uses, in the same key order. */
function prune(
  parts: VoxelAssembly["parts"],
  instances: readonly VoxelInstance[],
): VoxelAssembly["parts"] {
  const used = new Set(instances.map((instance) => instance.part));
  return Object.fromEntries(Object.entries(parts).filter(([key]) => used.has(key)));
}

const fits = (lookup: PartFitLookup, part: VoxelPart, socketType: string) =>
  lookup.fitsOf(part.type)?.includes(socketType) ?? false;

/** What makes a part the part it is, in a form two parts can be compared by. */
const partShape = (part: VoxelPart) =>
  JSON.stringify([
    part.type,
    part.step,
    [part.size.x, part.size.y, part.size.z],
    part.colors,
    part.voxels,
    [part.attach.x, part.attach.y, part.attach.z],
    part.sockets.map((s) => [s.id, s.type, s.position.x, s.position.y, s.position.z, s.mirrors]),
  ]);

/**
 * The parts with `library` among them: the key of a copy the assembly holds already, unedited
 * (copied from it and still the same), or of a fresh copy, keyed as `assembleParts` keys one.
 */
function withLibraryPart(parts: VoxelAssembly["parts"], library: LibraryPart) {
  const shape = partShape(library.part);
  const held = Object.entries(parts).find(
    ([, part]) => part.source === library.id && partShape(part) === shape,
  );
  if (held) return { parts, key: held[0] };
  const key = claimId(partKeyOf(library.id), new Set(Object.keys(parts)));
  return { parts: { ...parts, [key]: copyVoxelPart(library.part, library.id) }, key };
}

/** A new instance of the part `key` on `socket` of `parent`, at rest. */
const newInstance = (
  id: string,
  key: string,
  parent: string,
  socket: { id: string; mirrors?: string | undefined },
): VoxelInstance => ({
  id,
  part: key,
  parent: { instance: parent, socket: socket.id },
  rotation: [...IDENTITY_QUATERNION],
  mirrored: socket.mirrors !== undefined,
});

/**
 * Hangs a library part on a free socket (ADR 0023 §4, §6), at rest (no turn). With `mirror`, the
 * part also goes on the socket it mirrors onto: the other socket of a mirror pair (the part there
 * mirrored), or the same socket on the parent's mirror image (`mirrorImage`), when that socket is
 * free and the part fits it; both or neither. A taken or unfitting other socket is left as it is. New
 * instances are named after their socket (`left-eye`, `-2`… on a clash) and go last; a library
 * part is held once while its copy is unedited (`assembleParts` keys it the same way).
 */
export function attachPart(
  assembly: VoxelAssembly,
  at: SocketRef,
  part: LibraryPart,
  lookup: PartFitLookup,
  options: MirrorOption,
): AssemblyEditResult {
  const parent = findInstance(assembly, at.instance);
  if (!parent) return refuse("unknown_instance", `No instance "${at.instance}"`);
  const parentPart = partOf(assembly, parent);
  const socket = parentPart.sockets.find((s) => s.id === at.socket);
  if (!socket)
    return refuse("unknown_socket", `Part "${parent.part}" has no socket "${at.socket}"`);
  if (holderOf(assembly, at)) {
    return refuse("socket_taken", `Socket "${at.instance}/${at.socket}" is taken`);
  }
  if (!fits(lookup, part.part, socket.type)) {
    return refuse("does_not_fit", `Part "${part.id}" doesn't fit socket type "${socket.type}"`);
  }
  const sides = [{ parent: parent.id, socket }];
  const mirrored = options.mirror ? mirrorSocket(assembly, at) : undefined;
  const mirrorParent = mirrored && findInstance(assembly, mirrored.instance);
  const other =
    mirrorParent && partOf(assembly, mirrorParent).sockets.find((s) => s.id === mirrored.socket);
  if (other && mirrored && !holderOf(assembly, mirrored) && fits(lookup, part.part, other.type)) {
    sides.push({ parent: mirrored.instance, socket: other });
  }
  if (assembly.instances.length + sides.length > MAX_ASSEMBLY_INSTANCES) {
    return refuse("too_many_parts", `An assembly has at most ${MAX_ASSEMBLY_INSTANCES} parts`);
  }

  const { parts, key } = withLibraryPart(assembly.parts, part);
  const ids = new Set(assembly.instances.map((instance) => instance.id));
  const added = sides.map((side) =>
    newInstance(claimId(side.socket.id, ids), key, side.parent, side.socket),
  );
  return settle(
    { parts, instances: [...assembly.instances, ...added] },
    added.map((instance) => instance.id),
  );
}

/**
 * Every free socket that `attachPart` would hang `part` on, in the order of the instances, then of
 * each part's sockets (ADR 0023 §4: the sockets the Studio highlights).
 */
export function compatibleSockets(
  assembly: VoxelAssembly,
  part: LibraryPart,
  lookup: PartFitLookup,
  options: MirrorOption,
): SocketRef[] {
  const found: SocketRef[] = [];
  for (const instance of assembly.instances) {
    for (const socket of partOf(assembly, instance).sockets) {
      const at = { instance: instance.id, socket: socket.id };
      if (holderOf(assembly, at) || !fits(lookup, part.part, socket.type)) continue;
      if (attachPart(assembly, at, part, lookup, options).ok) found.push(at);
    }
  }
  return found;
}

/**
 * Puts a library part in place of an instance's part (ADR 0023 §5), at rest; with `mirror`, its
 * twin's too, both or neither. The instances keep their IDs. Each child of a replaced instance
 * hangs again, with everything below it, from the new part's socket of the same ID, if it has
 * one, the child fits its type and the assembly stays valid; the rest are removed. The root can be
 * replaced only by a part whose type has the `root` role (ADR 0023 §10), such as another torso.
 */
export function replacePart(
  assembly: VoxelAssembly,
  id: string,
  part: LibraryPart,
  lookup: PartFitLookup,
  options: MirrorOption,
): AssemblyEditResult {
  const target = findInstance(assembly, id);
  if (!target) return refuse("unknown_instance", `No instance "${id}"`);
  const targets = withTwin(assembly, target, options);
  for (const { parent } of targets) {
    if (!parent) {
      if (lookup.roleOf(part.part.type) === "root") continue;
      return refuse("not_root", `Part "${part.id}" isn't of a root type, so it can't be the root`);
    }
    const holder = findInstance(assembly, parent.instance);
    const socket = holder && partOf(assembly, holder).sockets.find((s) => s.id === parent.socket);
    if (socket && !fits(lookup, part.part, socket.type)) {
      return refuse("does_not_fit", `Part "${part.id}" doesn't fit socket type "${socket.type}"`);
    }
  }

  const { parts, key } = withLibraryPart(assembly.parts, part);
  const newPart = parts[key];
  if (!newPart) throw new Error(`No part "${key}"`);
  const changed = new Map<string, VoxelInstance>(
    targets.map((t) => [t.id, { ...t, part: key, rotation: [...IDENTITY_QUATERNION] }]),
  );
  const targetIds = targets.map((t) => t.id);
  const below = subtreeOf(assembly, targetIds);
  for (const t of targetIds) below.delete(t);
  const build = (removed: ReadonlySet<string>): VoxelAssembly => {
    const instances = assembly.instances
      .filter((instance) => !removed.has(instance.id))
      .map((instance) => changed.get(instance.id) ?? instance);
    return { parts: prune(parts, instances), instances };
  };

  let result = settle(build(below), targetIds);
  if (!result.ok) return result;
  // The children, in order, each kept with what hangs below it if the assembly stays valid.
  const children = assembly.instances.filter(
    ({ parent }) => parent && targetIds.includes(parent.instance),
  );
  for (const child of children) {
    const socket = newPart.sockets.find((s) => s.id === child.parent?.socket);
    if (!socket || !fits(lookup, partOf(assembly, child), socket.type)) continue;
    const mirrored = socket.mirrors !== undefined;
    if (child.mirrored !== mirrored) changed.set(child.id, { ...child, mirrored });
    const kept = new Set(below);
    for (const rehung of subtreeOf(assembly, [child.id])) kept.delete(rehung);
    const attempt = settle(build(kept), targetIds);
    if (attempt.ok) {
      result = attempt;
      for (const rehung of subtreeOf(assembly, [child.id])) below.delete(rehung);
    } else {
      changed.delete(child.id);
    }
  }
  return result;
}

/**
 * Removes an instance and everything that hangs below it; with `mirror`, its twin's too. Parts no
 * instance uses any more are dropped. The root can't be removed.
 */
export function removePart(
  assembly: VoxelAssembly,
  id: string,
  options: MirrorOption,
): AssemblyEditResult {
  const target = findInstance(assembly, id);
  if (!target) return refuse("unknown_instance", `No instance "${id}"`);
  if (!target.parent) return refuse("root", "The root can't be removed");
  const targets = withTwin(assembly, target, options).map((t) => t.id);
  const removed = subtreeOf(assembly, targets);
  const instances = assembly.instances.filter((instance) => !removed.has(instance.id));
  // The one asked for first, then the rest in the assembly's order.
  const gone = [
    id,
    ...assembly.instances.filter((i) => removed.has(i.id) && i.id !== id).map((i) => i.id),
  ];
  return settle({ parts: prune(assembly.parts, instances), instances }, gone);
}

const HALF = Math.SQRT1_2;
/** A quarter turn about Y: +X turns toward −Z. */
const QUARTER_TURN_Y: Quaternion = [0, HALF, 0, HALF];
/** The components a quarter-turn quaternion can have. */
const QUARTER_COMPONENTS = [0, 0.5, HALF, 1].flatMap((v) => (v === 0 ? [0] : [v, -v]));

/** `a · b`: `b` first, then `a`. */
const multiply = ([ax, ay, az, aw]: Quaternion, [bx, by, bz, bw]: Quaternion): Quaternion => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];

/**
 * A quarter-turn quaternion snapped to its exact components, so turning again and again never
 * drifts, with the sign that makes its first nonzero component of `w, x, y, z` positive.
 */
function snapQuarterTurn(q: Quaternion): Quaternion {
  const snapped = q.map((value) =>
    QUARTER_COMPONENTS.reduce((best, c) =>
      Math.abs(c - value) < Math.abs(best - value) ? c : best,
    ),
  ) as Quaternion;
  const [x, y, z, w] = snapped;
  const lead = [w, x, y, z].find((value) => value !== 0) ?? 1;
  return lead < 0 ? (snapped.map((value) => -value + 0) as Quaternion) : snapped;
}

/** `rotation` turned a quarter turn about its socket's Y axis, its parent's Y. */
const turnAboutY = (rotation: Quaternion) => snapQuarterTurn(multiply(QUARTER_TURN_Y, rotation));

/**
 * Turns an instance a quarter turn about its socket's Y axis (ADR 0023 §7): +X toward −Z, or for
 * a mirrored part, drawn reflected, the other way; with `mirror`, its twin takes the same stored
 * rotation, so a pair stays (or becomes again) mirror images even when its sides were turned
 * apart while mirroring was off. A turn that would leave the assembly invalid (a joint, the
 * depth) is skipped for the next; refused when all three other turns are. The root can't turn.
 */
export function rotatePart(
  assembly: VoxelAssembly,
  id: string,
  options: MirrorOption,
): AssemblyEditResult {
  const target = findInstance(assembly, id);
  if (!target) return refuse("unknown_instance", `No instance "${id}"`);
  if (!target.parent) return refuse("root", "The root hangs from no socket to turn about");
  const targets = withTwin(assembly, target, options);
  const ids = targets.map((t) => t.id);
  let rotation = target.rotation;
  for (let turn = 1; turn < 4; turn++) {
    rotation = turnAboutY(rotation);
    const turned = new Map(targets.map((t) => [t.id, { ...t, rotation }]));
    const instances = assembly.instances.map((instance) => turned.get(instance.id) ?? instance);
    const result = settle({ parts: assembly.parts, instances }, ids);
    if (result.ok) return result;
  }
  return refuse("no_turn", `No other quarter turn of "${id}" leaves the assembly valid`);
}

/**
 * The assembly with `edit` applied to the part copies of `targets` (ADR 0023 §8, §12): a copy used
 * by no other instance is edited in place, under its key; one shared beyond them is copied first
 * (copy on write), under a new key from the copy's base key (`legs-short-2`, never
 * `legs-short-2-2`), for the targets alone.
 */
function editCopies(
  assembly: VoxelAssembly,
  targets: readonly VoxelInstance[],
  edit: (part: VoxelPart) => VoxelPart,
): VoxelAssembly {
  const ids = new Set(targets.map((t) => t.id));
  const parts = { ...assembly.parts };
  const keys = new Set(Object.keys(parts));
  const moved = new Map<string, string>();
  for (const key of new Set(targets.map((t) => t.part))) {
    const part = parts[key];
    if (!part) throw new Error(`Unknown part "${key}"`);
    const shared = assembly.instances.some((i) => i.part === key && !ids.has(i.id));
    if (shared) {
      const copy = claimId(key.replace(/-\d+$/, ""), keys);
      parts[copy] = edit(part);
      moved.set(key, copy);
    } else {
      parts[key] = edit(part);
    }
  }
  if (moved.size === 0) return { parts, instances: assembly.instances };
  const instances = assembly.instances.map((instance) => {
    const key = ids.has(instance.id) ? moved.get(instance.part) : undefined;
    return key === undefined ? instance : { ...instance, part: key };
  });
  return { parts, instances };
}

/** The rung `direction` steps from `step` on the ladder, if there is one. */
const nextStep = (step: VoxelPart["step"], direction: 1 | -1) =>
  VOXEL_STEPS[VOXEL_STEPS.indexOf(step) + direction];

/**
 * Moves an instance's part one rung up (+1, larger cubes) or down (−1) the step ladder (ADR 0023
 * §8): the part copy of the instance and, with `mirror`, of its twin, copied first when shared
 * beyond them. The part keeps its cubes, so it grows or shrinks. Refused at the end of the ladder
 * and when a joint (ADR 0022 §12) would break. A joint left half a finer cube off the finer grid
 * snaps onto it (§13, as amended in M21 PR 7: `placeInstances`).
 */
export function stepPart(
  assembly: VoxelAssembly,
  id: string,
  direction: 1 | -1,
  options: MirrorOption,
): AssemblyEditResult {
  const target = findInstance(assembly, id);
  if (!target) return refuse("unknown_instance", `No instance "${id}"`);
  const targets = withTwin(assembly, target, options);
  for (const t of targets) {
    if (nextStep(partOf(assembly, t).step, direction) === undefined) {
      return refuse("ladder_end", `Part "${t.part}" is at the end of the step ladder`);
    }
  }
  const candidate = editCopies(assembly, targets, (part) => ({
    ...part,
    step: nextStep(part.step, direction) ?? part.step,
  }));
  return settle(
    candidate,
    targets.map((t) => t.id),
  );
}

/**
 * Moves every part one rung up or down the step ladder together (ADR 0023 §8), so their ratios
 * stay: the creature doubles or halves in size. Refused when any part is at the end of the ladder.
 */
export function stepAssembly(assembly: VoxelAssembly, direction: 1 | -1): AssemblyEditResult {
  const parts: VoxelAssembly["parts"] = {};
  for (const [key, part] of Object.entries(assembly.parts)) {
    const step = nextStep(part.step, direction);
    if (step === undefined) {
      return refuse("ladder_end", `Part "${key}" is at the end of the step ladder`);
    }
    parts[key] = { ...part, step };
  }
  return settle(
    { parts, instances: assembly.instances },
    assembly.instances.map((instance) => instance.id),
  );
}

/**
 * Sets one colour of an instance's part, `colors[index]` (ADR 0023 §12): of its part copy and,
 * with `mirror`, of its twin's when that part has the colour too, copied first when shared beyond
 * them. When the colour is already that everywhere, the assembly is returned as it is, so
 * `recordEdit` records nothing.
 */
export function recolorPart(
  assembly: VoxelAssembly,
  id: string,
  index: number,
  color: string,
  options: MirrorOption,
): AssemblyEditResult {
  const target = findInstance(assembly, id);
  if (!target) return refuse("unknown_instance", `No instance "${id}"`);
  const hasColor = (instance: VoxelInstance) =>
    Number.isInteger(index) && index >= 0 && index < partOf(assembly, instance).colors.length;
  if (!hasColor(target)) {
    return refuse("unknown_color", `Part "${target.part}" has no colour ${index}`);
  }
  if (!HexColorSchema.safeParse(color).success) {
    return refuse("invalid_color", `"${color}" isn't a #rrggbb colour`);
  }
  const targets = withTwin(assembly, target, options).filter(hasColor);
  const ids = targets.map((t) => t.id);
  const differs = (instance: VoxelInstance) =>
    partOf(assembly, instance).colors[index]?.toLowerCase() !== color.toLowerCase();
  const changing = targets.filter(differs);
  if (changing.length === 0) return { ok: true, assembly, instances: ids };
  const candidate = editCopies(assembly, changing, (part) => ({
    ...part,
    colors: part.colors.with(index, color),
  }));
  return settle(candidate, ids);
}

/**
 * Where a drag or click points, in the body frame (metres, as `measureAssembly` and the renderer
 * use): a ray from `origin`, usually the camera, along `direction`, not necessarily unit length.
 */
export interface SocketProbe {
  origin: Vec3;
  direction: Vec3;
}

/** A socket as `scoreSockets` ranks it. */
export interface ScoredSocket extends SocketRef {
  /** The socket in the body frame, in metres: where a part on it has its attach point. */
  position: Vec3;
  /** Radians between the probe's direction and the line from its origin to the socket. */
  angle: number;
  /** Metres from the probe's origin to the socket. */
  distance: number;
  /** `angle + distanceWeight · distance`: the lower, the better. */
  score: number;
}

/**
 * Ranks sockets by how well a probe points at them (ADR 0023 §4): by angle off the probe's ray,
 * plus distance from its origin times `distanceWeight` (radians per metre, 1 unless given), so a
 * nearer socket wins when two line up. Best first; ties keep the order of `sockets`. The Studio's
 * click-to-place and drag-to-socket share it, passing the free sockets a part fits
 * (`compatibleSockets`). Throws on an unknown socket and on a zero direction.
 */
export function scoreSockets(
  assembly: VoxelAssembly,
  sockets: readonly SocketRef[],
  probe: SocketProbe,
  { distanceWeight = 1 }: { distanceWeight?: number } = {},
): ScoredSocket[] {
  const { direction, origin } = probe;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0)) throw new RangeError("The probe needs a direction");
  const placements = placeInstances(assembly);
  const { origin: bodyOrigin } = measureAssembly(assembly);
  const index = new Map(assembly.instances.map((instance, i) => [instance.id, i]));
  return sockets
    .map((ref) => {
      const i = index.get(ref.instance);
      const instance = i === undefined ? undefined : assembly.instances[i];
      const placement = i === undefined ? undefined : placements[i];
      const socket =
        instance && partOf(assembly, instance).sockets.find((s) => s.id === ref.socket);
      if (!instance || !placement || !socket) {
        throw new Error(`No socket "${ref.instance}/${ref.socket}"`);
      }
      // As `placeInstances` places a child: the parent's placement of the socket's point.
      const step = stepUnits(partOf(assembly, instance).step);
      const { x, y, z } = socket.position;
      const { linear, offset } = placement;
      const m = (k: number) => linear[k] ?? 0;
      const axis = (row: 0 | 1 | 2) =>
        ((m(row * 3) * x + m(row * 3 + 1) * y + m(row * 3 + 2) * z) * step +
          offset[row] -
          bodyOrigin[row]) *
        VOXEL_UNIT;
      const position = { x: axis(0), y: axis(1), z: axis(2) };
      const to = { x: position.x - origin.x, y: position.y - origin.y, z: position.z - origin.z };
      const distance = Math.hypot(to.x, to.y, to.z);
      const cos =
        distance === 0
          ? 1
          : (to.x * direction.x + to.y * direction.y + to.z * direction.z) / (distance * length);
      const angle = Math.acos(Math.min(1, Math.max(-1, cos)));
      return { ...ref, position, angle, distance, score: angle + distanceWeight * distance };
    })
    .sort((a, b) => a.score - b.score);
}

/**
 * The Studio's undo history (ADR 0023 §16): whole assemblies, each sharing what it didn't change
 * with the one before. Immutable: every function returns a new history.
 */
export interface AssemblyHistory {
  /** Older assemblies, oldest first. */
  readonly past: readonly VoxelAssembly[];
  readonly present: VoxelAssembly;
  /** Undone assemblies, the next to redo first. */
  readonly future: readonly VoxelAssembly[];
}

/** How many undo steps a history keeps; older ones are forgotten. */
export const MAX_UNDO_STEPS = 100;

/** A history with nothing to undo or redo. */
export const startHistory = (assembly: VoxelAssembly): AssemblyHistory => ({
  past: [],
  present: assembly,
  future: [],
});

/**
 * The history after an edit made `assembly`: it becomes the present and the redo steps are
 * forgotten. Recording the present again changes nothing.
 */
export function recordEdit(history: AssemblyHistory, assembly: VoxelAssembly): AssemblyHistory {
  if (assembly === history.present) return history;
  return {
    past: [...history.past, history.present].slice(-MAX_UNDO_STEPS),
    present: assembly,
    future: [],
  };
}

/** The history one step back, or the same one when there is nothing to undo. */
export function undoEdit(history: AssemblyHistory): AssemblyHistory {
  const previous = history.past.at(-1);
  if (!previous) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

/** The history one step forward again, or the same one when there is nothing to redo. */
export function redoEdit(history: AssemblyHistory): AssemblyHistory {
  const [next, ...rest] = history.future;
  if (!next) return history;
  return { past: [...history.past, history.present], present: next, future: rest };
}
