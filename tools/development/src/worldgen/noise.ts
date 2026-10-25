// Small deterministic helpers for world generation. Only integer and basic float arithmetic, so
// output is identical on every platform running the same Node version.

/** mulberry32: a tiny seeded PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(seed: number, i: number, j: number): number {
  let h = (seed ^ Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Value noise in [-1, 1] with smooth interpolation between integer lattice points. */
export function valueNoise(seed: number, x: number, z: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const fx = smooth(x - i);
  const fz = smooth(z - j);
  const a = hash(seed, i, j);
  const b = hash(seed, i + 1, j);
  const c = hash(seed, i, j + 1);
  const d = hash(seed, i + 1, j + 1);
  return (a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz) * 2 - 1;
}

/** Fractal value noise in roughly [-1, 1]. */
export function fbm(seed: number, x: number, z: number, octaves = 3): number {
  let sum = 0;
  let amplitude = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amplitude * valueNoise(seed + o * 1013, x, z);
    norm += amplitude;
    amplitude *= 0.5;
    x *= 2;
    z *= 2;
  }
  return sum / norm;
}

export const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Rounds to millimetres (and turns -0 into 0) so generated JSON is stable. */
export const mm = (v: number) => Math.round(v * 1000) / 1000 + 0;
