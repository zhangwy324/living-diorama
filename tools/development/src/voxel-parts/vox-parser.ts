import {
  error,
  MAX_PART_CUBES,
  voxelIndex,
  type Result,
  type VoxelSize,
} from "@living-diorama/content-schema";

// Reads a MagicaVoxel `.vox` file into a voxel part's cubes (ADR 0022, M20 decisions "Axes" and
// "What a `.vox` may hold").
// Pure over bytes, with no Node or DOM APIs, so it can move to content-schema for player imports
// (M28).
//
// The format: "VOX " and an int32 version (150 or 200), then a MAIN chunk whose children are the
// file's chunks. A chunk is a 4-byte ID, its content's byte count, its children's byte count, the
// content and the children; integers are little-endian int32. The chunks read here:
// - SIZE (x, y, z) and XYZI (a count, then x, y, z and a colour index of one byte each), a model;
// - RGBA, 256 colours of 4 bytes: entry i is colour index i + 1;
// - nTRN, nGRP and nSHP, the scene graph of version 200, read to refuse more than one model or a
//   rotated one.
// Everything else (materials MATL, MATT, layers, render settings, cameras, notes, IMAP's palette
// display order, PACK) is skipped.

/** A part's cubes as read from a `.vox`, in the part's frame (ADR 0022 §16). */
export interface VoxCubes {
  size: VoxelSize;
  /** `#rrggbb`; cube index i (1–255) has `colors[i - 1]`. */
  colors: string[];
  /** One colour index per cube, 0 empty, x fastest, then y, then z (`voxelIndex`). */
  grid: Uint8Array;
}

/** The `.vox` versions read: 150 (older MagicaVoxel) and 200 (with the scene graph). */
export const VOX_VERSIONS = [150, 200] as const;

/** The scene-graph rotation byte of the identity: row 0's one at column 0, row 1's at column 1. */
const IDENTITY_ROTATION = 4;

class VoxError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new VoxError(code, message);
}

/** `values[i]`, known to be there. */
const at = (values: ArrayLike<number>, i: number): number => values[i] ?? 0;

class Reader {
  private readonly view: DataView;
  constructor(
    private readonly bytes: Uint8Array,
    public at: number,
    readonly end: number,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private need(count: number): void {
    if (this.at + count > this.end) fail("vox_truncated", "The file ends inside a chunk");
  }

  int(): number {
    this.need(4);
    const value = this.view.getInt32(this.at, true);
    this.at += 4;
    return value;
  }

  byte(): number {
    this.need(1);
    return this.view.getUint8(this.at++);
  }

  /** ASCII text; the only strings read are chunk IDs and scene-graph attributes. */
  text(length: number): string {
    if (length < 0) fail("vox_malformed", "A string has a negative length");
    this.need(length);
    let out = "";
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.bytes[this.at + i] ?? 0);
    this.at += length;
    return out;
  }

  dict(): Map<string, string> {
    const count = this.int();
    if (count < 0) fail("vox_malformed", "A dictionary has a negative size");
    const out = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      const key = this.text(this.int());
      out.set(key, this.text(this.int()));
    }
    return out;
  }
}

interface Chunk {
  id: string;
  /** The content, read on its own so a short chunk can't read into the next one. */
  content: Reader;
  /** Where its children end; they start at `content.end`. */
  childrenEnd: number;
}

/** The chunks between `at` and `end`, each with its content; children are skipped. */
function chunks(bytes: Uint8Array, at: number, end: number): Chunk[] {
  const out: Chunk[] = [];
  const reader = new Reader(bytes, at, end);
  while (reader.at < end) {
    const id = reader.text(4);
    const contentBytes = reader.int();
    const childBytes = reader.int();
    if (contentBytes < 0 || childBytes < 0)
      fail("vox_malformed", `Chunk ${id} has a negative size`);
    const contentEnd = reader.at + contentBytes;
    if (contentEnd + childBytes > end) fail("vox_truncated", `Chunk ${id} runs past its parent`);
    out.push({
      id,
      content: new Reader(bytes, reader.at, contentEnd),
      childrenEnd: contentEnd + childBytes,
    });
    reader.at = contentEnd + childBytes;
  }
  return out;
}

const hex = (byte: number) => byte.toString(16).padStart(2, "0");

/**
 * Reads a `.vox` file's one model as a part's cubes. Part X is vox x, part Y (up) vox z, and part
 * Z (to the creature's right) runs against vox y: Z = size.y − 1 − y ("Axes"), a proper rotation, so
 * the model isn't mirrored. Colour index 0 is empty; the colours the model uses are listed in the
 * order of their palette indices, with duplicates merged, and the cubes renumbered to them.
 * Refuses a file with more than one model, a rotated model, more than `MAX_PART_CUBES` along an
 * axis, or no palette (RGBA chunk). A model's translation is ignored: the part's own corner is its
 * origin. Materials are ignored.
 */
export function parseVox(bytes: Uint8Array, source?: string): Result<VoxCubes> {
  try {
    return { ok: true, value: read(bytes) };
  } catch (e) {
    if (!(e instanceof VoxError)) throw e;
    return { ok: false, diagnostics: [error(e.code, e.message, [], source)] };
  }
}

