import type { Beat } from '../chart/types';

/** Sixteenth notes: 4 steps per beat, so 16 steps per 4/4 bar. */
export const STEPS_PER_BEAT = 4;

/** Index of the first element >= x in an ascending array. */
export function lowerBound(a: ArrayLike<number>, x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1; else hi = m;
  }
  return lo;
}

/** Distance from t to the nearest value in an ascending array (Infinity if empty). */
export function nearestDistance(a: number[], t: number): number {
  const i = lowerBound(a, t);
  let d = Infinity;
  if (i < a.length) d = a[i] - t;
  if (i > 0) d = Math.min(d, t - a[i - 1]);
  return d;
}

/**
 * The beat grid with sixteenth-note subdivisions. Beats from the analyzer are not perfectly
 * evenly spaced (the tracker follows small tempo drift), so subdivisions are interpolated
 * between neighbouring beats rather than derived from the average BPM.
 */
export class BeatGrid {
  readonly times: number[];
  readonly beatsPerBar: number;

  constructor(readonly beats: Beat[], beatsPerBar = 4) {
    this.times = beats.map((b) => b.t);
    this.beatsPerBar = beatsPerBar;
  }

  get stepsPerBar() { return this.beatsPerBar * STEPS_PER_BEAT; }
  get stepCount() { return this.beats.length * STEPS_PER_BEAT; }

  private interval(i: number): number {
    const n = this.times.length;
    if (n < 2) return 0.5;
    const j = Math.min(Math.max(i, 0), n - 2);
    return this.times[j + 1] - this.times[j];
  }

  /** Time of global step s (s = beatIndex * 4 + sixteenth). Extrapolates past the last beat. */
  stepTime(s: number): number {
    const i = Math.floor(s / STEPS_PER_BEAT);
    const f = (s - i * STEPS_PER_BEAT) / STEPS_PER_BEAT;
    const n = this.times.length;
    if (i >= n - 1) return this.times[n - 1] + (s / STEPS_PER_BEAT - (n - 1)) * this.interval(n - 2);
    if (i < 0) return this.times[0] + (s / STEPS_PER_BEAT) * this.interval(0);
    return this.times[i] + f * (this.times[i + 1] - this.times[i]);
  }

  /** Step duration around step s, in seconds. */
  stepDur(s: number): number { return this.interval(Math.floor(s / STEPS_PER_BEAT)) / STEPS_PER_BEAT; }

  /** Position of step s inside its bar, 0..stepsPerBar-1. */
  stepInBar(s: number): number {
    const b = this.beats[Math.min(this.beats.length - 1, Math.floor(s / STEPS_PER_BEAT))];
    return b.beatInBar * STEPS_PER_BEAT + (s % STEPS_PER_BEAT);
  }

  barOf(s: number): number { return this.beats[Math.min(this.beats.length - 1, Math.floor(s / STEPS_PER_BEAT))].barIndex; }

  /** Fractional beat position of time t (continuous, extrapolated at the ends). */
  beatPos(t: number): number {
    const n = this.times.length;
    if (n === 0) return 0;
    if (t <= this.times[0]) return (t - this.times[0]) / this.interval(0);
    if (t >= this.times[n - 1]) return n - 1 + (t - this.times[n - 1]) / this.interval(n - 2);
    const i = lowerBound(this.times, t) - 1;
    return i + (t - this.times[i]) / (this.times[i + 1] - this.times[i]);
  }

  /** First step index whose time is >= t. */
  firstStepAtOrAfter(t: number): number {
    return Math.max(0, Math.ceil(this.beatPos(t) * STEPS_PER_BEAT - 1e-6));
  }
}

/**
 * How often each sixteenth position in the bar carries an onset of a band, over [start, end).
 * Turns noisy per-band onsets into the song's actual (regularized) rhythm for that band.
 * share[k] = fraction of bars in which step k had an onset nearby.
 */
export function rhythmShare(grid: BeatGrid, onsets: number[], start: number, end: number): { share: number[]; bars: number } {
  const n = grid.stepsPerBar;
  const hits = new Array<number>(n).fill(0);
  const seen = new Array<number>(n).fill(0);
  const s0 = grid.firstStepAtOrAfter(start);
  for (let s = s0; s < grid.stepCount; s++) {
    const t = grid.stepTime(s);
    if (t >= end) break;
    const k = grid.stepInBar(s);
    const tol = Math.min(0.045, 0.35 * grid.stepDur(s));
    seen[k]++;
    if (nearestDistance(onsets, t) < tol) hits[k]++;
  }
  return { share: hits.map((h, k) => (seen[k] ? h / seen[k] : 0)), bars: Math.min(...seen) };
}

/** Steps whose share is at least `minShare`, strongest first, at most `max` of them. */
export function maskFromShare(share: number[], minShare: number, max: number): number[] {
  return share
    .map((v, k) => ({ v, k }))
    .filter((x) => x.v >= minShare)
    .sort((a, b) => b.v - a.v || a.k - b.k)
    .slice(0, max)
    .map((x) => x.k)
    .sort((a, b) => a - b);
}
