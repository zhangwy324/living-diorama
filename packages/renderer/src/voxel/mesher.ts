/**
 * The voxel mesher (ADR 0022 §7, §18, §19): a pure function from a creature's parts, as typed
 * arrays, to the vertex and index arrays of one geometry. No three.js and no DOM, so it is tested
 * in Vitest and can move to a worker unchanged.
 *
 * Each cube face that doesn't touch another cube of the same part becomes one quad (4 vertices,
 * 6 indices). Parts are meshed separately: faces are culled and ambient occlusion is computed
 * within a part only, so parts don't darken each other at a joint (§18). There is no greedy
 * meshing (§19); the vertex layout is small instead.
 *
 * Positions stay in each part's own cube units. The part's bind transform (offset, cube step,
 * rest rotation) and the slight shrink of child parts that keeps flush faces of overlapping parts
 * apart belong to the renderer's skeleton, not here.
 */

/** A part is at most this many cubes along each axis (ADR 0022 §15). */
export const MAX_PART_CUBES = 32;

/** The most parts one mesh can hold: the part index is a `Uint8`. */
export const MAX_MESH_PARTS = 256;

/**
 * Ambient occlusion by level, from 0 (both side neighbours of a corner, the most occluded) to 3
 * (no neighbours). The values are starting points (issue #200).
 */
export const VOXEL_AO = [0.5, 0.65, 0.8, 1] as const;

/** {@link VOXEL_AO} as the bytes of the `ao` attribute (normalized `Uint8`). */
export const VOXEL_AO_BYTES: readonly number[] = VOXEL_AO.map((v) => Math.round(v * 255));

/** The value of a unit normal component in the `normals` array (normalized `Int8`). */
export const NORMAL_UNIT = 127;

/** One part's cubes, as the mesher takes them. */
export interface VoxelPartGrid {
  /** Cubes along x, y and z, each 1 to {@link MAX_PART_CUBES}. */
  readonly size: readonly [x: number, y: number, z: number];
  /**
   * A colour index per cube, x fastest, then y, then z: cube (x, y, z) is at x + X·(y + Y·z).
   * 0 is empty; i ≥ 1 is `colors[i − 1]`.
   */
  readonly voxels: Uint8Array;
  /** The part's sRGB colours, like `"#7fae5a"`. */
  readonly colors: readonly string[];
  /**
   * Reflects the part in its own z (z → Z − z), for the part on the mirrored socket of a pair
   * (ADR 0022 §16). Faces stay outward-facing; a negative-scale bone matrix would turn them inside
   * out instead.
   */
  readonly mirrored?: boolean;
}

/**
 * Vertex and index arrays of one or more meshed parts, one array per attribute (not interleaved).
 * Vertex v's attributes are at `[3v, 3v + 3)` of the 3-component arrays and at `[v]` of the others.
 */
export interface VoxelMesh {
  readonly vertexCount: number;
  /** x, y, z per vertex: a cube corner in its part's cube units, 0 to {@link MAX_PART_CUBES}. */
  readonly positions: Uint8Array;
  /** x, y, z per vertex: the face's unit normal, ±{@link NORMAL_UNIT} on one axis (normalized). */
  readonly normals: Int8Array;
  /** r, g, b per vertex: the cube's sRGB colour, 0 to 255 (normalized; still sRGB, not linear). */
  readonly colors: Uint8Array;
  /** Ambient occlusion per vertex, one of {@link VOXEL_AO_BYTES} (normalized). */
  readonly ao: Uint8Array;
  /** The vertex's part index: its part's position in the list given to {@link meshVoxelParts}. */
  readonly parts: Uint8Array;
  /** Triangles, counter-clockwise seen from outside; `Uint16Array` when every index fits. */
  readonly indices: Uint16Array | Uint32Array;
}

/** Meshes one part, tagging its vertices with `partIndex`. */
export function meshVoxelPart(part: VoxelPartGrid, partIndex = 0): VoxelMesh {
  return mesh([part], partIndex);
}

/**
 * Meshes a creature's parts into one set of arrays (one draw call, ADR 0022 §18). Each part's
 * vertices carry its position in `parts` as their part index.
 */
export function meshVoxelParts(parts: readonly VoxelPartGrid[]): VoxelMesh {
  if (parts.length > MAX_MESH_PARTS) {
    throw new RangeError(`At most ${MAX_MESH_PARTS} parts per mesh, got ${parts.length}`);
  }
  return mesh(parts, 0);
}

/**
 * The six faces. For each, `u` and `v` are the axes along the face with u × v pointing out, so
 * corners (0,0), (1,0), (1,1), (0,1) in (u, v) run counter-clockwise seen from outside.
 */
