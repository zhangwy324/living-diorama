import { describe, expect, it } from "vitest";
import {
  MAX_PART_CUBES,
  NORMAL_UNIT,
  VOXEL_AO,
  VOXEL_AO_BYTES,
  meshVoxelPart,
  meshVoxelParts,
  type VoxelMesh,
  type VoxelPartGrid,
} from "./mesher";

type Vec = [number, number, number];

/** A part of the given size with `cubes` set, each `[x, y, z]` or `[x, y, z, colour index]`. */
function part(
  size: Vec,
  cubes: readonly (Vec | [number, number, number, number])[],
  colors: readonly string[] = ["#7fae5a"],
): VoxelPartGrid {
  const [X, Y] = size;
  const voxels = new Uint8Array(size[0] * size[1] * size[2]);
  for (const [x, y, z, c = 1] of cubes) voxels[x + X * (y + Y * z)] = c;
  return { size, voxels, colors };
}

const solid = (size: Vec): VoxelPartGrid => ({
  size,
  voxels: new Uint8Array(size[0] * size[1] * size[2]).fill(1),
  colors: ["#ffffff"],
});

const position = (m: VoxelMesh, v: number): Vec => [
  m.positions[v * 3]!,
  m.positions[v * 3 + 1]!,
  m.positions[v * 3 + 2]!,
];
const normal = (m: VoxelMesh, v: number): Vec => [
  m.normals[v * 3]! / NORMAL_UNIT,
  m.normals[v * 3 + 1]! / NORMAL_UNIT,
  m.normals[v * 3 + 2]! / NORMAL_UNIT,
];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Each quad: its 4 vertex numbers and its 6 indices. Quads are written in order, 4 vertices each. */
function quads(m: VoxelMesh) {
  return Array.from({ length: m.vertexCount / 4 }, (_, q) => ({
    vertices: [0, 1, 2, 3].map((k) => q * 4 + k),
    indices: [...m.indices.subarray(q * 6, q * 6 + 6)],
  }));
}

/** The quad whose 4 corners are `corners` (in any order). */
function quadAt(m: VoxelMesh, normalOf: Vec, corners: readonly Vec[]) {
  const key = (p: Vec) => p.join(",");
  const want = new Set(corners.map(key));
  const found = quads(m).filter(
    ({ vertices }) =>
      normal(m, vertices[0]!).join(",") === normalOf.join(",") &&
      vertices.every((v) => want.has(key(position(m, v)))),
  );
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** Every triangle is counter-clockwise seen from where its normal points, and not degenerate. */
function expectOutwardWinding(m: VoxelMesh) {
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
    const n = cross(sub(position(m, b), position(m, a)), sub(position(m, c), position(m, a)));
    expect(dot(n, normal(m, a))).toBeGreaterThan(0);
  }
}

/** How many of a quad's two triangles use vertex `v`. */
const trianglesUsing = (indices: readonly number[], v: number) =>
  [indices.slice(0, 3), indices.slice(3)].filter((t) => t.includes(v)).length;

