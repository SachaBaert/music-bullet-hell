/**
 * Offline song analysis → Chart. Pure function (no DOM, no Web Audio), so it runs in a
 * Web Worker in the browser and in Node for tests.
 *
 * Pipeline
 *   1. STFT (Hann, ~46 ms frames, 75 % overlap) on the mono mixdown
 *   2. Per frame: RMS energy, 3 band energies, log-magnitude spectral flux (total + per band),
 *      12 coarse spectral bands + 12-bin chroma for structure analysis
 *   3. Tempo: autocorrelation of the onset envelope with a log-Gaussian prior around 120 BPM,
 *      plus a windowed stability check → confidence
 *   4. Beats: dynamic-programming beat tracker (Ellis 2007), downbeat phase from bass onsets
 *      + harmonic change
 *   5. Sections: Foote checkerboard novelty on a self-similarity matrix of 0.5 s blocks
 *   6. Drops: sharp sustained energy + bass jump; build = rising energy/brightness before it
 *   7. Quiet: sustained low normalized energy
 */
import {
  CHART_VERSION,
  type AnalysisResult,
  type Beat,
  type Chart,
  type Drop,
  type Section,
  type Span,
  type Tempo,
} from '../chart/types';
import {
  FFT,
  clamp01,
  hann,
  mean,
  movingAverage,
  onsetEnvelope,
  percentile,
  percentileNormalize,
  pickPeaks,
  resampleCurve,
  std,
} from './dsp';

export const ANALYZER_VERSION = 'custom-dsp-0.1.0';

export interface AnalyzeOptions {
  fileHash?: string;
  fileName?: string;
  onProgress?: (fraction: number, stage: string) => void;
  /** Below this tempo confidence the chart switches to fallback mode. */
  fallbackThreshold?: number;
}

const BANDS = { low: [20, 150], mid: [150, 4000], high: [4000, 16000] } as const;
const SPEC_BANDS = 12;
const MEL_BANDS = 64;
const WAVEFORM_PEAKS_PER_SEC = 200;
const BLOCK_SEC = 0.5; // structure-analysis resolution
// Flux peaks ~1 frame before the perceived onset with centered frames (measured on synthetic kicks).
const BEAT_TIME_OFFSET_FRAMES = 0.85;

