/**
 * Opt-in report on real music. Skipped unless REAL_TRACKS_DIR points at a folder of audio files
 * (decoded with ffmpeg, which must be on PATH). Audio is never committed to this repo.
 *
 *   REAL_TRACKS_DIR=~/music/test-set npx vitest run tests/realtracks.test.ts
 *
 * Prints one line per track with the numbers used to tune the pattern generator.
 */
import { describe, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/analysis/analyze';
import { sampleCurve } from '../src/chart/types';
import { generatePlan } from '../src/game/patterns';

const dir = process.env.REAL_TRACKS_DIR;

function decode(path: string): Float32Array {
  const out = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
}

const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const cv = (a: number[]) => { const m = mean(a); return m ? Math.sqrt(mean(a.map((v) => (v - m) ** 2))) / m : 0; };
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

describe.skipIf(!dir)('real tracks report', () => {
  it('prints tuning metrics', () => {
    const files = readdirSync(dir!).filter((f) => /\.(mp3|wav|ogg|flac|m4a)$/i.test(f)).sort();
    const rows: string[] = [];
    const totals = { spiral: 0, sections: 0, maskL: [] as number[], maskM: [] as number[], maskH: [] as number[], loudCv: [] as number[], dropBoost: [] as number[] };
    for (const f of files) {
      const path = join(dir!, f);
      const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
      const { chart } = analyze([decode(path)], 44100, { fileHash: hash, fileName: f });
      const plan = generatePlan(chart);
      const dur = chart.meta.durationSec;
      const rate = (a: number, b: number) => plan.events.filter((e) => e.arrival >= a && e.arrival < b).reduce((s, e) => s + e.count, 0) / Math.max(1e-6, b - a);
      const energy = (t: number) => sampleCurve(chart.curves.energy, chart.curves.hopSec, t);

      // density over 4 s windows in loud parts: low variation = flat, monotonous
      const loud: number[] = [];
      for (let t = 0; t + 4 <= dur; t += 4) if (energy(t + 2) > 0.6) loud.push(rate(t, t + 4));
      const dropRates = chart.drops.filter((d) => d.intensity >= 0.5).map((d) => rate(d.t, d.t + 8));
      const boost = dropRates.length && median(loud) ? mean(dropRates) / median(loud) : NaN;
      const spirals = plan.sections.filter((s) => s.midStyle === 'spiral').length;
      totals.spiral += spirals;
      totals.sections += plan.sections.length;
      for (const s of plan.sections) { totals.maskL.push(s.masks.low.length); totals.maskM.push(s.masks.mid.length); totals.maskH.push(s.masks.high.length); }
      totals.loudCv.push(cv(loud));
      if (!Number.isNaN(boost)) totals.dropBoost.push(boost);
      const sectionRates = plan.sections.map((s) => rate(s.start, s.end).toFixed(0)).join(' ');
      rows.push(
        `${f.replace(/^[0-9a-f]{8}-/, '').slice(0, 28).padEnd(28)} ${(chart.tempo?.bpm.toFixed(0) ?? '—').padStart(3)} bpm ` +
        `avg ${(plan.bullets.count / dur).toFixed(0).padStart(2)} b/s | loud p10/p50/p90 ${[0.1, 0.5, 0.9].map((q) => [...loud].sort((a, b) => a - b)[Math.floor(q * (loud.length - 1))]?.toFixed(0) ?? '-').join('/')} cv ${cv(loud).toFixed(2)} ` +
        `| drop×${Number.isNaN(boost) ? ' —  ' : boost.toFixed(2)} | spiral ${spirals}/${plan.sections.length} ` +
        `| masks L${mean(plan.sections.map((s) => s.masks.low.length)).toFixed(1)} M${mean(plan.sections.map((s) => s.masks.mid.length)).toFixed(1)} H${mean(plan.sections.map((s) => s.masks.high.length)).toFixed(1)} | sections ${sectionRates}`,
      );
    }
    console.log(['', ...rows,
      `TOTAL spiral ${totals.spiral}/${totals.sections} | mask L${mean(totals.maskL).toFixed(1)} M${mean(totals.maskM).toFixed(1)} H${mean(totals.maskH).toFixed(1)} | loud cv ${mean(totals.loudCv).toFixed(2)} | drop boost ${mean(totals.dropBoost).toFixed(2)}`].join('\n'));
  }, 600_000);
});