describe("meshVoxelPart", () => {
  it("meshes a single cube as 6 open quads with outward normals", () => {
    const m = meshVoxelPart(part([1, 1, 1], [[0, 0, 0]]));
    expect(m.vertexCount).toBe(24);
    expect(m.indices).toBeInstanceOf(Uint16Array);
    expect(m.indices).toHaveLength(36);
    expect(new Set(m.ao)).toEqual(new Set([VOXEL_AO_BYTES[3]]));
    expect(VOXEL_AO_BYTES[3]).toBe(255);
    for (let v = 0; v < m.vertexCount; v++) {
      for (const c of position(m, v)) expect([0, 1]).toContain(c);
      // The vertex lies on the face its normal points out of.
      const n = normal(m, v);
      const axis = n.findIndex((c) => c !== 0);
      expect(position(m, v)[axis]).toBe(n[axis]! > 0 ? 1 : 0);
    }
    const normals = quads(m).map((q) => normal(m, q.vertices[0]!).join(","));
    expect(new Set(normals).size).toBe(6);
    expectOutwardWinding(m);
  });

  it("culls the faces two cubes share", () => {
    const m = meshVoxelPart(
      part(
        [2, 1, 1],
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
      ),
    );
    expect(m.vertexCount).toBe(10 * 4);
    // No x-facing face on the plane between them.
    for (const { vertices } of quads(m)) {
      const xFacing = normal(m, vertices[0]!)[0] !== 0;
      if (xFacing) expect(position(m, vertices[0]!)[0]).not.toBe(1);
    }
    // Their side faces stay open: neighbours along a face don't occlude it.
    expect(new Set(m.ao)).toEqual(new Set([255]));
    expectOutwardWinding(m);
  });

  it("darkens corners in four levels: open, one neighbour, two, and both sides", () => {
    const ao = (cubes: Vec[], at: Vec) => {
      const m = meshVoxelPart(part([2, 2, 2], [[0, 0, 0], ...cubes]));
      const top = quadAt(
        m,
        [0, 1, 0],
        [
          [0, 1, 0],
          [1, 1, 0],
          [1, 1, 1],
          [0, 1, 1],
        ],
      );
      const v = top.vertices.find((v) => position(m, v).join(",") === at.join(","))!;
      return m.ao[v];
    };
    // The top face of the cube at the origin, at its corner (1, 1, 1).
    expect(ao([], [1, 1, 1])).toBe(Math.round(VOXEL_AO[3] * 255));
    expect(ao([[1, 1, 1]], [1, 1, 1])).toBe(Math.round(VOXEL_AO[2] * 255)); // diagonal cube only
    expect(ao([[1, 1, 0]], [1, 1, 1])).toBe(Math.round(VOXEL_AO[2] * 255)); // one side
    expect(
      ao(
        [
          [1, 1, 0],
          [1, 1, 1],
        ],
        [1, 1, 1],
      ),
    ).toBe(Math.round(VOXEL_AO[1] * 255)); // a side and the corner
    expect(
      ao(
        [
          [1, 1, 0],
          [0, 1, 1],
        ],
        [1, 1, 1],
      ),
    ).toBe(Math.round(VOXEL_AO[0] * 255)); // both sides, with or without the corner
    expect(
      ao(
        [
          [1, 1, 0],
          [0, 1, 1],
          [1, 1, 1],
        ],
        [1, 1, 1],
      ),
    ).toBe(Math.round(VOXEL_AO[0] * 255));
    expect(VOXEL_AO).toEqual([0.5, 0.65, 0.8, 1]);
  });

  it("splits a quad along the diagonal whose corners are most alike", () => {
    // The origin cube's top face has a dark corner at (1, 1, 1) (both sides occupied), lighter
    // ones at (1, 1, 0) and (0, 1, 1), and an open one at (0, 1, 0).
    const m = meshVoxelPart(
      part(
        [2, 2, 2],
        [
          [0, 0, 0],
          [1, 1, 0],
          [0, 1, 1],
        ],
      ),
    );
    const top = quadAt(
      m,
      [0, 1, 0],
      [
        [0, 1, 0],
        [1, 1, 0],
        [1, 1, 1],
        [0, 1, 1],
      ],
    );
    const at = (p: Vec) => top.vertices.find((v) => position(m, v).join(",") === p.join(","))!;
    expect(m.ao[at([1, 1, 1])]).toBe(VOXEL_AO_BYTES[0]);
    expect(m.ao[at([0, 1, 0])]).toBe(VOXEL_AO_BYTES[3]);
    // The diagonal joins the two alike corners, so the darkest and lightest each sit in one
    // triangle and the shading doesn't streak across the face.
    expect(trianglesUsing(top.indices, at([1, 1, 0]))).toBe(2);
    expect(trianglesUsing(top.indices, at([0, 1, 1]))).toBe(2);
    expect(trianglesUsing(top.indices, at([1, 1, 1]))).toBe(1);
    expect(trianglesUsing(top.indices, at([0, 1, 0]))).toBe(1);
    expectOutwardWinding(m);
  });

  it("splits between two dark opposite corners, joining the light ones", () => {
    // Cubes diagonally above two opposite corners of the centre cube's top face.
    const m = meshVoxelPart(
      part(
        [3, 2, 3],
        [
          [1, 0, 1],
          [0, 1, 0],
          [2, 1, 2],
        ],
      ),
    );
    const top = quadAt(
      m,
      [0, 1, 0],
      [
        [1, 1, 1],
        [2, 1, 1],
        [2, 1, 2],
        [1, 1, 2],
      ],
    );
    const at = (p: Vec) => top.vertices.find((v) => position(m, v).join(",") === p.join(","))!;
    expect(m.ao[at([1, 1, 1])]).toBe(VOXEL_AO_BYTES[2]);
    expect(m.ao[at([2, 1, 2])]).toBe(VOXEL_AO_BYTES[2]);
    expect(trianglesUsing(top.indices, at([1, 1, 1]))).toBe(1);
    expect(trianglesUsing(top.indices, at([2, 1, 2]))).toBe(1);
    expect(trianglesUsing(top.indices, at([2, 1, 1]))).toBe(2);
    expectOutwardWinding(m);
  });

  it("keeps the diagonal and outward faces on a mirrored part", () => {
    // The part of the diagonal test above, reflected: z → 2 − z.
    const m = meshVoxelPart({
      ...part(
        [2, 2, 2],
        [
          [0, 0, 0],
          [1, 1, 0],
          [0, 1, 1],
        ],
      ),
      mirrored: true,
    });
    const top = quadAt(
      m,
      [0, 1, 0],
      [
        [0, 1, 2],
        [1, 1, 2],
        [1, 1, 1],
        [0, 1, 1],
      ],
    );
    const at = (p: Vec) => top.vertices.find((v) => position(m, v).join(",") === p.join(","))!;
    expect(m.ao[at([1, 1, 1])]).toBe(VOXEL_AO_BYTES[0]);
    expect(m.ao[at([0, 1, 2])]).toBe(VOXEL_AO_BYTES[3]);
    // This quad takes the flipped diagonal: its first triangle starts at its second vertex.
    expect(top.indices[0]).toBe(top.vertices[1]);
    expect(trianglesUsing(top.indices, at([1, 1, 2]))).toBe(2);
    expect(trianglesUsing(top.indices, at([0, 1, 1]))).toBe(2);
    expect(trianglesUsing(top.indices, at([1, 1, 1]))).toBe(1);
    expect(trianglesUsing(top.indices, at([0, 1, 2]))).toBe(1);
    expectOutwardWinding(m);
  });

  it("meshes only the outside of a full 32³ part", () => {
    const n = MAX_PART_CUBES;
    const m = meshVoxelPart(solid([n, n, n]));
    expect(m.vertexCount).toBe(6 * n * n * 4);
    expect(m.indices).toBeInstanceOf(Uint16Array);
    for (let v = 0; v < m.vertexCount; v++) {
      expect(position(m, v).some((c) => c === 0 || c === n)).toBe(true);
    }
    expect(new Set(m.ao)).toEqual(new Set([255]));
    expectOutwardWinding(m);
  });

  it("meshes an empty part as nothing", () => {
    const m = meshVoxelPart(part([4, 4, 4], []));
    expect(m.vertexCount).toBe(0);
    expect(m.positions).toHaveLength(0);
    expect(m.indices).toHaveLength(0);
  });

  it("maps colour indices to the part's colours and tags vertices with the part index", () => {
    const m = meshVoxelPart(
      part(
        [2, 1, 1],
        [
          [0, 0, 0, 1],
          [1, 0, 0, 2],
        ],
        ["#ff8000", "#0a0B0c"],
      ),
      7,
    );
    for (let v = 0; v < m.vertexCount; v++) {
      const rgb = [...m.colors.subarray(v * 3, v * 3 + 3)];
      expect([
        [255, 128, 0],
        [10, 11, 12],
      ]).toContainEqual(rgb);
      expect(m.parts[v]).toBe(7);
    }
    for (const { vertices } of quads(m)) {
      const centreX = vertices.reduce((s, v) => s + position(m, v)[0], 0) / 4;
      const rgb = [...m.colors.subarray(vertices[0]! * 3, vertices[0]! * 3 + 3)];
      expect(rgb).toEqual(centreX < 1 ? [255, 128, 0] : [10, 11, 12]);
      for (const v of vertices) expect([...m.colors.subarray(v * 3, v * 3 + 3)]).toEqual(rgb);
    }
  });

  it("mirrors a part in z, keeping its faces outward", () => {
    const plain = part([1, 1, 3], [[0, 0, 0]]);
    const m = meshVoxelPart({ ...plain, mirrored: true });
    for (let v = 0; v < m.vertexCount; v++) expect(position(m, v)[2]).toBeGreaterThanOrEqual(2);
    quadAt(
      m,
      [0, 0, 1],
      [
        [0, 0, 3],
        [1, 0, 3],
        [1, 1, 3],
        [0, 1, 3],
      ],
    );
    quadAt(
      m,
      [0, 0, -1],
      [
        [0, 0, 2],
        [1, 0, 2],
        [1, 1, 2],
        [0, 1, 2],
      ],
    );
    expectOutwardWinding(m);
  });

  it("rejects sizes over the cap, mismatched voxel counts and unknown colours", () => {
    expect(() => meshVoxelPart(solid([33, 1, 1]))).toThrow(RangeError);
    expect(() => meshVoxelPart(solid([0, 1, 1]))).toThrow(RangeError);
    expect(() => meshVoxelPart({ size: [2, 2, 2], voxels: new Uint8Array(7), colors: [] })).toThrow(
      RangeError,
    );
    expect(() => meshVoxelPart(part([1, 1, 1], [[0, 0, 0, 2]]))).toThrow(RangeError);
    expect(() => meshVoxelPart(part([1, 1, 1], [[0, 0, 0]], ["red"]))).toThrow(RangeError);
    expect(() => meshVoxelPart(part([1, 1, 1], [[0, 0, 0]]), 256)).toThrow(RangeError);
    expect(() => meshVoxelPart(part([1, 1, 1], [[0, 0, 0]]), -1)).toThrow(RangeError);
    expect(() => meshVoxelPart(part([1, 1, 1], [[0, 0, 0]]), 1.5)).toThrow(RangeError);
  });
});