const FACES = [
  { axis: 0, sign: 1, u: 1, v: 2 },
  { axis: 0, sign: -1, u: 2, v: 1 },
  { axis: 1, sign: 1, u: 2, v: 0 },
  { axis: 1, sign: -1, u: 0, v: 2 },
  { axis: 2, sign: 1, u: 0, v: 1 },
  { axis: 2, sign: -1, u: 1, v: 0 },
] as const;
const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

/** Per face: the neighbour offset, then per corner the offsets of side 1, side 2 and the corner. */
const OFFSETS_PER_FACE = 13;

/** A part in a one-cube border of empty cells, so neighbour lookups need no bounds checks. */
interface PaddedPart {
  readonly part: VoxelPartGrid;
  readonly grid: Uint8Array;
  readonly strides: readonly [number, number, number];
  readonly faces: number;
}

function mesh(parts: readonly VoxelPartGrid[], firstIndex: number): VoxelMesh {
  const padded = parts.map(pad);
  const faces = padded.reduce((sum, p) => sum + p.faces, 0);
  const vertexCount = faces * 4;
  const out = {
    vertexCount,
    positions: new Uint8Array(vertexCount * 3),
    normals: new Int8Array(vertexCount * 3),
    colors: new Uint8Array(vertexCount * 3),
    ao: new Uint8Array(vertexCount),
    parts: new Uint8Array(vertexCount),
    indices: vertexCount <= 0x10000 ? new Uint16Array(faces * 6) : new Uint32Array(faces * 6),
  };
  let vertex = 0;
  padded.forEach((p, i) => {
    vertex = emit(p, firstIndex + i, out, vertex);
  });
  return out;
}

function pad(part: VoxelPartGrid): PaddedPart {
  const [X, Y, Z] = part.size;
  for (const n of part.size) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PART_CUBES) {
      throw new RangeError(`Part size must be 1 to ${MAX_PART_CUBES} cubes per axis, got ${n}`);
    }
  }
  if (part.voxels.length !== X * Y * Z) {
    throw new RangeError(
      `Expected ${X * Y * Z} voxels for ${X}×${Y}×${Z}, got ${part.voxels.length}`,
    );
  }
  const sy = X + 2;
  const sz = sy * (Y + 2);
  const grid = new Uint8Array(sz * (Z + 2));
  let maxColor = 0;
  let i = 0;
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      let p = 1 + sy * (y + 1) + sz * (z + 1);
      for (let x = 0; x < X; x++, i++, p++) {
        const c = part.voxels[i] ?? 0;
        grid[p] = c;
        if (c > maxColor) maxColor = c;
      }
    }
  }
  if (maxColor > part.colors.length) {
    throw new RangeError(`Colour index ${maxColor} but the part has ${part.colors.length} colours`);
  }
  const strides = [1, sy, sz] as const;
  const neighbours = FACES.map((f) => f.sign * strides[f.axis]);
  let faces = 0;
  forEachCube(part.size, strides, (p) => {
    if (grid[p] === 0) return;
    for (const n of neighbours) if (grid[p + n] === 0) faces++;
  });
  return { part, grid, strides, faces };
}

/**
 * Calls `visit(p, x, y, z)` for every cube cell of the part, `p` its index in the padded grid.
 * Visits empty cells too; callers skip them.
 */
function forEachCube(
  size: readonly [number, number, number],
  [, sy, sz]: readonly [number, number, number],
  visit: (p: number, x: number, y: number, z: number) => void,
): void {
  const [X, Y, Z] = size;
  for (let z = 0; z < Z; z++) {
    for (let y = 0; y < Y; y++) {
      let p = 1 + sy * (y + 1) + sz * (z + 1);
      for (let x = 0; x < X; x++, p++) visit(p, x, y, z);
    }
  }
}

function parseColors(colors: readonly string[]): Uint8Array {
  // Index 0 (empty) stays black; colour i ≥ 1 is at 3i.
  const rgb = new Uint8Array((colors.length + 1) * 3);
  colors.forEach((hex, i) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new RangeError(`Not a colour like "#7fae5a": ${hex}`);
    const n = parseInt(hex.slice(1), 16);
    rgb.set([n >> 16, (n >> 8) & 0xff, n & 0xff], (i + 1) * 3);
  });
  return rgb;
}

