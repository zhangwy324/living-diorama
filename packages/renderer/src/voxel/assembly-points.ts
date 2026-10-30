import {
  IDENTITY_QUATERNION,
  decodeVoxels,
  instanceInset,
  placeInstances,
  type InstancePlacement,
  type Quaternion,
  type VoxelAssembly,
  type VoxelPart,
} from "@living-diorama/content-schema";
import * as THREE from "three";
import { boneMatrix, partShape, voxelGeometry, type VoxelBody } from "./body";
import { meshVoxelParts } from "./mesher";

// Where the assembly view's sockets and ghost parts go (ADR 0023 §4): points and transforms in a
// voxel body's frame (metres, feet at y = 0, facing +X), worked out from the assembly as
// `buildVoxelBody` places its parts. Pure apart from the three.js objects returned.

/** A socket of an instance: the socket's ID on that instance's part, as `VoxelInstance.parent`. */
export interface SocketRef {
  instance: string;
  socket: string;
}

/** A socket placed in the body frame. */
export interface SocketPoint extends SocketRef {
  /** The socket's position, in metres in the body frame. */
  position: THREE.Vector3;
  /** Its socket type, e.g. `hollow:hip`. */
  type: string;
  /** Whether a part hung from it is mirrored: it is the mirrored socket of a pair (ADR 0022 §16). */
  mirrors: boolean;
}

/** The map key of a socket of an instance. */
export const socketKey = ({ instance, socket }: SocketRef): string => `${instance}/${socket}`;

const local = new THREE.Vector3();
const shape = new THREE.Matrix4();

/**
 * Every socket of every instance of a valid assembly, placed where a child part's attach point
 * would be: on the part as drawn (reflected when the part is), ignoring the shrink that keeps
 * child parts' faces apart, as `placeInstances` does. `body` is the assembly's, from
 * `buildVoxelBody`. In the order of the instances, then of each part's sockets.
 */
export function socketPoints(assembly: VoxelAssembly, body: VoxelBody): SocketPoint[] {
  const placements = placeInstances(assembly);
  const points: SocketPoint[] = [];
  assembly.instances.forEach((instance, i) => {
    const part = assembly.parts[instance.part];
    const placement = placements[i];
    const joint = body.joints[i];
    if (!part || !placement || !joint) return;
    const toBody = joint.clone().multiply(partShape(part, placement, 0, shape));
    for (const socket of part.sockets) {
      const { x, y, z } = socket.position;
      // The mesher reflects a mirrored part's cubes about its middle plane: z → Z − z.
      local.set(x, y, placement.mirrored ? part.size.z - z : z);
      points.push({
        instance: instance.id,
        socket: socket.id,
        position: local.clone().applyMatrix4(toBody),
        type: socket.type,
        mirrors: socket.mirrors !== undefined,
      });
    }
  });
  return points;
}

/** IDs not taken by `assembly`, for a part placed beside it. */
function freeId(taken: (id: string) => boolean): string {
  let id = "ghost";
  for (let n = 1; taken(id); n++) id = `ghost-${n}`;
  return id;
}

/** A part placed at a socket of an assembly, as it would be if attached there. */
export interface GhostPlacement {
  placement: InstancePlacement;
  /** Its bone's rest transform, from the part's cube units to the body frame in metres. */
  matrix: THREE.Matrix4;
}

/**
 * Where `part` would go hung from `at` in `assembly` (valid), turned by `rotation` (stored as on
 * an instance: the unmirrored rotation), in the frame of `body`, the assembly's body. A part on
 * the mirrored socket of a pair is mirrored, as the Studio would place it. The assembly's body
 * frame is kept, though a part added there could move it (`AssemblyMeasure.origin`): the ghost
 * shows the part against the body as it is. Undefined for a socket the assembly doesn't have.
 */
export function ghostPlacement(
  assembly: VoxelAssembly,
  body: VoxelBody,
  part: VoxelPart,
  at: SocketRef,
  rotation: Quaternion = IDENTITY_QUATERNION,
): GhostPlacement | undefined {
  const parent = assembly.instances.find((instance) => instance.id === at.instance);
  const socket = parent && assembly.parts[parent.part]?.sockets.find((s) => s.id === at.socket);
  if (!socket) return undefined;
  const key = freeId((id) => id in assembly.parts);
  const id = freeId((id) => assembly.instances.some((instance) => instance.id === id));
  const placements = placeInstances({
    parts: { ...assembly.parts, [key]: part },
    instances: [
      ...assembly.instances,
      { id, part: key, parent: at, rotation, mirrored: socket.mirrors !== undefined },
    ],
  });
  const placement = placements.at(-1);
  if (!placement) return undefined;
  return {
    placement,
    matrix: boneMatrix(part, placement, body.measure.origin, instanceInset(placement.depth)),
  };
}

/** The geometry of `part` alone, reflected or not, in its cube units, for a ghost mesh. */
export function partGeometry(part: VoxelPart, mirrored: boolean): THREE.BufferGeometry {
  return voxelGeometry(
    meshVoxelParts([
      {
        size: [part.size.x, part.size.y, part.size.z],
        voxels: decodeVoxels(part.voxels, part.size),
        colors: part.colors,
        mirrored,
      },
    ]),
  );
}