export function analyze(channels: Float32Array[], sampleRate: number, opts: AnalyzeOptions = {}): AnalysisResult {
  const t0 = now();
  const progress = opts.onProgress ?? (() => {});
  const mono = mixdown(channels);
  const durationSec = mono.length / sampleRate;

  progress(0.02, 'waveform');
  const waveform = computeWaveform(mono, sampleRate);

  // ---------- 1+2. STFT features ----------
  const frameSize = 2 ** Math.round(Math.log2(sampleRate * 0.0464)); // 2048 @ 44.1/48 kHz
  const hop = frameSize / 4;
  const hopSec = hop / sampleRate;
  const frameCount = Math.max(1, Math.ceil(mono.length / hop));
  const f = stftFeatures(mono, sampleRate, frameSize, hop, frameCount, (p) => progress(0.05 + p * 0.55, 'spectrum'));

  // ---------- normalized curves ----------
  progress(0.62, 'curves');
  // Short-term loudness: windowed average power, then dB, then per-track percentiles.
  // (Per-frame values would swing between kick peaks and gaps; that's what onsets are for.)
  const loudness = (pow: Float32Array, windowSec: number) => {
    const avg = movingAverage(pow, Math.round(windowSec / 2 / hopSec));
    return percentileNormalize(Float32Array.from(avg, (p) => 10 * Math.log10(p + 1e-10)));
  };
  // Overall energy is smoothed over ~1 s so it tracks intensity, not individual kicks;
  // bands stay more reactive (~250 ms) since they drive per-instrument emitters.
  const energy = loudness(f.energyPow, 1.0);
  const low = loudness(f.lowPow, 0.25);
  const mid = loudness(f.midPow, 0.25);
  const high = loudness(f.highPow, 0.25);

  // ---------- onsets ----------
  const sec = (s: number) => Math.max(1, Math.round(s / hopSec));
  const bandEnv = {
    low: onsetEnvelope(f.fluxLow, sec(0.4)),
    mid: onsetEnvelope(f.fluxMid, sec(0.4)),
    high: onsetEnvelope(f.fluxHigh, sec(0.4)),
  };
  // Beat-tracking envelope: full-band flux plus an explicit bass term, because in most
  // music the kick/bass defines the beat and off-beat hats would otherwise win.
  const fullEnv = onsetEnvelope(f.flux, sec(0.4));
  const onsetEnv = smooth3(Float32Array.from(fullEnv, (v, i) => v + bandEnv.low[i]));
  const toTimes = (idx: number[]) => idx.map((i) => round3(i * hopSec));
  const onsets = {
    low: toTimes(pickPeaks(bandEnv.low, { maxRadius: sec(0.05), meanRadius: sec(0.3), delta: 0.6, minGap: sec(0.1) })),
    mid: toTimes(pickPeaks(bandEnv.mid, { maxRadius: sec(0.04), meanRadius: sec(0.3), delta: 0.6, minGap: sec(0.08) })),
    high: toTimes(pickPeaks(bandEnv.high, { maxRadius: sec(0.03), meanRadius: sec(0.3), delta: 0.6, minGap: sec(0.06) })),
  };

  // ---------- 3+4. tempo and beats ----------
  progress(0.68, 'tempo');
  const tempoEst = estimateTempo(onsetEnv, hopSec);
  let tempo: Tempo | null = null;
  let beats: Beat[] = [];
  const threshold = opts.fallbackThreshold ?? 0.35;
  if (tempoEst && tempoEst.confidence >= threshold) {
    progress(0.72, 'beats');
    const beatFrames = trackBeats(onsetEnv, tempoEst.periodFrames);
    const trimmed = trimToActivity(beatFrames, onsetEnv, tempoEst.periodFrames);
    if (trimmed.length >= 8) {
      const bpm = refineBpm(trimmed, hopSec) ?? tempoEst.bpm;
      tempo = { bpm: round2(bpm), confidence: round2(tempoEst.confidence), beatsPerBar: 4 };
      beats = labelBeats(trimmed, onsetEnv, bandEnv.low, bandEnv.mid, energy, f.chroma, hopSec);
    }
  }
  const mode: Chart['mode'] = tempo ? 'full' : 'fallback';

  // ---------- 5. sections ----------
  progress(0.8, 'sections');
  const blockFrames = Math.max(1, Math.round(BLOCK_SEC / hopSec));
  const blockHop = blockFrames * hopSec;
  const { novelty: noveltyBlocks, boundaries } = segment(f, blockFrames, blockHop, durationSec);
  const novelty = resampleCurve(noveltyBlocks, blockHop, hopSec, frameCount);

  // ---------- 6. drops ----------
  progress(0.9, 'drops');
  const drops = findDrops(energy, low, high, hopSec, durationSec, beats);

  // A drop is always a section change; it replaces any novelty boundary close to it.
  const snapped = boundaries
    .map((b) => snapToGrid(b, beats, 'downbeat', 2.5))
    .filter((b) => drops.every((d) => Math.abs(d.t - b) > 3));
  const sections = buildSections(dedupeSorted([...snapped, ...drops.map((d) => d.t)], 2), durationSec, energy, hopSec);

  // ---------- 7. quiet ----------
  const quiet = findQuiet(energy, hopSec, durationSec);

  const chart: Chart = {
    version: CHART_VERSION,
    meta: {
      durationSec: round3(durationSec),
      sampleRate,
      fileHash: opts.fileHash ?? '',
      fileName: opts.fileName ?? '',
      analyzerVersion: ANALYZER_VERSION,
      analysisMs: Math.round(now() - t0),
    },
    mode,
    tempo,
    beats,
    curves: { hopSec, frameCount, energy, low, mid, high, novelty },
    onsets,
    sections,
    drops,
    quiet,
  };
  progress(1, 'done');
  return { chart, waveform };
}

// ======================================================================================
// Feature extraction
// ======================================================================================

interface Features {
  /** Linear power per frame (dB conversion happens after short-term smoothing). */
  energyPow: Float32Array;
  lowPow: Float32Array;
  midPow: Float32Array;
  highPow: Float32Array;
  flux: Float32Array;
  fluxLow: Float32Array;
  fluxMid: Float32Array;
  fluxHigh: Float32Array;
  /** frameCount × SPEC_BANDS, log power. */
  spec: Float32Array;
  /** frameCount × 12, per-frame normalized chroma. */
  chroma: Float32Array;
  frameCount: number;
}