function emit(
  { part, grid, strides }: PaddedPart,
  partIndex: number,
  out: {
    positions: Uint8Array;
    normals: Int8Array;
    colors: Uint8Array;
    ao: Uint8Array;
    parts: Uint8Array;
    indices: Uint16Array | Uint32Array;
  },
  firstVertex: number,
): number {
  const { positions, normals, colors, ao, parts, indices } = out;
  const palette = parseColors(part.colors);
  const Z = part.size[2];
  const mirrored = part.mirrored === true;

  // Offsets into the padded grid and corner positions, per face and corner.
  const offsets = new Int32Array(FACES.length * OFFSETS_PER_FACE);
  const cornerXyz = new Uint8Array(FACES.length * 12);
  const faceNormals = new Int8Array(FACES.length * 3);
  FACES.forEach(({ axis, sign, u, v }, f) => {
    const n = sign * strides[axis];
    offsets[f * OFFSETS_PER_FACE] = n;
    faceNormals[f * 3 + axis] = sign * NORMAL_UNIT;
    if (mirrored) faceNormals[f * 3 + 2] = -(faceNormals[f * 3 + 2] ?? 0);
    CORNERS.forEach(([du, dv], k) => {
      const side1 = n + (du ? 1 : -1) * strides[u];
      const side2 = n + (dv ? 1 : -1) * strides[v];
      const o = f * OFFSETS_PER_FACE + 1 + k * 3;
      offsets[o] = side1;
      offsets[o + 1] = side2;
      offsets[o + 2] = side1 + side2 - n;
      const c = f * 12 + k * 3;
      cornerXyz[c + axis] = sign > 0 ? 1 : 0;
      cornerXyz[c + u] = du;
      cornerXyz[c + v] = dv;
    });
  });

  let vertex = firstVertex;
  let index = firstVertex * 1.5; // 6 indices per 4 vertices
  const levels = [0, 0, 0, 0];
  forEachCube(part.size, strides, (p, x, y, z) => {
    const color = grid[p] ?? 0;
    if (color === 0) return;
    for (let f = 0; f < FACES.length; f++) {
      const o = f * OFFSETS_PER_FACE;
      if (grid[p + (offsets[o] ?? 0)] !== 0) continue;
      for (let k = 0; k < 4; k++) {
        const ok = o + 1 + k * 3;
        const side1 = grid[p + (offsets[ok] ?? 0)] !== 0 ? 1 : 0;
        const side2 = grid[p + (offsets[ok + 1] ?? 0)] !== 0 ? 1 : 0;
        const corner = grid[p + (offsets[ok + 2] ?? 0)] !== 0 ? 1 : 0;
        const level = side1 && side2 ? 0 : 3 - side1 - side2 - corner;
        levels[k] = level;

        const v = vertex + k;
        const c = f * 12 + k * 3;
        const cz = z + (cornerXyz[c + 2] ?? 0);
        positions[v * 3] = x + (cornerXyz[c] ?? 0);
        positions[v * 3 + 1] = y + (cornerXyz[c + 1] ?? 0);
        positions[v * 3 + 2] = mirrored ? Z - cz : cz;
        normals[v * 3] = faceNormals[f * 3] ?? 0;
        normals[v * 3 + 1] = faceNormals[f * 3 + 1] ?? 0;
        normals[v * 3 + 2] = faceNormals[f * 3 + 2] ?? 0;
        colors[v * 3] = palette[color * 3] ?? 0;
        colors[v * 3 + 1] = palette[color * 3 + 1] ?? 0;
        colors[v * 3 + 2] = palette[color * 3 + 2] ?? 0;
        ao[v] = VOXEL_AO_BYTES[level] ?? 0;
        parts[v] = partIndex;
      }
      // Split along the diagonal whose ends are most alike, so occlusion spreads the same way
      // whichever way the quad is turned. On a tie, join the lighter pair, so two dark corners
      // stay two corner shadows rather than one band.
      const [a0, a1, a2, a3] = levels as [number, number, number, number];
      const d02 = Math.abs(a0 - a2);
      const d13 = Math.abs(a1 - a3);
      const flip = d13 < d02 || (d13 === d02 && a1 + a3 > a0 + a2);
      // Triangles (0,1,2)(0,2,3) or (1,2,3)(1,3,0); mirroring reverses their winding.
      const s = flip ? 1 : 0;
      const q0 = vertex + s;
      const q1 = vertex + ((s + 1) & 3);
      const q2 = vertex + ((s + 2) & 3);
      const q3 = vertex + ((s + 3) & 3);
      indices[index] = q0;
      indices[index + 1] = mirrored ? q2 : q1;
      indices[index + 2] = mirrored ? q1 : q2;
      indices[index + 3] = q0;
      indices[index + 4] = mirrored ? q3 : q2;
      indices[index + 5] = mirrored ? q2 : q3;
      index += 6;
      vertex += 4;
    }
  });
  return vertex;
}
