import { z } from "zod";
import { SIZE_CLASSES, type SizeClass } from "./constants";
import type { PartRole, PartTypeDefinition, SocketTypeDefinition } from "./definitions";
import { error, warning, type Diagnostic } from "./diagnostics";
import { LocalIdSchema, parseContentId, type Vec3 } from "./primitives";
import {
  MAX_ASSEMBLY_FACES,
  MAX_ASSEMBLY_INSTANCES,
  VOXEL_UNIT,
  VoxelPartSchema,
  decodeVoxels,
  stepUnits,
  visibleFaces,
  voxelIndex,
  type VoxelPart,
  type VoxelPoint,
  type VoxelSocket,
} from "./voxel";

// A voxel creature's body (ADR 0022 §9–§13): a tree of part instances with one root. Exact checks
// run in whole `VOXEL_UNIT`s (half the finest step), where every point on every part is a whole
// number and every rest rotation (quarter turns, optionally mirrored) is a signed permutation.

/** A rotation as a unit quaternion `[x, y, z, w]`. */
export const QuaternionSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quaternion = z.output<typeof QuaternionSchema>;

/** The rotation that turns nothing. */
export const IDENTITY_QUATERNION: Quaternion = [0, 0, 0, 1];

/** How far a quaternion may be from a unit quarter-turn one and still count as one. */
const ROTATION_EPSILON = 1e-6;

/**
 * One part in an assembly: which frozen part it is, which socket of which earlier instance it
 * hangs from, and its rest rotation about its attach point (ADR 0022 §9).
 */
export const VoxelInstanceSchema = z.strictObject({
  /** Unique within the assembly, e.g. `front-left-leg`. */
  id: LocalIdSchema,
  /** The key of its part in the assembly's `parts`. Several instances may share a part. */
  part: LocalIdSchema,
  /** The socket it hangs from. Only the root, the first instance, has none. */
  parent: z.strictObject({ instance: LocalIdSchema, socket: LocalIdSchema }).optional(),
  /**
   * The rest rotation about its attach point, in its parent's frame. Stored in general form, but
   * only quarter turns are allowed for now, so cubes stay on the grid (§9).
   */
  rotation: QuaternionSchema.default(IDENTITY_QUATERNION),
  /**
   * True for the part on the mirrored socket of a pair, and only there (§16): draw this part
   * reflected in the creature's XY plane. The two parts of a pair may differ (a crab's big left
   * claw and small right one), in part and rotation; nothing checks that they match, though the
   * Studio uses the same part on both sides by default. The stored part, attach point and
   * rotation are the unmirrored ones, as they would be on the pair's other socket; a consumer
   * derives the mirrored ones: the part reflected about its own middle plane (z → Z − z in its
   * cubes), its attach point likewise (z → Z − z), and its rotation `[x, y, z, w]` →
   * `[−x, −y, z, w]`. Placed, that is `M · R · (p − attach) + socket` with `M` the reflection
   * z → −z, as `placeInstances` does.
   *
   * The reflection carries down the tree: a part hanging from a mirrored part (a hand on a
   * mirrored arm) is reflected too, though its own flag is false, and a mirrored part on a
   * mirrored part (a mirror inside a mirror) is not. Whether a part is drawn reflected is
   * `InstancePlacement.mirrored`, never this flag alone.
   */
  mirrored: z.boolean().default(false),
});
export type VoxelInstance = z.output<typeof VoxelInstanceSchema>;

type Issue = (message: string, path: (string | number)[]) => void;

/**
 * A voxel creature's assembled body (ADR 0022 §11, §17): a frozen copy of every part it uses,
 * keyed by a local ID, and the instances of those parts, the root first and every other instance
 * after the one it hangs from.
 */
export const VoxelAssemblySchema = z
  .strictObject({
    parts: z.record(LocalIdSchema, VoxelPartSchema),
    instances: z
      .array(VoxelInstanceSchema)
      .min(1, { error: "An assembly needs a root part" })
      .max(MAX_ASSEMBLY_INSTANCES, {
        error: `An assembly has at most ${MAX_ASSEMBLY_INSTANCES} parts`,
      }),
  })
  .superRefine(
    (assembly, ctx) =>
      checkAssembly(assembly, (message, path) => ctx.addIssue({ code: "custom", message, path })),
    // Only once the parts and instances are each valid.
    { when: ({ issues }) => issues.length === 0 },
  );
export type VoxelAssembly = z.output<typeof VoxelAssemblySchema>;
export type VoxelAssemblyInput = z.input<typeof VoxelAssemblySchema>;

type Triple = [number, number, number];

/** `values[i]`, known to be there. */
const num = (values: ArrayLike<number>, i: number): number => values[i] ?? 0;

/** `list[i]`, known to be there. */
function item<T>(list: readonly T[], i: number): T {
  const value = list[i];
  if (value === undefined) throw new Error(`No item ${i}`);
  return value;
}

/** An instance's part, in an assembly known to be valid. */
function partOf(assembly: VoxelAssembly, instance: VoxelInstance): VoxelPart {
  const part = assembly.parts[instance.part];
  if (!part) throw new Error(`Unknown part "${instance.part}"`);
  return part;
}

/** A 3×3 matrix, row-major. */
type Matrix = readonly number[];

