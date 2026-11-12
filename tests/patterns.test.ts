import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/analyze';
import { sampleCurve, type Chart } from '../src/chart/types';
import { BeatGrid, METRIC_STRONG, maskFromShare } from '../src/game/grid';
import { KINDS, TARGET, generatePlan, type Plan } from '../src/game/patterns';
import { SR, ambientTrack, edmTrack, hiphopTrack } from './synth';

const charts = new Map<string, Chart>();
function chartOf(name: 'edm' | 'hiphop' | 'ambient', hash = 'a1b2c3'): Chart {
  const key = `${name}:${hash}`;
  if (!charts.has(key)) {
    const track = name === 'edm' ? edmTrack(128) : name === 'hiphop' ? hiphopTrack(88) : ambientTrack();
    charts.set(key, analyze([track.audio], SR, { fileHash: hash, fileName: `${name}.wav` }).chart);
  }
  return charts.get(key)!;
}

/** Bullets (indices) that belong to an event: same spawn time and same origin. */
function bulletsOf(plan: Plan, ev: Plan['events'][number]) {
  const b = plan.bullets, out: number[] = [];
  for (let i = 0; i < b.count; i++) if (b.t0[i] === ev.spawn && Math.abs(b.x0[i] - ev.x) < 1e-3 && Math.abs(b.y0[i] - ev.y) < 1e-3) out.push(i);
  return out;
}

function arrivalsPerSec(plan: Plan, start: number, end: number) {
  const n = plan.events.filter((e) => e.arrival >= start && e.arrival < end).reduce((s, e) => s + e.count, 0);
  return n / Math.max(1e-6, end - start);
}

