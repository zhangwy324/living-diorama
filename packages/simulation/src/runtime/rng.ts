// The simulation's only source of randomness (roadmap M3 task 2): sfc32, a small fast generator
// with 128 bits of state. Integer arithmetic only, so every engine produces the same sequence.

/** Plain-data RNG state, kept inside the simulation state so it saves and replays with it. */
export interface RngState {
  /** The four sfc32 state words. */
  words: [number, number, number, number];
  /** Identity of this stream; forks derive from it, never from the current position. */
  key: number;
}

/** murmur3's 32-bit finaliser. */
function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a over the string's UTF-16 code units, starting from `key`, then mixed. */
function hashString(key: number, text: string): number {
  let h = (key ^ 0x811c9dc5) >>> 0;
  for (let k = 0; k < text.length; k++) h = Math.imul(h ^ text.charCodeAt(k), 0x01000193);
  return mix32(h);
}

function stateFromKey(key: number): RngState {
  // splitmix32 spreads the key over the four words.
  let s = key >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = Math.imul(s ^ (s >>> 16), 0x21f0aafd);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  const state: RngState = { words: [next(), next(), next(), next()], key: key >>> 0 };
  const rng = new Rng(state);
  for (let k = 0; k < 12; k++) rng.nextUint32();
  return state;
}

/** A view over an `RngState` that advances it in place. */
export class Rng {
  constructor(readonly state: RngState) {}

  static fromSeed(seed: number): Rng {
    return new Rng(stateFromKey(mix32(seed >>> 0)));
  }

  /**
   * An independent stream named `name`. It depends only on this stream's identity and the name,
   * so forking a new creature never shifts the sequence of an existing one.
   */
  fork(name: string): Rng {
    return new Rng(stateFromKey(hashString(this.state.key, name)));
  }

  nextUint32(): number {
    const w = this.state.words;
    let [a, b, c, d] = w;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    w[0] = a;
    w[1] = b;
    w[2] = c;
    w[3] = d;
    return t >>> 0;
  }

  /** A float in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** A float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** An integer in [min, maxExclusive). */
  int(min: number, maxExclusive: number): number {
    return min + Math.floor(this.next() * (maxExclusive - min));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T | undefined {
    return items.length === 0 ? undefined : items[this.int(0, items.length)];
  }
}