const MIRROR: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, -1];

const multiply = (a: Matrix, b: Matrix): number[] => {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push(
        num(a, r * 3) * num(b, c) +
          num(a, r * 3 + 1) * num(b, 3 + c) +
          num(a, r * 3 + 2) * num(b, 6 + c),
      );
    }
  }
  return out;
};

const apply = (m: Matrix, v: readonly number[]): Triple => [
  num(m, 0) * num(v, 0) + num(m, 1) * num(v, 1) + num(m, 2) * num(v, 2),
  num(m, 3) * num(v, 0) + num(m, 4) * num(v, 1) + num(m, 5) * num(v, 2),
  num(m, 6) * num(v, 0) + num(m, 7) * num(v, 1) + num(m, 8) * num(v, 2),
];

/**
 * The rotation matrix of a unit quaternion of quarter turns, whole numbers in row-major order,
 * or undefined for any other quaternion.
 */
export function quarterTurnMatrix([x, y, z, w]: Quaternion): number[] | undefined {
  if (Math.abs(x * x + y * y + z * z + w * w - 1) > ROTATION_EPSILON) return undefined;
  const m = [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
  const rounded = m.map(Math.round);
  return m.every((value, i) => Math.abs(value - num(rounded, i)) <= ROTATION_EPSILON)
    ? rounded.map((value) => value + 0) // no -0
    : undefined;
}

/**
 * The rest rotation of a part on the mirrored socket of a pair, given the rotation it is stored
 * with (`VoxelInstance.mirrored`): `[x, y, z, w]` → `[−x, −y, z, w]`, the rotation reflected in
 * the creature's XY plane.
 */
export const mirrorQuaternion = ([x, y, z, w]: Quaternion): Quaternion => [-x, -y, z, w];

/** A point on a part in `VOXEL_UNIT`s from its corner. */
const units = (point: VoxelPoint, step: number): Triple => [
  point.x * step,
  point.y * step,
  point.z * step,
];

const AXES = ["x", "y", "z"] as const;

/** Whether every cube within `depth` units of `point` (units) is a filled cube of the part. */
function isBuried(part: VoxelPart, grid: Uint8Array, point: Triple, depth: number): boolean {
  const step = stepUnits(part.step);
  const lo: number[] = [];
  const hi: number[] = [];
  for (let a = 0; a < 3; a++) {
    lo.push(Math.floor((num(point, a) - depth) / step));
    hi.push(Math.ceil((num(point, a) + depth) / step) - 1);
    if (num(lo, a) < 0 || num(hi, a) >= part.size[item(AXES, a)]) return false;
  }
  for (let z = num(lo, 2); z <= num(hi, 2); z++) {
    for (let y = num(lo, 1); y <= num(hi, 1); y++) {
      for (let x = num(lo, 0); x <= num(hi, 0); x++) {
        if (grid[voxelIndex(part.size, x, y, z)] === 0) return false;
      }
    }
  }
  return true;
}

const mod = (value: number, by: number) => ((value % by) + by) % by;

const centimetres = (unitCount: number) => `${+(unitCount * VOXEL_UNIT * 100).toFixed(4)} cm`;

/**
 * §12: whether `socket` of `parentPart` lies at least one cube of the finer grid of the parent
 * and `part` deep inside the parent's filled cubes. `parentGrid` is the parent's decoded cubes.
 */
function isSocketBuried(
  parentPart: VoxelPart,
  parentGrid: Uint8Array,
  socket: VoxelSocket,
  part: VoxelPart,
): boolean {
  const parentStep = stepUnits(parentPart.step);
  const finer = Math.min(parentStep, stepUnits(part.step));
  return isBuried(parentPart, parentGrid, units(socket.position, parentStep), finer);
}

/**
 * §13: whether `part`, hanging from `socket` of `parentPart` with the rest rotation `turn` (a
 * `quarterTurnMatrix`) and mirrored or not, sits on the finer grid of the two.
 */
function isOnFinerGrid(
  parentPart: VoxelPart,
  socket: VoxelSocket,
  part: VoxelPart,
  turn: Matrix,
  mirrored: boolean,
): boolean {
  const parentStep = stepUnits(parentPart.step);
  const finer = Math.min(parentStep, stepUnits(part.step));
  const at = units(socket.position, parentStep);
  const attach = apply(
    mirrored ? multiply(MIRROR, turn) : turn,
    units(part.attach, stepUnits(part.step)),
  );
  return at.every((value, a) => mod(value - num(attach, a), finer) === 0);
}

/** The structural checks (ADR 0022 §9, §11–§13, §16): they need no registered types. */
function checkAssembly(assembly: VoxelAssembly, issue: Issue): void {
  const { parts, instances } = assembly;
  const indexById = new Map<string, number>();
  const used = new Set<string>();
  const taken = new Map<string, string>();
  const grids = new Map<string, Uint8Array>();
  const gridOf = (key: string, part: VoxelPart) => {
    let grid = grids.get(key);
    if (!grid) grids.set(key, (grid = decodeVoxels(part.voxels, part.size)));
    return grid;
  };

  instances.forEach((instance, i) => {
    const path = ["instances", i];
    if (indexById.has(instance.id))
      issue(`Duplicate instance ID "${instance.id}"`, [...path, "id"]);
    else indexById.set(instance.id, i);
    const part = parts[instance.part];
    if (part) used.add(instance.part);
    else issue(`Unknown part "${instance.part}"`, [...path, "part"]);
    const turn = quarterTurnMatrix(instance.rotation);
    if (!turn) {
      issue("The rest rotation must be a unit quaternion of quarter turns", [...path, "rotation"]);
    }

    if (i === 0) {
      if (instance.parent) {
        issue("The first instance is the root and hangs from no socket", [...path, "parent"]);
      }
      if (instance.mirrored) issue("The root isn't mirrored", [...path, "mirrored"]);
      return;
    }
    const { parent } = instance;
    if (!parent) {
      issue("Only the root, the first instance, hangs from no socket", [...path, "parent"]);
      return;
    }
    const parentIndex = indexById.get(parent.instance);
    if (parentIndex === undefined || parentIndex >= i) {
      issue(`The parent "${parent.instance}" must be an instance listed before this one`, [
        ...path,
        "parent",
        "instance",
      ]);
      return;
    }
    const parentKey = item(instances, parentIndex).part;
    const parentPart = parts[parentKey];
    if (!parentPart) return;
    const socketPath = [...path, "parent", "socket"];
    const socket = parentPart.sockets.find((s) => s.id === parent.socket);
    if (!socket) {
      issue(`Part "${parentKey}" has no socket "${parent.socket}"`, socketPath);
      return;
    }
    const slot = `${parent.instance}/${socket.id}`;
    const holder = taken.get(slot);
    if (holder !== undefined) {
      issue(`Socket "${slot}" is already taken by "${holder}"`, socketPath);
    } else {
      taken.set(slot, instance.id);
    }
    const onMirror = socket.mirrors !== undefined;
    if (instance.mirrored !== onMirror) {
      issue(
        onMirror
          ? `Socket "${socket.id}" mirrors "${socket.mirrors}", so the part on it is mirrored`
          : `Only a part on the mirrored socket of a pair is mirrored; "${socket.id}" mirrors none`,
        [...path, "mirrored"],
      );
    }
    if (!part || !turn) return;

    const finer = Math.min(stepUnits(parentPart.step), stepUnits(part.step));
    if (!isSocketBuried(parentPart, gridOf(parentKey, parentPart), socket, part)) {
      issue(
        `Socket "${socket.id}" must lie at least one cube of the finer grid (${centimetres(finer)}) deep inside part "${parentKey}"`,
        socketPath,
      );
    }
    if (!isOnFinerGrid(parentPart, socket, part, turn, instance.mirrored)) {
      issue(
        `The part must sit on the finer grid of it and its parent (${centimetres(finer)} cubes): move its attach point or the socket by half a cube`,
        [...path, "part"],
      );
    }
  });

  for (const key of Object.keys(parts)) {
    if (!used.has(key)) issue(`Part "${key}" is used by no instance`, ["parts", key]);
  }

  // A cap on what the creature costs to draw.
  const faces = new Map<string, number>();
  let total = 0;
  for (const instance of instances) {
    const part = parts[instance.part];
    if (!part) continue;
    let count = faces.get(instance.part);
    if (count === undefined) {
      count = visibleFaces(gridOf(instance.part, part), part.size);
      faces.set(instance.part, count);
    }
    total += count;
  }
  if (total > MAX_ASSEMBLY_FACES) {
    issue(`The parts show ${total} cube faces; an assembly shows at most ${MAX_ASSEMBLY_FACES}`, [
      "instances",
    ]);
  }
}

/**
 * Where an instance's part sits in the root's frame: a point `p` on the part, in `VOXEL_UNIT`s
 * from its corner, is at `linear · p + offset` in the root's frame, also in `VOXEL_UNIT`s. The
 * root's attach point is at the origin.
 */
export interface InstancePlacement {
  /** Row-major 3×3 whole numbers: the rest rotation and mirroring of the part and its parents. */
  linear: readonly number[];
  offset: readonly [number, number, number];
  /**
   * Whether the part is drawn reflected: an odd number of the instances on its path from the root,
   * itself included, are mirrored (`linear` has a negative determinant). A mesher reflects such a
   * part about its middle plane (z → Z − z in its cubes), and its sockets' positions likewise.
   */
  mirrored: boolean;
  /** How many instances it hangs below the root: 0 for the root (`instanceInset`). */
  depth: number;
}

/**
 * Where a part's mesh goes, its bone's rest transform: a point `q` of the mesh, in
 * `VOXEL_UNIT`s from the part's corner (cubes × `stepUnits`), reflected about the part's middle
 * plane when `placement.mirrored`, is at `rotation · q + offset` in the root's frame.
 * `rotation` is `linear · (mirrored ? M : I)` with `M` the reflection z → −z: a proper
 * rotation, whole numbers, row-major.
 */
export function boneTransform(
  placement: InstancePlacement,
  part: VoxelPart,
): { rotation: number[]; offset: [number, number, number] } {
  const { linear, offset, mirrored } = placement;
  if (!mirrored) return { rotation: [...linear], offset: [offset[0], offset[1], offset[2]] };
  // q = M · p + (0, 0, Z), so linear · p + offset = linear · M · q + linear · (0, 0, Z) + offset.
  const depth = part.size.z * stepUnits(part.step);
  const shift = apply(linear, [0, 0, depth]);
  return {
    rotation: multiply(linear, MIRROR),
    offset: [offset[0] + shift[0], offset[1] + shift[1], offset[2] + shift[2]],
  };
}

const determinant = (m: Matrix): number =>
  num(m, 0) * (num(m, 4) * num(m, 8) - num(m, 5) * num(m, 7)) -
  num(m, 1) * (num(m, 3) * num(m, 8) - num(m, 5) * num(m, 6)) +
  num(m, 2) * (num(m, 3) * num(m, 7) - num(m, 4) * num(m, 6));

/**
 * Places every instance of a valid assembly (one that `VoxelAssemblySchema` accepts) in the root
 * part's frame, in its rest pose, in the order of `assembly.instances`.
 */
export function placeInstances(assembly: VoxelAssembly): InstancePlacement[] {
  const placed: InstancePlacement[] = [];
  const indexById = new Map(assembly.instances.map((instance, i) => [instance.id, i]));
  for (const instance of assembly.instances) {
    const part = assembly.parts[instance.part];
    const turn = quarterTurnMatrix(instance.rotation);
    if (!part || !turn) throw new Error(`Instance "${instance.id}" is not valid`);
    const local = instance.mirrored ? multiply(MIRROR, turn) : turn;
    const attach = apply(local, units(part.attach, stepUnits(part.step)));
    if (!instance.parent) {
      placed.push({
        linear: local,
        offset: [-attach[0], -attach[1], -attach[2]],
        mirrored: determinant(local) < 0,
        depth: 0,
      });
      continue;
    }
    const { parent } = instance;
    const above = placed[indexById.get(parent.instance) ?? -1];
    const parentInstance = assembly.instances[indexById.get(parent.instance) ?? -1];
    const parentPart = parentInstance && assembly.parts[parentInstance.part];
    const socket = parentPart?.sockets.find((s) => s.id === parent.socket);
    if (!above || !parentPart || !socket) throw new Error(`Instance "${instance.id}" is not valid`);
    const at = units(socket.position, stepUnits(parentPart.step));
    const inParent = apply(above.linear, [at[0] - attach[0], at[1] - attach[1], at[2] - attach[2]]);
    const linear = multiply(above.linear, local);
    placed.push({
      linear,
      offset: [
        inParent[0] + above.offset[0],
        inParent[1] + above.offset[1],
        inParent[2] + above.offset[2],
      ],
      mirrored: determinant(linear) < 0,
      depth: above.depth + 1,
    });
  }
  return placed;
}

/**
 * Calls `visit` with the root-frame box of every filled cube of every instance, in `VOXEL_UNIT`s,
 * min and max corners, and the instance's index.
 */
function forEachCube(
  assembly: VoxelAssembly,
  placements: readonly InstancePlacement[],
  visit: (min: Triple, max: Triple, instance: number) => void,
  grids = new Map<string, Uint8Array>(),
): void {
  assembly.instances.forEach((instance, i) => {
    const part = partOf(assembly, instance);
    const { linear, offset } = item(placements, i);
    let grid = grids.get(instance.part);
    if (!grid) grids.set(instance.part, (grid = decodeVoxels(part.voxels, part.size)));
    const step = stepUnits(part.step);
    const { size } = part;
    for (let z = 0, at = 0; z < size.z; z++) {
      for (let y = 0; y < size.y; y++) {
        for (let x = 0; x < size.x; x++, at++) {
          if (grid[at] === 0) continue;
          const a = apply(linear, [x * step, y * step, z * step]);
          const b = apply(linear, [(x + 1) * step, (y + 1) * step, (z + 1) * step]);
          visit(
            [
              Math.min(a[0], b[0]) + offset[0],
              Math.min(a[1], b[1]) + offset[1],
              Math.min(a[2], b[2]) + offset[2],
            ],
            [
              Math.max(a[0], b[0]) + offset[0],
              Math.max(a[1], b[1]) + offset[1],
              Math.max(a[2], b[2]) + offset[2],
            ],
            i,
          );
        }
      }
    }
  });
}

/** Neighbours of a cube: axis and direction. */
const SIDES = [0, 1, 2].flatMap((axis) => [-1, 1].map((sign) => ({ axis, sign })));

/** The size of the cells faces are bucketed by, in `VOXEL_UNIT`s: the coarsest step's cube. */
const FACE_CELL = 16;

/**
 * Warnings about a valid assembly (ADR 0022 §14, as amended in M19): two parts whose outer faces
 * lie flush in one plane, facing the same way. A renderer shrinks every part but the root a
 * little toward its centre so they never flicker (`CHILD_PART_INSET`), but the shape may not be
 * what the player meant.
 */
export function assemblyWarnings(assembly: VoxelAssembly, source?: string): Diagnostic[] {
  const placements = placeInstances(assembly);
  const buckets = new Map<
    string,
    { instance: number; u0: number; u1: number; v0: number; v1: number }[]
  >();
  const pairs = new Set<string>();
  const grids = new Map<string, Uint8Array>();

  assembly.instances.forEach((instance, i) => {
    const part = partOf(assembly, instance);
    let grid = grids.get(instance.part);
    if (!grid) grids.set(instance.part, (grid = decodeVoxels(part.voxels, part.size)));
    const { size } = part;
    const step = stepUnits(part.step);
    const { linear, offset } = item(placements, i);
    const filled = (x: number, y: number, z: number) =>
      x >= 0 &&
      y >= 0 &&
      z >= 0 &&
      x < size.x &&
      y < size.y &&
      z < size.z &&
      grid[voxelIndex(size, x, y, z)] !== 0;
    for (let z = 0; z < size.z; z++) {
      for (let y = 0; y < size.y; y++) {
        for (let x = 0; x < size.x; x++) {
          if (!filled(x, y, z)) continue;
          const cube: Triple = [x, y, z];
          let min: Triple | undefined;
          let max: Triple | undefined;
          for (const { axis, sign } of SIDES) {
            const next: Triple = [x, y, z];
            next[axis] = num(next, axis) + sign;
            if (filled(...next)) continue;
            if (!min || !max) {
              const a = apply(linear, [cube[0] * step, cube[1] * step, cube[2] * step]);
              const b = apply(linear, [(x + 1) * step, (y + 1) * step, (z + 1) * step]);
              min = [0, 1, 2].map((k) => Math.min(num(a, k), num(b, k)) + num(offset, k)) as Triple;
              max = [0, 1, 2].map((k) => Math.max(num(a, k), num(b, k)) + num(offset, k)) as Triple;
            }
            // The face's axis and direction in the root's frame.
            const rootAxis = [0, 1, 2].find((r) => linear[r * 3 + axis] !== 0) ?? 0;
            const rootSign = sign * num(linear, rootAxis * 3 + axis);
            const plane = rootSign > 0 ? max[rootAxis] : min[rootAxis];
            const [u, v] = [0, 1, 2].filter((k) => k !== rootAxis) as [number, number];
            const face = {
              instance: i,
              u0: num(min, u),
              u1: num(max, u),
              v0: num(min, v),
              v1: num(max, v),
            };
            for (let cu = Math.floor(face.u0 / FACE_CELL); cu * FACE_CELL < face.u1; cu++) {
              for (let cv = Math.floor(face.v0 / FACE_CELL); cv * FACE_CELL < face.v1; cv++) {
                const key = `${rootAxis}${rootSign}|${plane}|${cu}|${cv}`;
                let bucket = buckets.get(key);
                if (!bucket) buckets.set(key, (bucket = []));
                for (const other of bucket) {
                  if (
                    other.instance !== i &&
                    Math.min(other.u1, face.u1) > Math.max(other.u0, face.u0) &&
                    Math.min(other.v1, face.v1) > Math.max(other.v0, face.v0)
                  ) {
                    pairs.add(`${other.instance} ${i}`);
                  }
                }
                bucket.push(face);
              }
            }
          }
        }
      }
    }
  });

  return [...pairs]
    .map((pair) => pair.split(" ").map(Number) as [number, number])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([a, b]) =>
      warning(
        "flush_faces",
        `Parts "${item(assembly.instances, a).id}" and "${item(assembly.instances, b).id}" have faces flush in one plane`,
        ["instances", b],
        source,
      ),
    );
}