describe('generatePlan()', () => {
  it('is deterministic per file hash and differs between hashes', () => {
    const a = generatePlan(chartOf('edm'));
    const b = generatePlan(chartOf('edm'));
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(Array.from(a.bullets.vx)).toEqual(Array.from(b.bullets.vx));
    const c = generatePlan(chartOf('edm', 'ffff0000'));
    expect(JSON.stringify(c.sections)).not.toBe(JSON.stringify(a.sections));
  });

  it('schedules every pattern to arrive exactly on a grid step, at the target distance', () => {
    const chart = chartOf('edm');
    const plan = generatePlan(chart);
    const grid = new BeatGrid(chart.beats);
    const steps = Array.from({ length: grid.stepCount }, (_, s) => grid.stepTime(s));
    expect(plan.events.length).toBeGreaterThan(50);
    for (const ev of plan.events) {
      expect(ev.spawn).toBeGreaterThan(0);
      expect(ev.spawn).toBeLessThan(ev.arrival);
      expect(Math.min(...steps.map((t) => Math.abs(t - ev.arrival)))).toBeLessThan(1e-9);
    }
    // geometry: every bullet of an event is exactly |target - emitter| away from it at arrival,
    // and aimed kinds actually hit the target dot on the beat
    const dt = (i: number, t: number) => t - plan.bullets.t0[i];
    for (const ev of plan.events.filter((_, i) => i % 7 === 0)) {
      const ids = bulletsOf(plan, ev);
      expect(ids.length).toBe(ev.count);
      const dist = Math.hypot(TARGET.x - ev.x, TARGET.y - ev.y);
      for (const i of ids) {
        const x = plan.bullets.x0[i] + plan.bullets.vx[i] * dt(i, ev.arrival);
        const y = plan.bullets.y0[i] + plan.bullets.vy[i] * dt(i, ev.arrival);
        expect(Math.abs(Math.hypot(x - ev.x, y - ev.y) - dist)).toBeLessThan(0.5);
      }
      if (ev.kind === 'burst' || ev.kind === 'stream') {
        const best = Math.min(...ids.map((i) => Math.hypot(
          plan.bullets.x0[i] + plan.bullets.vx[i] * dt(i, ev.arrival) - TARGET.x,
          plan.bullets.y0[i] + plan.bullets.vy[i] * dt(i, ev.arrival) - TARGET.y)));
        expect(best).toBeLessThan(0.5);
      }
    }
  });

  it('keeps quiet parts as breathers and scales density with energy', () => {
    const chart = chartOf('edm');
    const plan = generatePlan(chart);
    const track = edmTrack(128);
    const [bs, be] = track.quiet[1]; // breakdown
    const d0 = track.drops[0];
    const quietRate = arrivalsPerSec(plan, bs + 1, be - 1);
    const dropRate = arrivalsPerSec(plan, d0, d0 + 15);
    console.log('edm bullets/s: breakdown', quietRate.toFixed(2), 'drop', dropRate.toFixed(2), 'total', plan.bullets.count,
      'kinds', KINDS.map((k) => `${k}:${plan.events.filter((e) => e.kind === k).length}`).join(' '),
      'styles', plan.sections.map((s) => `${s.intensity}/${s.midStyle}`).join(' '));
    expect(dropRate).toBeGreaterThan(15);
    expect(quietRate).toBeLessThan(dropRate * 0.1);
    // nothing but rings in breathers
    expect(plan.events.filter((e) => e.arrival > bs + 1 && e.arrival < be - 1 && e.kind !== 'ring')).toHaveLength(0);

    // correlation between energy and bullets arriving per 2 s window
    const xs: number[] = [], ys: number[] = [];
    for (let t = 0; t + 2 <= chart.meta.durationSec; t += 2) {
      xs.push(sampleCurve(chart.curves.energy, chart.curves.hopSec, t + 1));
      ys.push(arrivalsPerSec(plan, t, t + 2));
    }
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const mx = mean(xs), my = mean(ys);
    const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const r = cov / Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
    console.log('energy/density correlation', r.toFixed(2));
    expect(r).toBeGreaterThan(0.6);
  });

  it('higher difficulty raises density', () => {
    const chart = chartOf('edm');
    expect(generatePlan(chart, { difficulty: 1 }).bullets.count).toBeGreaterThan(generatePlan(chart, { difficulty: 0.2 }).bullets.count);
  });

  it('hip-hop: patterns follow the song rhythm', () => {
    const plan = generatePlan(chartOf('hiphop'));
    console.log('hiphop masks', plan.sections.map((s) => JSON.stringify(s.masks)).join(' '), 'events', plan.events.length);
    expect(plan.events.some((e) => e.kind === 'ring')).toBe(true);
    expect(plan.events.some((e) => e.kind === 'stream')).toBe(true);
    // the kick rhythm (beats 1 and 3) should be in the low mask
    expect(plan.sections.some((s) => s.masks.low.includes(0))).toBe(true);
  });

  it('fallback mode follows onsets without a grid and never spirals', () => {
    const chart = chartOf('ambient');
    expect(chart.mode).toBe('fallback');
    const plan = generatePlan(chart);
    console.log('ambient events', plan.events.length, 'bullets', plan.bullets.count);
    expect(plan.events.every((e) => e.kind !== 'spiral' && e.spawn > 0)).toBe(true);
    expect(plan.bullets.count / chart.meta.durationSec).toBeLessThan(8);
  });

  it('rhythm masks: relative threshold, and quarters beat offbeats when shares are close', () => {
    // 8th-note bass: every 8th has a high share, offbeats slightly higher. Kick mask should be the quarters.
    const share = Array.from({ length: 16 }, (_, k) => (k % 4 === 0 ? 0.8 : k % 2 === 0 ? 0.88 : 0.3));
    expect(maskFromShare(share, 0.35, 4, 0.7, METRIC_STRONG)).toEqual([0, 4, 8, 12]);
    // a uniform "everything hits" share passes only up to the cap
    expect(maskFromShare(new Array(16).fill(0.9), 0.35, 4, 0.7, METRIC_STRONG)).toHaveLength(4);
    // weak steps below the relative threshold are dropped even if above the absolute one
    expect(maskFromShare([1, 0, 0, 0, 0.5, 0, 0, 0, 1, 0, 0, 0, 0.5, 0, 0, 0], 0.35, 4, 0.7)).toEqual([0, 8]);
  });
});
