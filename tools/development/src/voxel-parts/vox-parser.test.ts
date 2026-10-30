import { voxelIndex, type Diagnostic } from "@living-diorama/content-schema";
import { describe, expect, it } from "vitest";
import { parseVox, type VoxCubes } from "./vox-parser";
import { writeVox } from "./vox-writer";

// `.vox` files built byte by byte here, apart from the writer, so a mistake shared by the parser
// and the writer still fails.

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const i32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const str = (text: string) => [...i32(text.length), ...ascii(text)];
const dict = (entries: Record<string, string> = {}) => [
  ...i32(Object.keys(entries).length),
  ...Object.entries(entries).flatMap(([key, value]) => [...str(key), ...str(value)]),
];
const chunk = (id: string, content: number[], children: number[] = []) => [
  ...ascii(id),
  ...i32(content.length),
  ...i32(children.length),
  ...content,
  ...children,
];
const vox = (children: number[][], version = 200) =>
  new Uint8Array([...ascii("VOX "), ...i32(version), ...chunk("MAIN", [], children.flat())]);

const size = (x: number, y: number, z: number) => chunk("SIZE", [...i32(x), ...i32(y), ...i32(z)]);
type Voxel = [x: number, y: number, z: number, index: number];
const xyzi = (voxels: Voxel[]) => chunk("XYZI", [...i32(voxels.length), ...voxels.flat()]);
/** A palette with `colors[index] = [r, g, b]`, the rest grey. */
function rgba(colors: Record<number, [number, number, number]>) {
  const bytes: number[] = [];
  for (let index = 1; index <= 256; index++) bytes.push(...(colors[index] ?? [128, 128, 128]), 255);
  return chunk("RGBA", bytes);
}
const transform = (node: number, child: number, frame: Record<string, string> = {}) =>
  chunk("nTRN", [
    ...i32(node),
    ...dict(),
    ...i32(child),
    ...i32(-1),
    ...i32(0),
    ...i32(1),
    ...dict(frame),
  ]);
const group = (node: number, children: number[]) =>
  chunk("nGRP", [...i32(node), ...dict(), ...i32(children.length), ...children.flatMap(i32)]);
const shape = (node: number, models: number[]) =>
  chunk("nSHP", [
    ...i32(node),
    ...dict(),
    ...i32(models.length),
    ...models.flatMap((m) => [...i32(m), ...dict()]),
  ]);
/** A version 200 scene graph of one model: root transform, group, the model's transform, shape. */
const scene = (frame: Record<string, string> = {}) => [
  transform(0, 1),
  group(1, [2]),
  transform(2, 3, frame),
  shape(3, [0]),
];

const ok = (result: ReturnType<typeof parseVox>): VoxCubes => {
  if (!result.ok) throw new Error(result.diagnostics.map((d) => d.message).join("; "));
  return result.value;
};
const codes = (result: ReturnType<typeof parseVox>): string[] =>
  result.ok ? [] : result.diagnostics.map((d: Diagnostic) => d.code);
const cube = (cubes: VoxCubes, x: number, y: number, z: number) =>
  cubes.grid[voxelIndex(cubes.size, x, y, z)];

const RED: [number, number, number] = [200, 40, 30];
const GREEN: [number, number, number] = [40, 180, 60];
const BLUE: [number, number, number] = [30, 60, 220];