/** Looks up registered part and socket types, for `checkAssemblyFit`. */
export interface VoxelTypeLookup {
  partType(id: string): PartTypeDefinition | undefined;
  socketType(id: string): SocketTypeDefinition | undefined;
}

/**
 * The checks that need registered types, run when a creature is released, not when it loads (a
 * released creature keeps working without its pack): every part and socket type is registered,
 * and every part fits the type of the socket it hangs from (ADR 0022 §9).
 */
export function checkAssemblyFit(
  assembly: VoxelAssembly,
  lookup: VoxelTypeLookup,
  source?: string,
): Diagnostic[] {
  const found: Diagnostic[] = [];
  for (const [key, part] of Object.entries(assembly.parts)) {
    if (!lookup.partType(part.type)) {
      found.push(
        error(
          "unknown_part_type",
          `Part type "${part.type}" is not registered`,
          ["parts", key, "type"],
          source,
        ),
      );
    }
    part.sockets.forEach((socket, i) => {
      if (!lookup.socketType(socket.type)) {
        found.push(
          error(
            "unknown_socket_type",
            `Socket type "${socket.type}" is not registered`,
            ["parts", key, "sockets", i, "type"],
            source,
          ),
        );
      }
    });
  }
  const byId = new Map(assembly.instances.map((instance) => [instance.id, instance]));
  assembly.instances.forEach((instance, i) => {
    if (!instance.parent) return;
    const part = assembly.parts[instance.part];
    const parentInstance = byId.get(instance.parent.instance);
    const parentPart = parentInstance && assembly.parts[parentInstance.part];
    const socket = parentPart?.sockets.find((s) => s.id === instance.parent?.socket);
    const type = part && lookup.partType(part.type);
    if (!socket || !type || type.fits.includes(socket.type)) return;
    found.push(
      error(
        "part_does_not_fit",
        `Part type "${type.id}" doesn't fit socket type "${socket.type}"`,
        ["instances", i, "parent", "socket"],
        source,
      ),
    );
  });
  return found;
}

