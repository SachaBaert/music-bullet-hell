/**
 * Pattern generator: Chart → Plan (milestone 2).
 *
 * Pure and deterministic: the same chart (same `meta.fileHash`) always gives the same plan.
 * Every bullet moves in a straight line, so its position is a pure function of song time:
 *   p(t) = p0 + v * (t - t0)   for t0 <= t < t1
 * That makes the game seek-proof and lets us schedule bullets so they ARRIVE on the beat:
 * we pick the arrival time (a beat subdivision or an onset) and work backwards to the spawn time.
 *
 * Mapping (design doc §5):
 *  - low band (kick)    → rings from the top emitter; the ring reaches the target on the kick
 *  - mid band (snare)   → per section either aimed bursts (side emitters) or a spiral
 *  - high band (hats)   → one stream emitter following the song's regularized hat sub-rhythm
 *  - energy             → density (ring size, bursts per bar, arms, stream thinning) and speed
 *  - sections           → new emitter layout and pattern style, seeded per section
 *  - quiet / very low energy → breathers: only a sparse, slow ring every other bar
 */
import { sampleCurve, type Chart, type Span } from '../chart/types';
import { BeatGrid, maskFromShare, nearestDistance, rhythmShare } from './grid';
import { rngFor } from './rng';

export const ARENA = { w: 600, h: 800 } as const;
export const TARGET = { x: 300, y: 640 } as const;

export type EventKind = 'ring' | 'burst' | 'spiral' | 'stream';
export const KINDS: EventKind[] = ['ring', 'burst', 'spiral', 'stream'];

export interface Point { x: number; y: number }

export interface PlanEvent {
  kind: EventKind;
  /** Song time at which the pattern reaches the target distance (the beat / onset it lands on). */
  arrival: number;
  /** Song time at which the bullets leave the emitter. */
  spawn: number;
  /** Emitter position at spawn time. */
  x: number;
  y: number;
  count: number;
  section: number;
  /** Density 0..1 used for this event (energy scaled by difficulty). */
  density: number;
}

export interface SectionStyle {
  index: number;
  start: number;
  end: number;
  intensity: 'low' | 'mid' | 'high';
  ringEmitter: Point;
  /** 'aimed': a bullet passes through the target; 'split': the target sits between two bullets. */
  ringOffset: 'aimed' | 'split' | 'alternate';
  midStyle: 'burst' | 'spiral';
  midEmitters: [Point, Point];
  spiral: Point & { armsBase: number; dir: 1 | -1; revPerBar: number; phase: number };
  stream: { cx: number; y: number; amp: number; periodSec: number; phase: number };
  /** Sixteenth positions (0..15) used per band in this section; empty in fallback mode. */
  masks: { low: number[]; mid: number[]; high: number[] };
}

/** Struct-of-arrays, sorted by spawn time t0. */
export interface Bullets {
  count: number;
  t0: Float64Array;
  t1: Float64Array;
  x0: Float32Array;
  y0: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  r: Float32Array;
  /** Index into KINDS. */
  kind: Uint8Array;
}

export interface Plan {
  arena: typeof ARENA;
  target: typeof TARGET;
  mode: Chart['mode'];
  difficulty: number;
  /** Sorted by arrival. */
  events: PlanEvent[];
  bullets: Bullets;
  sections: SectionStyle[];
  /** Spans where the generator deliberately goes (almost) silent. */
  breathers: Span[];
  /** Longest bullet lifetime, for windowed lookups. */
  maxLife: number;
}

export interface PlanOptions {
  /** 0..1, the ceiling on density and speed. Default 0.7. */
  difficulty?: number;
}

const SPEED: Record<EventKind, [number, number]> = {
  ring: [120, 210],
  burst: [190, 300],
  spiral: [140, 230],
  stream: [300, 450],
};
const RADIUS: Record<EventKind, number> = { ring: 9, burst: 6, spiral: 5.5, stream: 3.5 };

/** Band must be at least this loud (per-track normalized) for its layer to fire. */
const GATE = { low: 0.3, mid: 0.3, high: 0.35 };
/** Below this normalized energy we treat the music as a breather even outside detected quiet spans. */
const BREATHER_ENERGY = 0.12;
const BREATHER_MIN_SEC = 1.5;
/** Don't spawn anything this close to the song start. */
const MIN_SPAWN = 0.05;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
const TAU = Math.PI * 2;

interface RawBullet { t0: number; t1: number; x0: number; y0: number; vx: number; vy: number; r: number; kind: number }