function stftFeatures(
  x: Float32Array,
  sr: number,
  N: number,
  hop: number,
  frameCount: number,
  progress: (p: number) => void,
): Features {
  const fft = new FFT(N);
  const win = hann(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const bins = N / 2;
  const binHz = sr / N;
  const magNorm = 4 / N; // full-scale sine ≈ 1 after Hann

  const bandOf = new Int8Array(bins).fill(-1); // 0 low, 1 mid, 2 high
  const specBandOf = new Int8Array(bins).fill(-1);
  const chromaOf = new Int8Array(bins).fill(-1);
  const melOf = new Int16Array(bins).fill(-1);
  const lo = 40, hi = Math.min(16000, sr / 2);
  const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
  const melLo = mel(30), melHi = mel(hi);
  for (let k = 1; k < bins; k++) {
    const hz = k * binHz;
    if (hz >= BANDS.low[0] && hz < BANDS.low[1]) bandOf[k] = 0;
    else if (hz >= BANDS.mid[0] && hz < BANDS.mid[1]) bandOf[k] = 1;
    else if (hz >= BANDS.high[0] && hz < BANDS.high[1]) bandOf[k] = 2;
    if (hz >= lo && hz < hi) specBandOf[k] = Math.min(SPEC_BANDS - 1, Math.floor((Math.log(hz / lo) / Math.log(hi / lo)) * SPEC_BANDS));
    if (hz >= 60 && hz < 5000) chromaOf[k] = ((Math.round(12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12;
    if (hz >= 30 && hz < hi) melOf[k] = Math.min(MEL_BANDS - 1, Math.floor(((mel(hz) - melLo) / (melHi - melLo)) * MEL_BANDS));
  }
  // which flux group (low/mid/high) each mel band belongs to, by its center frequency
  const melGroup = new Int8Array(MEL_BANDS);
  for (let m = 0; m < MEL_BANDS; m++) {
    const c = 700 * (10 ** ((melLo + ((m + 0.5) / MEL_BANDS) * (melHi - melLo)) / 2595) - 1);
    melGroup[m] = c < BANDS.low[1] ? 0 : c < BANDS.mid[1] ? 1 : 2;
  }

  const out: Features = {
    energyPow: new Float32Array(frameCount),
    lowPow: new Float32Array(frameCount),
    midPow: new Float32Array(frameCount),
    highPow: new Float32Array(frameCount),
    flux: new Float32Array(frameCount),
    fluxLow: new Float32Array(frameCount),
    fluxMid: new Float32Array(frameCount),
    fluxHigh: new Float32Array(frameCount),
    spec: new Float32Array(frameCount * SPEC_BANDS),
    chroma: new Float32Array(frameCount * 12),
    frameCount,
  };

  let prevLog = new Float32Array(MEL_BANDS);
  let curLog = new Float32Array(MEL_BANDS);
  const melPow = new Float64Array(MEL_BANDS);
  const bandPow = new Float64Array(3);
  const specPow = new Float64Array(SPEC_BANDS);
  const chromaAcc = new Float64Array(12);
  const progressEvery = Math.max(1, Math.floor(frameCount / 50));

  for (let i = 0; i < frameCount; i++) {
    const start = i * hop - N / 2; // frames are centered on i*hop
    let sumSq = 0;
    for (let n = 0; n < N; n++) {
      const idx = start + n;
      const s = idx >= 0 && idx < x.length ? x[idx] : 0;
      sumSq += s * s;
      re[n] = s * win[n];
      im[n] = 0;
    }
    fft.transform(re, im);

    bandPow.fill(0); specPow.fill(0); chromaAcc.fill(0); melPow.fill(0);
    for (let k = 1; k < bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * magNorm;
      const p = mag * mag;
      const b = bandOf[k];
      if (b >= 0) bandPow[b] += p;
      const mb = melOf[k];
      if (mb >= 0) melPow[mb] += p;
      const sb = specBandOf[k];
      if (sb >= 0) specPow[sb] += p;
      const c = chromaOf[k];
      if (c >= 0) chromaAcc[c] += mag;
    }
    // Spectral flux on log-compressed mel bands. Mel spacing keeps broadband hats/noise
    // from drowning out the kick (linear bins over-weight the highs).
    let flux = 0, fl = 0, fm = 0, fh = 0;
    for (let m = 0; m < MEL_BANDS; m++) {
      const lg = Math.log1p(1000 * Math.sqrt(melPow[m]));
      curLog[m] = lg;
      const d = lg - prevLog[m];
      if (d > 0) {
        flux += d;
        const g = melGroup[m];
        if (g === 0) fl += d; else if (g === 1) fm += d; else fh += d;
      }
    }
    out.energyPow[i] = sumSq / N;
    out.lowPow[i] = bandPow[0];
    out.midPow[i] = bandPow[1];
    out.highPow[i] = bandPow[2];
    out.flux[i] = i === 0 ? 0 : flux;
    out.fluxLow[i] = i === 0 ? 0 : fl;
    out.fluxMid[i] = i === 0 ? 0 : fm;
    out.fluxHigh[i] = i === 0 ? 0 : fh;
    for (let s = 0; s < SPEC_BANDS; s++) out.spec[i * SPEC_BANDS + s] = Math.log10(specPow[s] + 1e-10);
    let csum = 0;
    for (let c = 0; c < 12; c++) csum += chromaAcc[c];
    for (let c = 0; c < 12; c++) out.chroma[i * 12 + c] = csum > 1e-6 ? chromaAcc[c] / csum : 0;

    const t = prevLog; prevLog = curLog; curLog = t;
    if (i % progressEvery === 0) progress(i / frameCount);
  }
  return out;
}

// ======================================================================================
// Tempo and beats
// ======================================================================================

interface TempoEstimate { bpm: number; periodFrames: number; confidence: number }

function autocorr(env: Float32Array, from: number, to: number, maxLag: number): Float32Array {
  const ac = new Float32Array(maxLag + 1);
  const m = mean(env, from, to);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = from + lag; i < to; i++) s += (env[i] - m) * (env[i - lag] - m);
    ac[lag] = s / Math.max(1, to - from - lag);
  }
  return ac;
}

function bestLag(ac: Float32Array, minLag: number, maxLag: number, hopSec: number): { lag: number; score: number } {
  let best = -Infinity, bestLagIdx = minLag;
  for (let lag = minLag; lag <= maxLag && 2 * lag < ac.length; lag++) {
    const lagSec = lag * hopSec;
    const prior = Math.exp(-0.5 * (Math.log2(lagSec / 0.5) / 0.9) ** 2); // centered on 120 BPM
    const s = prior * (ac[lag] + 0.5 * ac[2 * lag]);
    if (s > best) { best = s; bestLagIdx = lag; }
  }
  // parabolic interpolation for a fractional lag
  const a = ac[bestLagIdx - 1] ?? ac[bestLagIdx];
  const b = ac[bestLagIdx];
  const c = ac[bestLagIdx + 1] ?? ac[bestLagIdx];
  const denom = a - 2 * b + c;
  const shift = denom < 0 ? clampRange((0.5 * (a - c)) / denom, -0.5, 0.5) : 0;
  return { lag: bestLagIdx + shift, score: best };
}

function estimateTempo(env: Float32Array, hopSec: number): TempoEstimate | null {
  const minLag = Math.floor(60 / 210 / hopSec);
  const maxLag = Math.ceil(60 / 55 / hopSec);
  if (env.length < maxLag * 4) return null;
  const ac = autocorr(env, 0, env.length, 2 * maxLag + 2);
  if (ac[0] <= 0) return null;
  const { lag } = bestLag(ac, minLag, maxLag, hopSec);
  const periodicity = clamp01(ac[Math.round(lag)] / ac[0]);

  // Tempo stability: does the same period win in ~20 s windows across the song?
  const win = Math.round(20 / hopSec);
  let agree = 0, total = 0;
  for (let s = 0; s + win <= env.length; s += Math.round(win / 2)) {
    const wac = autocorr(env, s, s + win, 2 * maxLag + 2);
    if (wac[0] <= 1e-6) continue;
    total++;
    const w = bestLag(wac, minLag, maxLag, hopSec).lag;
    const ratios = [w / lag, (2 * w) / lag, w / (2 * lag)];
    if (ratios.some((r) => Math.abs(r - 1) < 0.04)) agree++;
  }
  const stability = total > 0 ? agree / total : 0.5;
  const confidence = clamp01(0.5 * clamp01((periodicity - 0.05) / 0.3) + 0.5 * stability);
  return { bpm: 60 / (lag * hopSec), periodFrames: lag, confidence };
}

/** Ellis (2007) dynamic-programming beat tracker. Returns beat frame indices. */
function trackBeats(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  const score = new Float32Array(n);
  const prev = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, bestTau = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const d = Math.log((t - tau) / period);
      const s = score[tau] - tightness * d * d;
      if (s > best) { best = s; bestTau = tau; }
    }
    if (bestTau >= 0 && best > 0) { score[t] = env[t] + best; prev[t] = bestTau; }
    else score[t] = env[t];
  }
  let end = n - 1, bestEnd = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > bestEnd) { bestEnd = score[t]; end = t; }
  const out: number[] = [];
  for (let t = end; t >= 0; t = prev[t]) out.push(t);
  return out.reverse();
}