/** A voxel body measured in its rest pose (ADR 0022 §3, §20, §21), in metres in the body frame. */
export interface AssemblyMeasure {
  /**
   * The body frame's origin in the root part's frame, in `VOXEL_UNIT`s, as `placeInstances`
   * places parts: a point `p` there is at `(p − origin) · VOXEL_UNIT` metres in the body frame.
   */
  origin: readonly [number, number, number];
  /**
   * The bounds of every cube. The body frame's origin is the middle of the bounds across X and Z,
   * with the bottom of the lowest cube at y = 0; axes as ADR 0022 §16.
   */
  bounds: { min: Vec3; max: Vec3 };
  height: number;
  /** How far the farthest cube corner lies from the origin, across X and Z. */
  footprintRadius: number;
  /**
   * The smallest size class whose height and radius hold the body, or undefined for a body too
   * large for every class.
   */
  sizeClass: SizeClass | undefined;
  /** Where the body rests on the ground: the X and Z extent of its lowest cubes, at y = 0. */
  groundContact: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** The centroid of the cubes' volume. */
  centerOfGravity: Vec3;
  /**
   * The attach point of the first instance whose part type has the `tail` role, or the middle of
   * the body's rear end (its least x, half its height, z = 0) when there is none.
   */
  tail: Vec3;
}

