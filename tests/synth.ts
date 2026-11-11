/** Deterministic synthetic test tracks with known ground truth. */
export const SR = 44100;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

function addKick(out: Float32Array, t: number, gain = 0.9) {
  const start = Math.round(t * SR);
  let phase = 0;
  for (let i = 0; i < SR * 0.25 && start + i < out.length; i++) {
    const tt = i / SR;
    const f = 45 + 110 * Math.exp(-tt * 30);
    phase += (2 * Math.PI * f) / SR;
    out[start + i] += gain * Math.sin(phase) * Math.exp(-tt * 12);
  }
}

function addNoiseHit(out: Float32Array, t: number, dur: number, gain: number, rand: () => number, hp = false) {
  const start = Math.round(t * SR);
  let prev = 0;
  for (let i = 0; i < SR * dur && start + i < out.length; i++) {
    const n = rand();
    const v = hp ? n - prev : n; // crude high-pass for hats
    prev = n;
    out[start + i] += gain * v * Math.exp((-i / SR) * (4 / dur));
  }
}

function addTone(out: Float32Array, t0: number, t1: number, hz: number, gain: number) {
  const a = Math.round(t0 * SR), b = Math.min(out.length, Math.round(t1 * SR));
  for (let i = a; i < b; i++) {
    const env = Math.min(1, (i - a) / (SR * 0.3), (b - i) / (SR * 0.3));
    out[i] += gain * env * Math.sin((2 * Math.PI * hz * i) / SR);
  }
}

export interface SynthTrack {
  audio: Float32Array;
  bpm: number;
  beats: number[];
  drops: number[];
  quiet: [number, number][];
}

/** Four-on-the-floor EDM-style: intro pad, build, drop, breakdown, drop. */
export function edmTrack(bpm = 128): SynthTrack {
  const beat = 60 / bpm, bar = 4 * beat;
  const offset = 0.37; // first beat not at 0
  const bars = { intro: 8, build: 8, drop1: 16, breakdown: 8, build2: 4, drop2: 16 };
  const total = Object.values(bars).reduce((a, b) => a + b, 0);
  const dur = offset + total * bar + 2;
  const out = new Float32Array(Math.ceil(dur * SR));
  const rand = rng(1);
  const beats: number[] = [];
  const drops: number[] = [];
  const quiet: [number, number][] = [];
  let t = offset;
  const pad = (t0: number, t1: number, g: number) => {
    addTone(out, t0, t1, 220, g); addTone(out, t0, t1, 277.2, g); addTone(out, t0, t1, 329.6, g);
  };
  const section = (name: keyof typeof bars) => {
    const n = bars[name];
    const t0 = t;
    for (let b = 0; b < n * 4; b++) {
      const bt = t + b * beat;
      const progress = b / (n * 4);
      if (name === 'intro') {
        if (b % 4 === 0) addNoiseHit(out, bt, 0.05, 0.05, rand, true);
      } else if (name === 'build' || name === 'build2') {
        addKick(out, bt, 0.3);
        const sub = progress < 0.5 ? 2 : 4;
        for (let s = 0; s < sub; s++) addNoiseHit(out, bt + (s * beat) / sub, 0.08, 0.1 + 0.4 * progress, rand);
      } else if (name === 'drop1' || name === 'drop2') {
        addKick(out, bt, 0.95);
        if (b % 2 === 1) addNoiseHit(out, bt, 0.15, 0.45, rand);
        addNoiseHit(out, bt + beat / 2, 0.04, 0.25, rand, true);
        addTone(out, bt + beat / 2, bt + beat * 0.95, 55, 0.35);
      } else if (name === 'breakdown') {
        if (b % 8 === 0) addNoiseHit(out, bt, 0.05, 0.03, rand, true);
      }
      if (name !== 'intro' && name !== 'breakdown') beats.push(bt);
    }
    const t1 = t + n * bar;
    if (name === 'intro' || name === 'breakdown') { pad(t0, t1, 0.05); quiet.push([t0, t1]); }
    else pad(t0, t1, 0.08);
    if (name === 'drop1' || name === 'drop2') drops.push(t0);
    t = t1;
  };
  (Object.keys(bars) as (keyof typeof bars)[]).forEach(section);
  return { audio: out, bpm, beats, drops, quiet };
}

/** Slow hip-hop groove with swung hats; no drops. */
export function hiphopTrack(bpm = 88): SynthTrack {
  const beat = 60 / bpm;
  const dur = 70;
  const out = new Float32Array(dur * SR);
  const rand = rng(2);
  const beats: number[] = [];
  for (let b = 0, bt = 0.5; bt < dur - 1; b++, bt = 0.5 + b * beat) {
    beats.push(bt);
    if (b % 4 === 0 || b % 4 === 2 || b % 8 === 7) addKick(out, b % 8 === 7 ? bt + beat * 0.5 : bt, 0.8);
    if (b % 2 === 1) addNoiseHit(out, bt, 0.18, 0.4, rand);
    addNoiseHit(out, bt, 0.03, 0.12, rand, true);
    addNoiseHit(out, bt + beat * 0.62, 0.03, 0.09, rand, true); // swing
    addTone(out, bt, bt + beat * 0.8, b % 8 < 4 ? 65.4 : 73.4, 0.25);
  }
  return { audio: out, bpm, beats, drops: [], quiet: [] };
}

/** Beatless ambient: slowly evolving pad and noise. Should trigger fallback mode. */
export function ambientTrack(): SynthTrack {
  const dur = 60;
  const out = new Float32Array(dur * SR);
  const rand = rng(3);
  let lp = 0;
  for (let i = 0; i < out.length; i++) {
    const tt = i / SR;
    lp += 0.02 * (rand() - lp);
    const swell = 0.5 + 0.5 * Math.sin(tt * 0.21);
    out[i] = 0.15 * swell * (Math.sin(2 * Math.PI * 196 * tt) + 0.6 * Math.sin(2 * Math.PI * 293.7 * tt + Math.sin(tt * 0.7))) + 0.3 * lp;
  }
  return { audio: out, bpm: 0, beats: [], drops: [], quiet: [] };
}
