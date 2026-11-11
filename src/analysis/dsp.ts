/** Small, dependency-free DSP helpers used by the analyzer. */

/** In-place iterative radix-2 complex FFT with precomputed twiddles. */
export class FFT {
  readonly size: number;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (size & (size - 1)) throw new Error('FFT size must be a power of 2');
    this.size = size;
    this.cos = new Float32Array(size / 2);
    this.sin = new Float32Array(size / 2);
    for (let i = 0; i < size / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
    this.rev = new Uint32Array(size);
    const bits = Math.log2(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
  }

  transform(re: Float32Array, im: Float32Array): void {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = i + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

export function hann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const sorted = Float32Array.from(values).sort();
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

/** Map p_lo → 0 and p_hi → 1, clamped. This is the per-track normalization. */
export function percentileNormalize(values: Float32Array, lo = 5, hi = 95): Float32Array {
  const a = percentile(values, lo);
  const b = percentile(values, hi);
  const range = b - a || 1;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = clamp01((values[i] - a) / range);
  return out;
}

/** Centered moving average with a window of `radius` samples on each side. */
export function movingAverage(x: Float32Array, radius: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  if (radius <= 0) { out.set(x); return out; }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

export function mean(x: ArrayLike<number>, from = 0, to = x.length): number {
  from = Math.max(0, from);
  to = Math.min(x.length, to);
  if (to <= from) return 0;
  let s = 0;
  for (let i = from; i < to; i++) s += x[i];
  return s / (to - from);
}

export function std(x: ArrayLike<number>): number {
  const m = mean(x);
  let s = 0;
  for (let i = 0; i < x.length; i++) s += (x[i] - m) ** 2;
  return Math.sqrt(s / Math.max(1, x.length));
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Turn a raw spectral-flux curve into an onset-strength envelope:
 * subtract a local mean (high-pass), half-wave rectify, divide by the std.
 */
export function onsetEnvelope(flux: Float32Array, localRadius: number): Float32Array {
  const local = movingAverage(flux, localRadius);
  const out = new Float32Array(flux.length);
  for (let i = 0; i < flux.length; i++) out[i] = Math.max(0, flux[i] - local[i]);
  const s = std(out) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= s;
  return out;
}

/**
 * Adaptive-threshold peak picking: a peak must be a local max within ±`maxRadius`,
 * exceed local mean (±`meanRadius`) + delta, and be at least `minGap` frames after the previous peak.
 */
export function pickPeaks(
  env: Float32Array,
  opts: { maxRadius: number; meanRadius: number; delta: number; minGap: number },
): number[] {
  const local = movingAverage(env, opts.meanRadius);
  const peaks: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i];
    if (v < local[i] + opts.delta) continue;
    let isMax = true;
    for (let j = Math.max(0, i - opts.maxRadius); j <= Math.min(env.length - 1, i + opts.maxRadius); j++) {
      if (env[j] > v || (env[j] === v && j < i)) { isMax = false; break; }
    }
    if (!isMax) continue;
    if (i - last < opts.minGap) continue;
    peaks.push(i);
    last = i;
  }
  return peaks;
}

/** Resample a curve with step `fromHop` seconds onto a grid with step `toHop` seconds. */
export function resampleCurve(x: Float32Array, fromHop: number, toHop: number, toLength: number): Float32Array {
  const out = new Float32Array(toLength);
  for (let i = 0; i < toLength; i++) {
    const pos = (i * toHop) / fromHop;
    const a = Math.floor(pos);
    const f = pos - a;
    const va = x[Math.min(x.length - 1, a)] ?? 0;
    const vb = x[Math.min(x.length - 1, a + 1)] ?? 0;
    out[i] = va * (1 - f) + vb * f;
  }
  return out;
}
