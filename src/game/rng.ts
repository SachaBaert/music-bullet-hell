/**
 * Deterministic randomness for pattern generation.
 *
 * Every random stream is derived from `chart.meta.fileHash` plus a salt that names what it is for
 * (e.g. "s3:ring"). Separate streams per section and per layer mean that tweaking one layer's
 * generator does not reshuffle the others, and the same file always yields the same patterns.
 */

/** FNV-1a (32-bit) over the hash string and a salt. */
export function seedFrom(fileHash: string, salt: string): number {
  let h = 0x811c9dc5;
  const s = `${fileHash}|${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 0x9e3779b9; }

  /** mulberry32: uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return a + Math.floor(this.next() * (b - a + 1)); }
  chance(p: number) { return this.next() < p; }
  pick<T>(items: readonly T[]): T { return items[Math.floor(this.next() * items.length)]; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
}

export const rngFor = (fileHash: string, salt: string) => new Rng(seedFrom(fileHash, salt));