/** Drop grid beats before the first and after the last real musical activity. */
function trimToActivity(beats: number[], env: Float32Array, period: number): number[] {
  const thr = percentile(env, 90) * 0.3;
  let first = 0, last = env.length - 1;
  while (first < env.length && env[first] < thr) first++;
  while (last > 0 && env[last] < thr) last--;
  return beats.filter((b) => b >= first - period / 2 && b <= last + period / 2);
}

/** Least-squares slope through beat times → more precise BPM than the autocorrelation lag. */
function refineBpm(beatFrames: number[], hopSec: number): number | null {
  const n = beatFrames.length;
  if (n < 4) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const y = beatFrames[i] * hopSec; sx += i; sy += y; sxx += i * i; sxy += i * y; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  return slope > 0 ? 60 / slope : null;
}

function labelBeats(
  frames: number[],
  env: Float32Array,
  lowEnv: Float32Array,
  midEnv: Float32Array,
  energy: Float32Array,
  chroma: Float32Array,
  hopSec: number,
): Beat[] {
  const at = (x: Float32Array, i: number) => Math.max(x[i] ?? 0, x[i - 1] ?? 0, x[i + 1] ?? 0);
  // Downbeat phase: bass onsets and harmonic changes tend to land on beat 1.
  const phaseScore = [0, 0, 0, 0];
  const beatChroma = frames.map((f, k) => {
    const end = frames[k + 1] ?? f + 1;
    const c = new Float32Array(12);
    for (let i = f; i < end; i++) for (let j = 0; j < 12; j++) c[j] += chroma[i * 12 + j] ?? 0;
    return c;
  });
  for (let k = 1; k < frames.length; k++) {
    const fr = frames[k];
    const change = 1 - cosine(beatChroma[k], beatChroma[k - 1]);
    // energy rising into this beat (section starts / drops land on downbeats)
    const span = Math.max(1, fr - frames[k - 1]);
    const rise = Math.max(0, mean(energy, fr, fr + span) - mean(energy, fr - span, fr));
    // backbeat: snares on 2 and 4 count against being beat 1
    phaseScore[k % 4] += at(lowEnv, fr) + 4 * change + 6 * rise - 0.5 * at(midEnv, fr);
  }
  const phase = phaseScore.indexOf(Math.max(...phaseScore));
  const strengthNorm = percentile(Float32Array.from(frames, (fr) => at(env, fr)), 95) || 1;
  return frames.map((fr, k) => {
    const rel = k - phase;
    const beatInBar = ((rel % 4) + 4) % 4;
    return {
      t: round3((fr + BEAT_TIME_OFFSET_FRAMES) * hopSec),
      index: k,
      beatInBar,
      barIndex: Math.floor(rel / 4),
      strength: round3(clamp01(at(env, fr) / strengthNorm)),
    };
  });
}