/** How far a measurement may exceed a size class and still be in it, in metres. */
const SIZE_EPSILON = 1e-9;

/** The smallest size class that holds a body `height` tall with a footprint of `radius`. */
export function sizeClassFor(height: number, radius: number): SizeClass | undefined {
  return (Object.keys(SIZE_CLASSES) as SizeClass[]).find(
    (name) =>
      height <= SIZE_CLASSES[name].height + SIZE_EPSILON &&
      radius <= SIZE_CLASSES[name].radius + SIZE_EPSILON,
  );
}

/**
 * Measures a valid assembly (one that `VoxelAssemblySchema` accepts) in its rest pose. `roleOf`
 * gives a part type's role, for the tail; a type it doesn't know has none. Pure and exact up to
 * the final conversion to metres; ignores `CHILD_PART_INSET`.
 */
export function measureAssembly(
  assembly: VoxelAssembly,
  roleOf: (partType: string) => PartRole | undefined = () => undefined,
): AssemblyMeasure {
  const placements = placeInstances(assembly);
  const grids = new Map<string, Uint8Array>();
  const lo: Triple = [Infinity, Infinity, Infinity];
  const hi: Triple = [-Infinity, -Infinity, -Infinity];
  const moment: Triple = [0, 0, 0];
  let volume = 0;
  forEachCube(
    assembly,
    placements,
    (min, max) => {
      const size = max[0] - min[0];
      const cube = size * size * size;
      volume += cube;
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(num(lo, a), num(min, a));
        hi[a] = Math.max(num(hi, a), num(max, a));
        moment[a] = num(moment, a) + (cube * (num(min, a) + num(max, a))) / 2;
      }
    },
    grids,
  );

  // The origin, in units: the middle across X and Z, the lowest cube's bottom.
  const origin: Triple = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  let farthest = 0;
  const ground = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  forEachCube(
    assembly,
    placements,
    (min, max) => {
      const dx = Math.max(Math.abs(min[0] - origin[0]), Math.abs(max[0] - origin[0]));
      const dz = Math.max(Math.abs(min[2] - origin[2]), Math.abs(max[2] - origin[2]));
      farthest = Math.max(farthest, dx * dx + dz * dz);
      if (min[1] === lo[1]) {
        ground.minX = Math.min(ground.minX, min[0]);
        ground.maxX = Math.max(ground.maxX, max[0]);
        ground.minZ = Math.min(ground.minZ, min[2]);
        ground.maxZ = Math.max(ground.maxZ, max[2]);
      }
    },
    grids,
  );

  const toBody = (point: readonly number[]): Vec3 => ({
    x: (num(point, 0) - origin[0]) * VOXEL_UNIT,
    y: (num(point, 1) - origin[1]) * VOXEL_UNIT,
    z: (num(point, 2) - origin[2]) * VOXEL_UNIT,
  });
  const height = (hi[1] - lo[1]) * VOXEL_UNIT;
  const footprintRadius = Math.sqrt(farthest) * VOXEL_UNIT;

  const tailIndex = assembly.instances.findIndex(
    (instance) => roleOf(partOf(assembly, instance).type) === "tail",
  );
  let tail: Vec3;
  if (tailIndex === -1) {
    tail = { x: (lo[0] - origin[0]) * VOXEL_UNIT, y: height / 2, z: 0 };
  } else {
    const instance = item(assembly.instances, tailIndex);
    const part = partOf(assembly, instance);
    const { linear, offset } = item(placements, tailIndex);
    const at = apply(linear, units(part.attach, stepUnits(part.step)));
    tail = toBody([at[0] + offset[0], at[1] + offset[1], at[2] + offset[2]]);
  }

  return {
    origin,
    bounds: { min: toBody(lo), max: toBody(hi) },
    height,
    footprintRadius,
    sizeClass: sizeClassFor(height, footprintRadius),
    groundContact: {
      minX: (ground.minX - origin[0]) * VOXEL_UNIT,
      maxX: (ground.maxX - origin[0]) * VOXEL_UNIT,
      minZ: (ground.minZ - origin[2]) * VOXEL_UNIT,
      maxZ: (ground.maxZ - origin[2]) * VOXEL_UNIT,
    },
    centerOfGravity: toBody(moment.map((m) => m / volume)),
    tail,
  };
}

