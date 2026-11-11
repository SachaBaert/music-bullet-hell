import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/analyze';
import { SR, ambientTrack, edmTrack, hiphopTrack } from './synth';

function beatError(detected: number[], truth: number[]) {
  // median absolute distance from each true beat to the nearest detected beat
  const errs = truth.map((t) => Math.min(...detected.map((d) => Math.abs(d - t))));
  errs.sort((a, b) => a - b);
  return errs[Math.floor(errs.length / 2)];
}

describe('analyze()', () => {
  it('EDM 128 BPM: tempo, beat grid, drops and quiet parts', () => {
    const track = edmTrack(128);
    const { chart } = analyze([track.audio], SR);
    console.log('edm', chart.tempo, 'drops', chart.drops, 'quiet', chart.quiet, 'sections', chart.sections.map((s) => [s.start, s.intensity]), `${chart.meta.analysisMs} ms`);
    expect(chart.mode).toBe('full');
    expect(chart.tempo!.bpm).toBeGreaterThan(126.5);
    expect(chart.tempo!.bpm).toBeLessThan(129.5);
    expect(beatError(chart.beats.map((b) => b.t), track.beats)).toBeLessThan(0.025);
    // downbeats should coincide with bar starts
    const down = chart.beats.filter((b) => b.beatInBar === 0).map((b) => b.t);
    const bars = track.beats.filter((_, i) => i % 4 === 0);
    expect(beatError(down, bars)).toBeLessThan(0.03);
    // both drops found within half a beat
    for (const d of track.drops) expect(chart.drops.some((x) => Math.abs(x.t - d) < 0.25)).toBe(true);
    expect(chart.drops.length).toBeLessThanOrEqual(3);
    // first drop has a build-up before it
    const first = chart.drops.find((x) => Math.abs(x.t - track.drops[0]) < 0.25)!;
    expect(first.buildStart).not.toBeNull();
    // the breakdown is detected as quiet
    const [bs, be] = track.quiet[1];
    expect(chart.quiet.some((q) => q.start < bs + 3 && q.end > be - 3)).toBe(true);
    // a section boundary near each drop
    for (const d of track.drops) expect(chart.sections.some((s) => Math.abs(s.start - d) < 2)).toBe(true);
  });

  it('Hip-hop 88 BPM with swing: tempo and beats', () => {
    const track = hiphopTrack(88);
    const { chart } = analyze([track.audio], SR);
    console.log('hiphop', chart.tempo, 'drops', chart.drops.length);
    expect(chart.mode).toBe('full');
    expect(Math.abs(chart.tempo!.bpm - 88)).toBeLessThan(1.5);
    expect(beatError(chart.beats.map((b) => b.t), track.beats)).toBeLessThan(0.03);
  });

  it('Beatless ambient falls back to energy/sections only', () => {
    const track = ambientTrack();
    const { chart } = analyze([track.audio], SR);
    console.log('ambient confidence-based mode', chart.mode, chart.tempo);
    expect(chart.mode).toBe('fallback');
    expect(chart.beats).toHaveLength(0);
    expect(chart.curves.energy.length).toBe(chart.curves.frameCount);
    expect(chart.sections.length).toBeGreaterThanOrEqual(1);
  });
});
