/**
 * Small, seedable PRNG (mulberry32). Deterministic seeding makes the simulation
 * reproducible for demos and tests.
 */
export interface Rng {
  /** Float in [0, 1). */
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  float(min: number, max: number): number;
  bool(probability?: number): boolean;
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly { value: T; weight: number }[]): T;
  /** Standard normal via Box–Muller. */
  gaussian(mean?: number, stdDev?: number): number;
  /** Exponential inter-arrival time with the given mean. */
  exponential(mean: number): number;
  shuffle<T>(items: T[]): T[];
}

export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function createRng(seed: number | string = Date.now()): Rng {
  let state = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 0x9e3779b9;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => next() * (max - min) + min,
    bool: (probability = 0.5) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error('pick() on empty list');
      return items[Math.floor(next() * items.length)] as never;
    },
    weighted: (items) => {
      const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
      if (total <= 0) throw new Error('weighted() needs a positive total weight');
      let roll = next() * total;
      for (const item of items) {
        roll -= Math.max(0, item.weight);
        if (roll <= 0) return item.value;
      }
      return items[items.length - 1]!.value;
    },
    gaussian: (mean = 0, stdDev = 1) => {
      let u = 0;
      let v = 0;
      while (u === 0) u = next();
      while (v === 0) v = next();
      return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    exponential: (mean) => -Math.log(1 - next()) * mean,
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j] as never, items[i] as never];
      }
      return items;
    },
  };
  return rng;
}