/** A part of a library to assemble from: its content ID and the part, as a part definition has. */
export interface LibraryPart {
  readonly id: string;
  readonly part: VoxelPart;
}

/** What `assembleParts` builds from. */
export interface AssembleOptions {
  /**
   * What to build on: a library part, the root of a new assembly, or a valid assembly (one that
   * `VoxelAssemblySchema` accepts), whose instances are all kept and whose free sockets are filled.
   */
  start: LibraryPart | VoxelAssembly;
  /** The parts to fill sockets with, in any order. Each ID once. */
  parts: readonly LibraryPart[];
  /** The registered part and socket types, for what fits where. */
  lookup: VoxelTypeLookup;
  /** The same seed and inputs give the same assembly. */
  seed: number;
}

/** A small seeded generator of numbers in [0, 1) (mulberry32): the same seed, the same numbers. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDENTITY_MATRIX: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A deep copy of a part, with `source` when given. */
const copyPart = (part: VoxelPart, source?: string): VoxelPart => ({
  ...part,
  ...(source === undefined ? {} : { source }),
  size: { ...part.size },
  colors: [...part.colors],
  voxels: [...part.voxels],
  attach: { ...part.attach },
  sockets: part.sockets.map((socket) => ({ ...socket, position: { ...socket.position } })),
});