function read(bytes: Uint8Array): VoxCubes {
  const header = new Reader(bytes, 0, bytes.length);
  if (bytes.length < 8 || header.text(4) !== "VOX ") {
    fail("vox_not_vox", 'Not a MagicaVoxel file: it doesn\'t start with "VOX "');
  }
  const version = header.int();
  if (!(VOX_VERSIONS as readonly number[]).includes(version)) {
    fail(
      "vox_unsupported_version",
      `.vox version ${version} is not supported (supported: ${VOX_VERSIONS.join(", ")})`,
    );
  }
  const [main, ...rest] = chunks(bytes, 8, bytes.length);
  if (main?.id !== "MAIN") fail("vox_malformed", "The file's first chunk isn't MAIN");
  if (rest.length > 0) fail("vox_malformed", "There are chunks after MAIN");
  // MAIN's children follow its (normally empty) content.
  const children = chunks(bytes, main.content.end, main.childrenEnd);

  const sizes: VoxelSize[] = [];
  const models: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let shapes = 0;
  for (const { id, content } of children) {
    switch (id) {
      case "SIZE":
        sizes.push({ x: content.int(), y: content.int(), z: content.int() });
        break;
      case "XYZI": {
        const count = content.int();
        if (count < 0) fail("vox_malformed", "XYZI has a negative voxel count");
        // Checked before allocating, so a huge count fails here and not as a RangeError.
        if (count * 4 > content.end - content.at) {
          fail("vox_truncated", `XYZI lists ${count} voxels but holds fewer`);
        }
        const voxels = new Uint8Array(count * 4);
        for (let i = 0; i < voxels.length; i++) voxels[i] = content.byte();
        models.push(voxels);
        break;
      }
      case "RGBA": {
        palette = new Uint8Array(256 * 4);
        for (let i = 0; i < palette.length; i++) palette[i] = content.byte();
        break;
      }
      case "nTRN": {
        content.int(); // node ID
        content.dict(); // attributes: name, hidden
        content.int(); // child node ID
        content.int(); // reserved (-1)
        content.int(); // layer ID
        const frames = content.int();
        for (let f = 0; f < frames; f++) {
          const rotation = content.dict().get("_r");
          if (rotation !== undefined && Number(rotation) !== IDENTITY_ROTATION) {
            fail(
              "vox_rotated",
              "A model is rotated in the scene; apply the rotation to the model in MagicaVoxel",
            );
          }
        }
        break;
      }
      case "nSHP": {
        content.int(); // node ID
        content.dict(); // attributes
        const count = content.int();
        if (count === 0) fail("vox_malformed", "A shape node holds no model");
        if (count > 1) fail("vox_many_models", "A shape node holds more than one model");
        shapes++;
        break;
      }
    }
  }

  if (sizes.length !== models.length) {
    fail("vox_malformed", "Every model needs one SIZE and one XYZI chunk");
  }
  const [vox] = sizes;
  const [voxels] = models;
  if (!vox || !voxels) fail("vox_no_model", "The file holds no model");
  if (sizes.length > 1 || shapes > 1) {
    fail("vox_many_models", "The file holds more than one model; a part is one model");
  }
  if (!palette) fail("vox_no_palette", "The file has no palette (RGBA chunk)");

  for (const axis of ["x", "y", "z"] as const) {
    if (vox[axis] < 1 || vox[axis] > MAX_PART_CUBES) {
      fail(
        "vox_bad_size",
        `The model is ${vox[axis]} cubes along vox ${axis}; a part is 1 to ${MAX_PART_CUBES}`,
      );
    }
  }
  const size: VoxelSize = { x: vox.x, y: vox.z, z: vox.y };
  const raw = new Uint8Array(size.x * size.y * size.z);
  for (let i = 0; i < voxels.length; i += 4) {
    const x = at(voxels, i);
    const y = at(voxels, i + 1);
    const z = at(voxels, i + 2);
    if (x >= vox.x || y >= vox.y || z >= vox.z) {
      fail("vox_voxel_outside", `A voxel at (${x}, ${y}, ${z}) is outside the model's size`);
    }
    // A later voxel at the same place wins; index 0 is empty.
    raw[voxelIndex(size, x, z, vox.y - 1 - y)] = at(voxels, i + 3);
  }

  // Compact the palette: used indices in order, identical colours merged.
  const used = [...new Set(raw)].filter((index) => index !== 0).sort((a, b) => a - b);
  const colors: string[] = [];
  const remap = new Uint8Array(256);
  for (const index of used) {
    const p = (index - 1) * 4;
    const color = `#${hex(at(palette, p))}${hex(at(palette, p + 1))}${hex(at(palette, p + 2))}`;
    let compact = colors.indexOf(color);
    if (compact < 0) compact = colors.push(color) - 1;
    remap[index] = compact + 1;
  }
  const grid = raw.map((index) => at(remap, index));
  return { size, colors, grid };
}
