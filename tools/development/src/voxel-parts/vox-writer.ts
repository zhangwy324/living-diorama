import { MAX_PART_COLORS, MAX_PART_CUBES, voxelIndex } from "@living-diorama/content-schema";
import type { VoxCubes } from "./vox-parser";

// Writes a part's cubes as a MagicaVoxel `.vox` file (version 150: MAIN with SIZE, XYZI and RGBA,
// no scene graph), so parts made in code can be refined in MagicaVoxel. The inverse of
// `parseVox`: vox x = part X, vox y = Z − 1 − part Z, vox z = part Y. Colour i of the part is
// palette index i; the palette's unused entries are black.

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

function int32(value: number): number[] {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return [...bytes];
}

function chunk(id: string, content: number[], children: number[] = []): number[] {
  return [
    ...ascii(id),
    ...int32(content.length),
    ...int32(children.length),
    ...content,
    ...children,
  ];
}

/** A `.vox` file of one model holding `cubes`. Throws on cubes `parseVox` would refuse. */
export function writeVox({ size, colors, grid }: VoxCubes): Uint8Array {
  for (const axis of ["x", "y", "z"] as const) {
    if (!Number.isInteger(size[axis]) || size[axis] < 1 || size[axis] > MAX_PART_CUBES) {
      throw new Error(`A part is 1 to ${MAX_PART_CUBES} cubes along ${axis}, not ${size[axis]}`);
    }
  }
  if (grid.length !== size.x * size.y * size.z) {
    throw new Error(`The grid has ${grid.length} cubes, not ${size.x}×${size.y}×${size.z}`);
  }
  if (colors.length > MAX_PART_COLORS) {
    throw new Error(`A .vox palette holds at most ${MAX_PART_COLORS} colours`);
  }
  const voxels: number[] = [];
  for (let z = 0; z < size.z; z++) {
    for (let y = 0; y < size.y; y++) {
      for (let x = 0; x < size.x; x++) {
        const index = grid[voxelIndex(size, x, y, z)] ?? 0;
        if (index === 0) continue;
        if (index > colors.length) throw new Error(`Colour index ${index} has no colour`);
        voxels.push(x, size.z - 1 - z, y, index);
      }
    }
  }
  const palette: number[] = [];
  for (let i = 0; i < 256; i++) {
    const color = colors[i];
    if (color === undefined) {
      palette.push(0, 0, 0, 255);
      continue;
    }
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error(`"${color}" isn't a #rrggbb colour`);
    const rgb = Number.parseInt(color.slice(1), 16);
    palette.push(rgb >> 16, (rgb >> 8) & 0xff, rgb & 0xff, 255);
  }
  const children = [
    ...chunk("SIZE", [...int32(size.x), ...int32(size.z), ...int32(size.y)]),
    ...chunk("XYZI", [...int32(voxels.length / 4), ...voxels]),
    ...chunk("RGBA", palette),
  ];
  return new Uint8Array([...ascii("VOX "), ...int32(150), ...chunk("MAIN", [], children)]);
}