const copyInstance = ({ parent, rotation, ...rest }: VoxelInstance): VoxelInstance => ({
  ...rest,
  ...(parent ? { parent: { ...parent } } : {}),
  rotation: [...rotation],
});

/** A local ID from a content ID's name: `hollow:legs/short` becomes `legs-short`. */
const localName = (id: string): string => parseContentId(id)?.name.replace(/[./]/g, "-") ?? "part";

/** `base`, or `base-2`, `base-3`… when that is taken; marks the one it returns taken. */
function claim(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** A part that may go on a socket: a library part, or one the assembly already holds. */
interface Option {
  part: VoxelPart;
  library?: LibraryPart;
  key?: string;
}

/** One socket of a pair (or a socket without a pair), and whether a part on it is mirrored. */
interface Side {
  socket: VoxelSocket;
  mirrored: boolean;
}

/**
 * Fills every free socket of an assembly with library parts that fit it (ADR 0022 §9, M20
 * decisions: a pure assembler), the same way for the same seed and inputs. M21's Randomize uses
 * it. Pure: it changes none of its inputs and shares no objects with them. The result passes
 * `VoxelAssemblySchema` and `checkAssemblyFit` (given a valid start).
 *
 * - Sockets are filled in the order of the instances, then of each part's sockets, so the root's
 *   first; each new part's own sockets after those of the parts listed before it, until no
 *   socket is free or the assembly holds `MAX_ASSEMBLY_INSTANCES` parts. Every free socket gets a
 *   part when one can go there: a socket has no way to say it may stay empty.
 * - A part can go on a socket when its type fits the socket's type and every part and socket type
 *   it has is registered (`checkAssemblyFit`), the socket lies deep enough in its parent (§12), it
 *   sits on the finer grid (§13) at the identity rest rotation, and the assembly stays within
 *   `MAX_ASSEMBLY_FACES`.
 * - Each socket type gets one seeded order of the library parts that fit it, and each socket of
 *   that type takes the first part in it that can go there, so a creature's hips all get the same
 *   leg where they can. A part that would make faces flush with another part's
 *   (`assemblyWarnings`) is passed over for the next one; when every part would, the first is
 *   used.
 * - Both sockets of a mirror pair get the same part, the one on the mirrored socket mirrored.
 *   When one is taken already, the other gets the part that's there first, if it fits.
 * - A library part used several times is held once, keyed by its ID's name (`legs-short` for
 *   `hollow:legs/short`), with its ID as `source`. A new instance is named after its socket, and
 *   below the root after its parent and its socket (`head-left-eye`).
 */
export function assembleParts({ start, parts, lookup, seed }: AssembleOptions): VoxelAssembly {
  const random = seededRandom(seed);
  const assembly: VoxelAssembly = { parts: {}, instances: [] };
  if ("instances" in start) {
    for (const [key, part] of Object.entries(start.parts)) assembly.parts[key] = copyPart(part);
    assembly.instances = start.instances.map(copyInstance);
  } else {
    const key = localName(start.id);
    assembly.parts[key] = copyPart(start.part, start.id);
    assembly.instances.push({
      id: key,
      part: key,
      rotation: [...IDENTITY_QUATERNION],
      mirrored: false,
    });
  }
  const keys = new Set(Object.keys(assembly.parts));
  const ids = new Set(assembly.instances.map((instance) => instance.id));

  const grids = new Map<VoxelPart, Uint8Array>();
  const gridOf = (part: VoxelPart) => {
    let grid = grids.get(part);
    if (!grid) grids.set(part, (grid = decodeVoxels(part.voxels, part.size)));
    return grid;
  };
  const faceCounts = new Map<VoxelPart, number>();
  const facesOf = (part: VoxelPart) => {
    let count = faceCounts.get(part);
    if (count === undefined) {
      faceCounts.set(part, (count = visibleFaces(gridOf(part), part.size)));
    }
    return count;
  };
  let faces = 0;
  for (const instance of assembly.instances) faces += facesOf(partOf(assembly, instance));

  // Who holds each taken socket: `instance/socket` to the instance hanging there.
  const holders = new Map<string, VoxelInstance>();
  for (const instance of assembly.instances) {
    const { parent } = instance;
    if (parent) holders.set(`${parent.instance}/${parent.socket}`, instance);
  }

  const fits = (part: VoxelPart, socketType: string) =>
    lookup.partType(part.type)?.fits.includes(socketType) ?? false;
  const library = [...parts]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((entry, i, sorted) => {
      if (sorted[i - 1]?.id === entry.id) throw new Error(`Part "${entry.id}" is listed twice`);
      return (
        lookup.partType(entry.part.type) !== undefined &&
        entry.part.sockets.every((socket) => lookup.socketType(socket.type) !== undefined)
      );
    });
  // The seeded order of the library parts that fit each socket type, made when first needed.
  const orders = new Map<string, LibraryPart[]>();
  const orderFor = (socketType: string) => {
    let order = orders.get(socketType);
    if (!order) {
      order = library.filter((entry) => fits(entry.part, socketType));
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [item(order, j), item(order, i)];
      }
      orders.set(socketType, order);
    }
    return order;
  };
  // The key of each library part the assembly holds.
  const libraryKeys = new Map<string, string>();

  for (let i = 0; i < assembly.instances.length; i++) {
    const parent = item(assembly.instances, i);
    const parentPart = partOf(assembly, parent);
    const slot = (side: Side) => `${parent.id}/${side.socket.id}`;
    for (const socket of parentPart.sockets) {
      // The mirrored socket of a pair is filled with its pair.
      if (socket.mirrors !== undefined) continue;
      const mirror = parentPart.sockets.find((s) => s.mirrors === socket.id);
      const pair: Side[] = [{ socket, mirrored: false }];
      if (mirror) pair.push({ socket: mirror, mirrored: true });
      const free = pair.filter((side) => !holders.has(slot(side)));
      if (free.length === 0) continue;
      if (assembly.instances.length + free.length > MAX_ASSEMBLY_INSTANCES) continue;

      const options: Option[] = [];
      // One side of the pair is taken already (only in an assembly to fill): its part first.
      const takenSide = pair.find((side) => holders.has(slot(side)));
      const held = takenSide && holders.get(slot(takenSide));
      if (held) {
        const part = partOf(assembly, held);
        if (fits(part, socket.type)) options.push({ part, key: held.part });
      }
      for (const entry of orderFor(socket.type)) options.push({ part: entry.part, library: entry });

      const placeable = options.filter(
        ({ part }) =>
          faces + facesOf(part) * free.length <= MAX_ASSEMBLY_FACES &&
          free.every(
            (side) =>
              isSocketBuried(parentPart, gridOf(parentPart), side.socket, part) &&
              isOnFinerGrid(parentPart, side.socket, part, IDENTITY_MATRIX, side.mirrored),
          ),
      );
      if (placeable.length === 0) continue;

      const keyFor = (option: Option): string => {
        if (option.key !== undefined) return option.key;
        const id = option.library?.id ?? "";
        return libraryKeys.get(id) ?? claim(localName(id), new Set(keys));
      };
      const instancesFor = (option: Option) => {
        const taken = new Set(ids);
        const part = keyFor(option);
        return free.map((side) => ({
          id: claim(i === 0 ? side.socket.id : `${parent.id}-${side.socket.id}`, taken),
          part,
          parent: { instance: parent.id, socket: side.socket.id },
          rotation: [...IDENTITY_QUATERNION] as Quaternion,
          mirrored: side.mirrored,
        }));
      };
      const first = assembly.instances.length;
      const clean = placeable.find((option) => {
        const trial: VoxelAssembly = {
          parts: { ...assembly.parts, [keyFor(option)]: option.part },
          instances: [...assembly.instances, ...instancesFor(option)],
        };
        // A warning names the later of its two parts.
        return !assemblyWarnings(trial).some((found) => Number(found.path[1]) >= first);
      });
      const chosen = clean ?? item(placeable, 0);

      const key = keyFor(chosen);
      if (chosen.library && !libraryKeys.has(chosen.library.id)) {
        keys.add(key);
        libraryKeys.set(chosen.library.id, key);
        const copy = copyPart(chosen.part, chosen.library.id);
        assembly.parts[key] = copy;
        grids.set(copy, gridOf(chosen.part));
        faceCounts.set(copy, facesOf(chosen.part));
      }
      for (const instance of instancesFor(chosen)) {
        ids.add(instance.id);
        holders.set(`${parent.id}/${instance.parent.socket}`, instance);
        assembly.instances.push(instance);
        faces += facesOf(chosen.part);
      }
    }
  }
  return assembly;
}