describe("meshVoxelParts", () => {
  it("concatenates parts into one mesh, each in its own cube units with its part index", () => {
    const a = part(
      [2, 1, 1],
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
    );
    const b = part([1, 1, 1], [[0, 0, 0]], ["#000000"]);
    const [ma, mb] = [meshVoxelPart(a), meshVoxelPart(b)];
    const m = meshVoxelParts([a, b]);
    expect(m.vertexCount).toBe(ma.vertexCount + mb.vertexCount);
    expect(m.indices).toHaveLength(ma.indices.length + mb.indices.length);
    expect([...m.parts.subarray(0, ma.vertexCount)].every((p) => p === 0)).toBe(true);
    expect([...m.parts.subarray(ma.vertexCount)].every((p) => p === 1)).toBe(true);
    // The second part's arrays are its own, with indices shifted past the first part's vertices.
    expect([...m.positions.subarray(ma.vertexCount * 3)]).toEqual([...mb.positions]);
    expect([...m.colors.subarray(ma.vertexCount * 3)]).toEqual([...mb.colors]);
    expect([...m.indices.subarray(ma.indices.length)]).toEqual(
      [...mb.indices].map((i) => i + ma.vertexCount),
    );
    expectOutwardWinding(m);
  });

  it("uses 16-bit indices up to 65536 vertices and 32-bit beyond", () => {
    // 2 × 6144 + 4096 faces = 16384 quads = 65536 vertices.
    const full = solid([32, 32, 32]);
    const parts = [full, full, solid([32, 32, 16])];
    const fits = meshVoxelParts(parts);
    expect(fits.vertexCount).toBe(65536);
    expect(fits.indices).toBeInstanceOf(Uint16Array);
    expect(Array.from(fits.indices).reduce((a, b) => Math.max(a, b))).toBe(65535);

    const over = meshVoxelParts([...parts, part([1, 1, 1], [[0, 0, 0]])]);
    expect(over.vertexCount).toBe(65536 + 24);
    expect(over.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(over.indices).reduce((a, b) => Math.max(a, b))).toBe(65536 + 23);
    expect(over.parts[over.vertexCount - 1]).toBe(3);
  });

  it("meshes a 32³ checkerboard, the most faces a part can have", () => {
    const n = MAX_PART_CUBES;
    const voxels = new Uint8Array(n * n * n);
    for (let i = 0; i < voxels.length; i++) {
      const [x, y, z] = [i % n, Math.floor(i / n) % n, Math.floor(i / (n * n))];
      voxels[i] = (x + y + z) % 2;
    }
    const m = meshVoxelPart({ size: [n, n, n], voxels, colors: ["#123456"] });
    expect(m.vertexCount).toBe(((n * n * n) / 2) * 6 * 4);
    expect(m.indices).toBeInstanceOf(Uint32Array);
  });
});