// ======================================================================================
// Structure
// ======================================================================================

function segment(f: Features, blockFrames: number, blockHop: number, duration: number) {
  const nb = Math.max(1, Math.ceil(f.frameCount / blockFrames));
  const dims = SPEC_BANDS + 12 + 1;
  const feat = new Float32Array(nb * dims);
  for (let b = 0; b < nb; b++) {
    const a = b * blockFrames, e = Math.min(f.frameCount, a + blockFrames);
    const cnt = Math.max(1, e - a);
    for (let i = a; i < e; i++) {
      for (let s = 0; s < SPEC_BANDS; s++) feat[b * dims + s] += f.spec[i * SPEC_BANDS + s] / cnt;
      for (let c = 0; c < 12; c++) feat[b * dims + SPEC_BANDS + c] += f.chroma[i * 12 + c] / cnt;
      feat[b * dims + dims - 1] += (10 * Math.log10(f.energyPow[i] + 1e-10)) / cnt;
    }
  }
  // z-score per dimension
  for (let d = 0; d < dims; d++) {
    const col = new Float32Array(nb);
    for (let b = 0; b < nb; b++) col[b] = feat[b * dims + d];
    const m = mean(col), s = std(col) || 1;
    for (let b = 0; b < nb; b++) feat[b * dims + d] = (feat[b * dims + d] - m) / s;
  }
  const norms = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0;
    for (let d = 0; d < dims; d++) s += feat[b * dims + d] ** 2;
    norms[b] = Math.sqrt(s) || 1;
  }
  const sim = (i: number, j: number) => {
    let s = 0;
    for (let d = 0; d < dims; d++) s += feat[i * dims + d] * feat[j * dims + d];
    return s / (norms[i] * norms[j]);
  };

  // Foote novelty with a Gaussian-tapered checkerboard kernel (computed on the fly)
  const L = Math.max(2, Math.round(8 / blockHop)); // 8 s half-width
  const novelty = new Float32Array(nb);
  for (let c = 0; c < nb; c++) {
    let s = 0, wsum = 0;
    for (let i = -L; i < L; i++) {
      const bi = c + i;
      if (bi < 0 || bi >= nb) continue;
      for (let j = -L; j < L; j++) {
        const bj = c + j;
        if (bj < 0 || bj >= nb) continue;
        const sign = (i < 0) === (j < 0) ? 1 : -1;
        const g = Math.exp(-((i + 0.5) ** 2 + (j + 0.5) ** 2) / (2 * (L / 2) ** 2));
        s += sign * g * sim(bi, bj);
        wsum += g;
      }
    }
    novelty[c] = wsum > 0 ? Math.max(0, s / wsum) : 0;
  }
  const nmax = Math.max(...novelty) || 1;
  for (let i = 0; i < nb; i++) novelty[i] /= nmax;

  const peaks = pickPeaks(novelty, {
    maxRadius: Math.round(6 / blockHop),
    meanRadius: Math.round(16 / blockHop),
    delta: 0.08,
    minGap: Math.round(8 / blockHop),
  });
  const boundaries = peaks
    .map((p) => p * blockHop)
    .filter((t) => t > 4 && t < duration - 4);
  return { novelty, boundaries };
}