export function generatePlan(chart: Chart, opts: PlanOptions = {}): Plan {
  const difficulty = clamp01(opts.difficulty ?? 0.7);
  const hash = chart.meta.fileHash || 'no-hash';
  const { curves } = chart;
  const dur = chart.meta.durationSec;
  const at = (c: Float32Array, t: number) => sampleCurve(c, curves.hopSec, t);

  // Without a trustworthy grid the onsets are noisier too, so fallback mode plays it calmer.
  const modeScale = chart.mode === 'fallback' ? 0.6 : 1;
  const density = (t: number) => clamp01((at(curves.energy, t) - 0.15) / 0.75) * (0.5 + 0.5 * difficulty) * modeScale;
  // Breathers = detected quiet spans + sustained (>= BREATHER_MIN_SEC) very low energy.
  // Short dips between hits don't count, otherwise sparse grooves would flicker in and out.
  const breathers: Span[] = chart.quiet.map((q) => ({ ...q }));
  for (let t = 0, open = -1; t <= dur + 0.05; t += 0.05) {
    const low = t < dur && at(curves.energy, t) < BREATHER_ENERGY;
    if (low && open < 0) open = t;
    if (!low && open >= 0) {
      if (t - open >= BREATHER_MIN_SEC) breathers.push({ start: open, end: Math.min(t, dur) });
      open = -1;
    }
  }
  breathers.sort((a, b) => a.start - b.start);
  for (let i = 1; i < breathers.length; i++) {
    if (breathers[i].start <= breathers[i - 1].end) {
      breathers[i - 1].end = Math.max(breathers[i - 1].end, breathers[i].end);
      breathers.splice(i--, 1);
    }
  }
  const isBreather = (t: number) => breathers.some((q) => t >= q.start && t < q.end);

  const grid = chart.mode === 'full' && chart.beats.length >= 8 ? new BeatGrid(chart.beats, chart.tempo?.beatsPerBar ?? 4) : null;
  const barSec = grid && chart.tempo ? (60 / chart.tempo.bpm) * grid.beatsPerBar : 2;

  // ---------------------------------------------------------------- per-section styles
  const globalShare = grid
    ? {
        low: rhythmShare(grid, chart.onsets.low, 0, dur).share,
        mid: rhythmShare(grid, chart.onsets.mid, 0, dur).share,
        high: rhythmShare(grid, chart.onsets.high, 0, dur).share,
      }
    : null;

  const sections: SectionStyle[] = chart.sections.map((sec) => {
    const rng = rngFor(hash, `s${sec.index}:style`);
    let masks = { low: [] as number[], mid: [] as number[], high: [] as number[] };
    if (grid && globalShare) {
      const pick = (band: 'low' | 'mid' | 'high', minShare: number, max: number, fallback: number[]) => {
        const local = rhythmShare(grid, chart.onsets[band], sec.start, sec.end);
        const share = local.bars >= 2 ? local.share : globalShare[band];
        const m = maskFromShare(share, minShare, max);
        // order by strength so density can keep "the most important" steps first
        const ranked = m.slice().sort((a, b) => share[b] - share[a] || a - b);
        return ranked.length ? ranked : fallback;
      };
      masks = {
        low: pick('low', 0.3, 8, [0, 8]),
        mid: pick('mid', 0.3, 6, [4, 12]),
        high: pick('high', 0.25, 8, [2, 6, 10, 14]),
      };
    }
    const xL = rng.range(70, 150);
    const midY = rng.range(170, 300);
    // A clear backbeat (few strong mid steps) reads as aimed bursts; busy mids (vocals, fills) as a spiral.
    const spiralChance = grid ? 0.2 + 0.5 * clamp01((masks.mid.length - 2) / 4) : 0;
    return {
      index: sec.index,
      start: sec.start,
      end: sec.end,
      intensity: sec.intensity,
      ringEmitter: { x: rng.range(210, 390), y: rng.range(100, 170) },
      ringOffset: rng.pick(['aimed', 'split', 'alternate'] as const),
      midStyle: rng.chance(spiralChance) ? 'spiral' : 'burst',
      midEmitters: [{ x: xL, y: midY }, { x: ARENA.w - xL, y: midY + rng.range(-40, 40) }],
      spiral: {
        x: rng.range(220, 380),
        y: rng.range(200, 290),
        armsBase: rng.int(2, 3),
        dir: rng.sign() as 1 | -1,
        revPerBar: rng.pick([0.25, 0.375, 0.5]),
        phase: rng.range(0, TAU),
      },
      stream: { cx: ARENA.w / 2, y: rng.range(55, 90), amp: rng.range(120, 220), periodSec: barSec * rng.pick([1, 2, 4]), phase: rng.range(0, TAU) },
      masks,
    } satisfies SectionStyle;
  });
  const sectionAt = (t: number) => {
    for (let i = sections.length - 1; i >= 0; i--) if (t >= sections[i].start) return sections[i];
    return sections[0];
  };

  // ---------------------------------------------------------------- emitters → bullets
  const events: PlanEvent[] = [];
  const raw: RawBullet[] = [];
  const counters = new Map<number, { ring: number; burst: number }>();
  const counter = (s: number) => {
    let c = counters.get(s);
    if (!c) counters.set(s, (c = { ring: 0, burst: 0 }));
    return c;
  };

  const exitTime = (x: number, y: number, vx: number, vy: number) => {
    const m = 40;
    const tx = vx > 0 ? (ARENA.w + m - x) / vx : vx < 0 ? (-m - x) / vx : Infinity;
    const ty = vy > 0 ? (ARENA.h + m - y) / vy : vy < 0 ? (-m - y) / vy : Infinity;
    return Math.min(tx, ty, 12);
  };

  /** Fire `angles` from E so that bullets are `dist` away from E at `arrival`. */
  const fire = (kind: EventKind, style: SectionStyle, E: Point, arrival: number, angles: number[], speed: number, d: number) => {
    const dist = Math.hypot(TARGET.x - E.x, TARGET.y - E.y);
    const spawn = arrival - dist / speed;
    if (spawn < MIN_SPAWN || arrival > dur) return false;
    const k = KINDS.indexOf(kind);
    for (const a of angles) {
      const vx = Math.cos(a) * speed, vy = Math.sin(a) * speed;
      raw.push({ t0: spawn, t1: spawn + exitTime(E.x, E.y, vx, vy), x0: E.x, y0: E.y, vx, vy, r: RADIUS[kind], kind: k });
    }
    events.push({ kind, arrival, spawn, x: E.x, y: E.y, count: angles.length, section: style.index, density: d });
    return true;
  };
  const aimFrom = (E: Point) => Math.atan2(TARGET.y - E.y, TARGET.x - E.x);
  const speedOf = (kind: EventKind, d: number) => lerp(SPEED[kind][0], SPEED[kind][1], d);

  const ring = (style: SectionStyle, t: number, d: number, breather: boolean) => {
    const n = breather ? 6 : Math.round(lerp(8, 22, d));
    const c = counter(style.index);
    const off = style.ringOffset === 'aimed' ? 0 : style.ringOffset === 'split' ? 0.5 : (c.ring % 2) * 0.5;
    const aim = aimFrom(style.ringEmitter);
    const angles = Array.from({ length: n }, (_, k) => aim + ((k + off) * TAU) / n);
    if (fire('ring', style, style.ringEmitter, t, angles, breather ? SPEED.ring[0] * 0.85 : speedOf('ring', d), d)) c.ring++;
  };

  const burst = (style: SectionStyle, t: number, d: number) => {
    const c = counter(style.index);
    const E = style.midEmitters[c.burst % 2];
    const n = 3 + 2 * Math.round(2 * d); // 3, 5 or 7
    const spread = lerp(0.35, 0.75, d);
    const aim = aimFrom(E);
    const angles = Array.from({ length: n }, (_, k) => aim + (k / (n - 1) - 0.5) * spread);
    if (fire('burst', style, E, t, angles, speedOf('burst', d), d)) c.burst++;
  };

  const spiral = (style: SectionStyle, t: number, beatPos: number, d: number) => {
    const s = style.spiral;
    const arms = s.armsBase + Math.round(2 * d);
    const beatsPerBar = grid?.beatsPerBar ?? 4;
    const base = s.phase + s.dir * TAU * s.revPerBar * (beatPos / beatsPerBar);
    const angles = Array.from({ length: arms }, (_, k) => base + (k * TAU) / arms);
    fire('spiral', style, s, t, angles, speedOf('spiral', d), d);
  };

  const streamPos = streamEmitterAt;
  const stream = (style: SectionStyle, t: number, d: number) => {
    // The emitter moves, so find the spawn time whose emitter position gives the right travel time.
    const v = speedOf('stream', d);
    let spawn = t - Math.hypot(TARGET.x - streamPos(style, t).x, TARGET.y - style.stream.y) / v;
    for (let i = 0; i < 4; i++) {
      const E = streamPos(style, spawn);
      spawn = t - Math.hypot(TARGET.x - E.x, TARGET.y - E.y) / v;
    }
    const E = streamPos(style, spawn);
    const dist = Math.hypot(TARGET.x - E.x, TARGET.y - E.y);
    fire('stream', style, E, t, [aimFrom(E)], dist / (t - spawn), d);
  };

  if (grid) {
    for (let s = grid.firstStepAtOrAfter(0); s < grid.stepCount; s++) {
      const t = grid.stepTime(s);
      if (t >= dur) break;
      const style = sectionAt(t);
      const k = grid.stepInBar(s);
      const bar = grid.barOf(s);
      const d = density(t);
      const breather = isBreather(t);
      const tol = Math.min(0.045, 0.35 * grid.stepDur(s));

      // Kick → rings. In breathers: one slow sparse ring on the downbeat of every other bar.
      if (breather) {
        if (k === 0 && bar % 2 === 0 && at(curves.energy, t) > 0.02) ring(style, t, 0, true);
      } else {
        const allowed = d < 0.3 ? 1 : d < 0.6 ? 2 : 4;
        const rank = style.masks.low.indexOf(k);
        const kickHere = nearestDistance(chart.onsets.low, t) < tol || at(curves.low, t) > 0.6;
        if (rank >= 0 && rank < allowed && kickHere && at(curves.low, t) > GATE.low) ring(style, t, d, false);
      }
      if (breather) continue;

      // Mids → aimed bursts on the snare positions, or a spiral quantized to the grid.
      if (at(curves.mid, t) > GATE.mid) {
        if (style.midStyle === 'burst') {
          const allowed = d < 0.3 ? 1 : d < 0.6 ? 2 : 6;
          const rank = style.masks.mid.indexOf(k);
          if (rank >= 0 && rank < allowed) burst(style, t, d);
        } else if (k % (d < 0.45 ? 4 : 2) === 0) {
          spiral(style, t, s / 4, d);
        }
      }

      // Highs → one stream on the regularized hat sub-rhythm, thinned by energy.
      if (at(curves.high, t) > GATE.high) {
        const m = style.masks.high;
        const allowed = Math.ceil(m.length * (0.35 + 0.65 * d));
        const rank = m.indexOf(k);
        if (rank >= 0 && rank < allowed) stream(style, t, d);
      }
    }
  } else {
    // Fallback: no beat grid. Follow onsets directly, thinned by a minimum gap that shrinks with energy.
    const follow = (onsets: number[], gap: (d: number, breather: boolean) => number, gate: number, curve: Float32Array, emit: (style: SectionStyle, t: number, d: number, breather: boolean) => void) => {
      let last = -Infinity;
      for (const t of onsets) {
        const d = density(t);
        const breather = isBreather(t);
        const g = gap(d, breather);
        if (!Number.isFinite(g) || t - last < g || at(curve, t) <= gate) continue;
        emit(sectionAt(t), t, d, breather);
        last = t;
      }
    };
    follow(chart.onsets.low, (d, b) => (b ? 4 : lerp(2.4, 0.8, d)), GATE.low, curves.low, (st, t, d, b) => ring(st, t, d, b));
    follow(chart.onsets.mid, (d, b) => (b ? Infinity : lerp(3, 1, d)), GATE.mid, curves.mid, (st, t, d) => burst(st, t, d));
    follow(chart.onsets.high, (d, b) => (b ? Infinity : lerp(1, 0.25, d)), GATE.high, curves.high, (st, t, d) => stream(st, t, d));
  }

  // ---------------------------------------------------------------- pack
  raw.sort((a, b) => a.t0 - b.t0);
  const n = raw.length;
  const bullets: Bullets = {
    count: n,
    t0: new Float64Array(n), t1: new Float64Array(n),
    x0: new Float32Array(n), y0: new Float32Array(n),
    vx: new Float32Array(n), vy: new Float32Array(n),
    r: new Float32Array(n), kind: new Uint8Array(n),
  };
  let maxLife = 0;
  raw.forEach((b, i) => {
    bullets.t0[i] = b.t0; bullets.t1[i] = b.t1;
    bullets.x0[i] = b.x0; bullets.y0[i] = b.y0;
    bullets.vx[i] = b.vx; bullets.vy[i] = b.vy;
    bullets.r[i] = b.r; bullets.kind[i] = b.kind;
    maxLife = Math.max(maxLife, b.t1 - b.t0);
  });
  events.sort((a, b) => a.arrival - b.arrival);

  return { arena: ARENA, target: TARGET, mode: chart.mode, difficulty, events, bullets, sections, breathers, maxLife };
}

/** Stream emitter position at time t (it sways on a bar-locked period). */
export function streamEmitterAt(style: SectionStyle, t: number): Point {
  return {
    x: style.stream.cx + style.stream.amp * Math.sin((TAU * t) / style.stream.periodSec + style.stream.phase),
    y: style.stream.y,
  };
}

