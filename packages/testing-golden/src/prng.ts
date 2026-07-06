// SPEC: WA.1.10 — golden dataset seeded deterministic PRNG (§1.10)
//
// Pure, dependency-free PRNG: xmur3 string-hash seeds a mulberry32 stream.
// Same seed string → the exact same number sequence in every process, forever.
// NO Math.random, NO Date.now anywhere in generation (determinism invariant).

/** xmur3 string hash — produces a 32-bit seeding function from a string. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** mulberry32 — fast deterministic 32-bit PRNG returning floats in [0, 1). */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic random stream. `fork(label)` derives an INDEPENDENT substream
 * so scenario builders cannot perturb each other's sequences when counts change.
 */
export class Rand {
  private readonly gen: () => number;

  constructor(private readonly seed: string) {
    const seeder = xmur3(seed);
    this.gen = mulberry32(seeder());
  }

  /** Float in [0, 1). */
  next(): number {
    return this.gen();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform pick from a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rand.pick: empty array');
    const idx = this.int(0, arr.length - 1);
    return arr[idx] as T;
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Independent deterministic substream keyed by label. */
  fork(label: string): Rand {
    return new Rand(`${this.seed}::${label}`);
  }
}