describe("parseVox", () => {
  // An asymmetric model, 2 × 3 × 4 in vox axes, one cube of a different colour at each of three
  // corners, so every axis's direction shows.
  const asymmetric = [
    size(2, 3, 4),
    xyzi([
      [1, 0, 0, 10], // +x
      [0, 2, 3, 20], // +y, top
      [0, 1, 0, 30],
    ]),
    rgba({ 10: RED, 20: GREEN, 30: BLUE }),
  ];

  it("maps vox axes to the part's: X = x, Y = z, Z = size.y − 1 − y (E4)", () => {
    const cubes = ok(parseVox(vox([...asymmetric, ...scene()])));
    expect(cubes.size).toEqual({ x: 2, y: 4, z: 3 });
    expect(cube(cubes, 1, 0, 2)).toBe(1); // vox (1, 0, 0)
    expect(cube(cubes, 0, 3, 0)).toBe(2); // vox (0, 2, 3)
    expect(cube(cubes, 0, 0, 1)).toBe(3); // vox (0, 1, 0)
    expect(cubes.grid.filter((i) => i !== 0)).toHaveLength(3);
  });

  it("reads version 150 files without a scene graph", () => {
    const cubes = ok(parseVox(vox(asymmetric, 150)));
    expect(cubes.size).toEqual({ x: 2, y: 4, z: 3 });
    expect(cube(cubes, 0, 3, 0)).toBe(2);
  });

  it("compacts the palette to the colours used, in palette order, merging duplicates (E5)", () => {
    const cubes = ok(
      parseVox(
        vox([
          size(4, 1, 1),
          xyzi([
            [0, 0, 0, 200],
            [1, 0, 0, 7],
            [2, 0, 0, 90],
            [3, 0, 0, 0], // index 0 is empty
          ]),
          rgba({ 7: RED, 90: GREEN, 200: RED }),
        ]),
      ),
    );
    expect(cubes.colors).toEqual(["#c8281e", "#28b43c"]);
    expect([...cubes.grid]).toEqual([1, 1, 2, 0]);
  });

  it("ignores materials, layers and a model's translation", () => {
    const cubes = ok(
      parseVox(
        vox([
          ...asymmetric,
          ...scene({ _r: "4", _t: "-3 7 12" }),
          chunk("MATL", [...i32(10), ...dict({ _type: "_glass", _alpha: "0.5" })]),
          chunk("LAYR", [...i32(0), ...dict({ _name: "body" }), ...i32(-1)]),
        ]),
      ),
    );
    expect(cube(cubes, 1, 0, 2)).toBe(1);
  });

  it("refuses what isn't one unrotated model of a part's size", () => {
    const one = [size(1, 1, 1), xyzi([[0, 0, 0, 1]])];
    const palette = rgba({ 1: RED });
    const cases: [string, Uint8Array][] = [
      ["vox_not_vox", new Uint8Array([...ascii("VOXX"), ...i32(150)])],
      ["vox_not_vox", new Uint8Array([1, 2, 3])],
      ["vox_unsupported_version", vox([...one, palette], 151)],
      ["vox_malformed", new Uint8Array([...ascii("VOX "), ...i32(150), ...chunk("PACK", i32(1))])],
      ["vox_truncated", vox([...one, palette]).slice(0, 40)],
      ["vox_no_model", vox([palette])],
      ["vox_malformed", vox([size(1, 1, 1), palette])],
      ["vox_many_models", vox([...one, ...one, palette])],
      ["vox_many_models", vox([...one, palette, transform(0, 1), shape(1, [0, 0])])],
      [
        "vox_many_models",
        vox([...one, palette, transform(0, 1), group(1, [2, 4]), shape(3, [0]), shape(5, [0])]),
      ],
      ["vox_rotated", vox([...one, palette, ...scene({ _r: "17" })])],
      ["vox_no_palette", vox(one)],
      ["vox_voxel_outside", vox([size(1, 1, 1), xyzi([[0, 1, 0, 1]]), palette])],
      ["vox_bad_size", vox([size(33, 1, 1), xyzi([[0, 0, 0, 1]]), palette])],
      ["vox_bad_size", vox([size(1, 0, 1), xyzi([]), palette])],
    ];
    for (const [code, bytes] of cases) expect(codes(parseVox(bytes, "a.vox"))).toEqual([code]);
  });

  it("names the file in its diagnostic", () => {
    const result = parseVox(vox([size(1, 1, 1), xyzi([[0, 0, 0, 1]])]), "eye.vox");
    expect(result.ok ? undefined : result.diagnostics[0]?.source).toBe("eye.vox");
  });
});

describe("writeVox", () => {
  it("writes cubes that parseVox reads back unchanged", () => {
    const sizeOf = { x: 5, y: 3, z: 7 };
    const grid = new Uint8Array(5 * 3 * 7);
    for (let z = 0; z < 7; z++) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 5; x++) {
          grid[voxelIndex(sizeOf, x, y, z)] = (x * 3 + y * 5 + z * 7) % 4; // 0 to 3, all used
        }
      }
    }
    const cubes: VoxCubes = { size: sizeOf, colors: ["#112233", "#445566", "#a0b0c0"], grid };
    expect(ok(parseVox(writeVox(cubes)))).toEqual(cubes);
  });

  it("writes the vox axes parseVox maps from", () => {
    const sizeOf = { x: 2, y: 4, z: 3 };
    const grid = new Uint8Array(24);
    grid[voxelIndex(sizeOf, 1, 0, 2)] = 1;
    const bytes = writeVox({ size: sizeOf, colors: ["#c8281e"], grid });
    // The writer leaves unused palette entries black.
    const palette = chunk("RGBA", [
      ...RED,
      255,
      ...new Array<number[]>(255).fill([0, 0, 0, 255]).flat(),
    ]);
    expect([...bytes]).toEqual([...vox([size(2, 3, 4), xyzi([[1, 0, 0, 1]]), palette], 150)]);
  });

  it("refuses cubes a part can't have", () => {
    const one = { size: { x: 1, y: 1, z: 1 }, colors: ["#ffffff"], grid: new Uint8Array([1]) };
    expect(() => writeVox({ ...one, size: { x: 33, y: 1, z: 1 } })).toThrow();
    expect(() => writeVox({ ...one, grid: new Uint8Array(2) })).toThrow();
    expect(() => writeVox({ ...one, colors: [] })).toThrow();
    expect(() => writeVox({ ...one, colors: ["white"] })).toThrow();
  });
});