function buildSections(bounds: number[], duration: number, energy: Float32Array, hopSec: number): Section[] {
  const edges = [0, ...bounds, duration];
  const out: Section[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i], end = edges[i + 1];
    const e = mean(energy, Math.floor(start / hopSec), Math.ceil(end / hopSec));
    out.push({
      start: round3(start),
      end: round3(end),
      index: i,
      energy: round3(e),
      intensity: e < 0.35 ? 'low' : e < 0.65 ? 'mid' : 'high',
    });
  }
  return out;
}

function findDrops(
  energy: Float32Array,
  low: Float32Array,
  high: Float32Array,
  hopSec: number,
  duration: number,
  beats: Beat[],
): Drop[] {
  const fr = (s: number) => Math.round(s / hopSec);
  const E = movingAverage(energy, fr(0.15));
  const LB = movingAverage(low, fr(0.15));
  const step = fr(0.25);
  const cands: { i: number; score: number }[] = [];
  for (let i = fr(4); i < E.length - fr(4); i += step) {
    // A drop = the bass comes in hard and stays, at (near-)full loudness.
    // Builds are often already loud, so overall energy alone is not enough.
    const jump = mean(E, i, i + fr(3)) - mean(E, i - fr(2), i);
    const postLow = mean(LB, i, i + fr(3));
    const lowJump = postLow - mean(LB, i - fr(2), i);
    const sustainedE = mean(E, i, i + fr(8));
    const sustainedLow = mean(LB, i, i + fr(8));
    if (postLow < 0.75 || sustainedLow < 0.75 || sustainedE < 0.65) continue;
    if (jump < 0.15 && lowJump < 0.15) continue;
    cands.push({ i, score: Math.max(0, lowJump) + Math.max(0, jump) });
  }
  // non-maximum suppression within ±10 s
  cands.sort((a, b) => b.score - a.score);
  const picked: { i: number; score: number }[] = [];
  for (const c of cands) if (picked.every((p) => Math.abs(p.i - c.i) > fr(10))) picked.push(c);
  picked.sort((a, b) => a.i - b.i);

  // brightness+energy curve for build detection
  const B = movingAverage(Float32Array.from(energy, (v, k) => 0.5 * v + 0.5 * high[k]), fr(1));
  return picked.map(({ i, score }) => {
    // exact onset: largest bass rise within ±1 s (bass curve is faster than overall energy)
    let bestI = i, bestD = -Infinity;
    for (let k = i - fr(1); k <= i + fr(1); k++) {
      const d = (LB[k + fr(0.1)] ?? 0) - (LB[k - fr(0.1)] ?? 0);
      if (d > bestD) { bestD = d; bestI = k; }
    }
    const t = snapToGrid(bestI * hopSec, beats, 'beat', 0.6);
    // build: walk back from the peak just before the drop while the curve keeps falling
    let peak = fr(t - 0.25), peakV = -Infinity;
    for (let k = fr(t - 3); k <= fr(t - 0.25); k++) if ((B[k] ?? -1) > peakV) { peakV = B[k]; peak = k; }
    let k = peak;
    const stepBack = fr(0.5);
    while (k - stepBack > 0 && peak - k < fr(32) && B[k - stepBack] <= B[k] + 0.02) k -= stepBack;
    const rise = B[peak] - B[k];
    const buildStart = (peak - k) * hopSec >= 3 && rise >= 0.12 ? round3(snapToGrid(k * hopSec, beats, 'downbeat', 1.5)) : null;
    return { t: round3(Math.min(t, duration)), buildStart, intensity: round3(clamp01(score / 0.7)) };
  });
}

