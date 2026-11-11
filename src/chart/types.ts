/**
 * The "chart": everything the game needs to know about a song, computed once
 * before playback. All times are in seconds from the start of the decoded audio.
 *
 * Contract for consumers (the game):
 * - Times are audio-clock times. Compare them against the playback position derived
 *   from AudioContext.currentTime, never against wall-clock time.
 * - Continuous curves are normalized PER TRACK to 0..1 using percentiles (p5 → 0, p95 → 1,
 *   clamped), so "0.8 energy" means "loud for this song", not loud in absolute terms.
 * - In `mode: 'fallback'` there is no trustworthy beat grid: `tempo` is null and `beats`
 *   is empty. Energy, bands, sections, drops and quiet spans are still present.
 */
export const CHART_VERSION = 1 as const;

export type ChartMode = 'full' | 'fallback';

export interface Chart {
  version: typeof CHART_VERSION;
  meta: ChartMeta;
  mode: ChartMode;
  /** Null in fallback mode. */
  tempo: Tempo | null;
  /** Beat positions, ascending. Empty in fallback mode. */
  beats: Beat[];
  /** Per-track normalized feature curves, sampled every `curves.hopSec`. */
  curves: Curves;
  /** Onset times per band (seconds, ascending), useful for emitters following a sub-rhythm. */
  onsets: BandOnsets;
  /** Contiguous, non-overlapping, cover [0, duration]. */
  sections: Section[];
  /** Detected drops, ascending by time. */
  drops: Drop[];
  /** Sustained low-energy passages ("breathers"). */
  quiet: Span[];
}

export interface ChartMeta {
  durationSec: number;
  sampleRate: number;
  /** SHA-256 of the original file bytes (hex). Seed for pattern generation. */
  fileHash: string;
  fileName: string;
  analyzerVersion: string;
  /** Wall-clock analysis duration, for diagnostics only. */
  analysisMs: number;
}

export interface Tempo {
  bpm: number;
  /** 0..1, how periodic the onset envelope is. Below the threshold we fall back. */
  confidence: number;
  /** Assumed meter; only 4/4 is detected for now. */
  beatsPerBar: number;
}

export interface Beat {
  t: number;
  index: number;
  /** Position in the bar, 0 = downbeat. */
  beatInBar: number;
  barIndex: number;
  /** 0..1 onset strength at this beat (normalized per track). */
  strength: number;
}

export interface Curves {
  hopSec: number;
  frameCount: number;
  /** Overall loudness (RMS in dB, percentile-normalized). */
  energy: Float32Array;
  /** Kick / sub (≈ 20–150 Hz). */
  low: Float32Array;
  /** Snare / vocals (≈ 150–4000 Hz). */
  mid: Float32Array;
  /** Hats / cymbals (≈ 4–16 kHz). */
  high: Float32Array;
  /** Structural novelty (section-change likelihood), 0..1. */
  novelty: Float32Array;
}

export interface BandOnsets {
  low: number[];
  mid: number[];
  high: number[];
}

export interface Span {
  start: number;
  end: number;
}

export interface Section extends Span {
  index: number;
  /** Mean normalized energy over the section, 0..1. */
  energy: number;
  /** Rough intensity bucket, handy for picking enemy sets. */
  intensity: 'low' | 'mid' | 'high';
}

export interface Drop {
  t: number;
  /** Start of the build-up leading into the drop, or null if the drop comes out of nowhere. */
  buildStart: number | null;
  /** 0..1, size of the energy jump. */
  intensity: number;
}

/** Display-only data the viewer needs but the game does not. */
export interface Waveform {
  peaksPerSec: number;
  min: Float32Array;
  max: Float32Array;
}

export interface AnalysisResult {
  chart: Chart;
  waveform: Waveform;
}

/** Sample the curve at time t (linear interpolation, clamped). */
export function sampleCurve(curve: Float32Array, hopSec: number, t: number): number {
  const x = t / hopSec;
  if (x <= 0) return curve[0] ?? 0;
  const i = Math.floor(x);
  if (i >= curve.length - 1) return curve[curve.length - 1] ?? 0;
  const f = x - i;
  return curve[i] * (1 - f) + curve[i + 1] * f;
}

/** Plain-JSON form of a chart (typed arrays become number arrays). */
export function chartToJSON(chart: Chart): unknown {
  const round = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 1000) / 1000);
  return {
    ...chart,
    curves: {
      ...chart.curves,
      energy: round(chart.curves.energy),
      low: round(chart.curves.low),
      mid: round(chart.curves.mid),
      high: round(chart.curves.high),
      novelty: round(chart.curves.novelty),
    },
  };
}
