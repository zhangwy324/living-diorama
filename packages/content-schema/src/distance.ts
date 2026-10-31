// Exact Euclidean distance transform (Felzenszwalb and Huttenlocher), keeping which pixel is
// nearest, for the drawing voxelizer (`voxel-draw.ts`, ADR 0025). A copy of the renderer's
// `body/distance.ts`, which goes with drawn bodies (M23).

/** Larger than any squared distance in an image, small enough to add exactly to one. */
const FAR = 1e10;

export interface Nearest {
  /** Squared distance from each pixel to the nearest marked pixel; `FAR` if none is marked. */
  distance2: Float64Array;
  /** The index of that pixel, or -1 if none is marked. */
  index: Int32Array;
}

/** For each pixel, the nearest pixel where `mask` is set, in straight-line distance. */
export function nearest(mask: Uint8Array, width: number, height: number): Nearest {
  // Columns first: the nearest marked row in each pixel's own column.
  const columnRow = new Int32Array(width * height);
  const columnDistance2 = new Float64Array(width * height);
  for (let x = 0; x < width; x++) {
    let above = -1;
    for (let y = 0; y < height; y++) {
      if (mask[y * width + x]) above = y;
      columnRow[y * width + x] = above;
    }
    let below = -1;
    for (let y = height - 1; y >= 0; y--) {
      const i = y * width + x;
      if (mask[i]) below = y;
      above = columnRow[i] ?? -1;
      const row = above < 0 || (below >= 0 && below - y < y - above) ? below : above;
      columnRow[i] = row;
      columnDistance2[i] = row < 0 ? FAR : (y - row) ** 2;
    }
  }
  // Then rows: the lower envelope of one parabola per column.
  const distance2 = new Float64Array(width * height);
  const index = new Int32Array(width * height);
  const vertex = new Int32Array(width);
  const from = new Float64Array(width + 1);
  for (let y = 0; y < height; y++) {
    const f = (x: number) => (columnDistance2[y * width + x] ?? FAR) + x * x;
    let k = 0;
    vertex[0] = 0;
    from[0] = -Infinity;
    from[1] = Infinity;
    for (let x = 1; x < width; x++) {
      let s: number;
      for (;;) {
        const v = vertex[k] ?? 0;
        s = (f(x) - f(v)) / (2 * (x - v));
        if (k > 0 && s <= (from[k] ?? 0)) k--;
        else break;
      }
      vertex[++k] = x;
      from[k] = s;
      from[k + 1] = Infinity;
    }
    k = 0;
    for (let x = 0; x < width; x++) {
      while ((from[k + 1] ?? Infinity) < x) k++;
      const v = vertex[k] ?? 0;
      const i = y * width + x;
      const row = columnRow[y * width + v] ?? -1;
      distance2[i] = f(v) - v * v + (x - v) ** 2;
      index[i] = row < 0 ? -1 : row * width + v;
    }
  }
  return { distance2, index };
}