function findQuiet(energy: Float32Array, hopSec: number, duration: number): Span[] {
  const E = movingAverage(energy, Math.round(0.5 / hopSec));
  const spans: Span[] = [];
  let start = -1;
  for (let i = 0; i <= E.length; i++) {
    const q = i < E.length && E[i] < 0.22;
    if (q && start < 0) start = i;
    if (!q && start >= 0) { spans.push({ start: start * hopSec, end: Math.min(duration, i * hopSec) }); start = -1; }
  }
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < 1) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.end - s.start >= 3).map((s) => ({ start: round3(s.start), end: round3(s.end) }));
}

// ======================================================================================
// Helpers
// ======================================================================================

function snapToGrid(t: number, beats: Beat[], to: 'beat' | 'downbeat', maxDist: number): number {
  let best = t, bestD = maxDist;
  for (const b of beats) {
    if (to === 'downbeat' && b.beatInBar !== 0) continue;
    const d = Math.abs(b.t - t);
    if (d < bestD) { bestD = d; best = b.t; }
  }
  return best;
}

function dedupeSorted(xs: number[], minGap: number): number[] {
  const out: number[] = [];
  for (const x of [...xs].sort((a, b) => a - b)) if (!out.length || x - out[out.length - 1] >= minGap) out.push(x);
  return out;
}

function mixdown(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

function computeWaveform(x: Float32Array, sr: number) {
  const per = sr / WAVEFORM_PEAKS_PER_SEC;
  const n = Math.ceil(x.length / per);
  const min = new Float32Array(n), max = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    let lo = 0, hi = 0;
    const a = Math.floor(p * per), b = Math.min(x.length, Math.floor((p + 1) * per));
    for (let i = a; i < b; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[p] = lo; max[p] = hi;
  }
  return { peaksPerSec: WAVEFORM_PEAKS_PER_SEC, min, max };
}

function smooth3(x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = 0.25 * (x[i - 1] ?? x[i]) + 0.5 * x[i] + 0.25 * (x[i + 1] ?? x[i]);
  return out;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 1;
}

const clampRange = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
