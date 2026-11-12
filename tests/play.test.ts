import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/analyze';
import type { Chart } from '../src/chart/types';
import { BeatGrid } from '../src/game/grid';
import { AIM_SCALE, TARGET, generatePlan } from '../src/game/patterns';
import { NO_INPUT, PLAYER, PlayState } from '../src/game/play';
import { runBot } from './bot';
import { SR, edmTrack } from './synth';

let chart: Chart | null = null;
const edm = () => (chart ??= analyze([edmTrack(128).audio], SR, { fileHash: 'a1b2c3', fileName: 'edm.wav' }).chart);

/** Step a PlayState to time t in 60 fps frames, holding the ship at (x, y). */
function holdAt(play: PlayState, from: number, to: number, x: number, y: number, fire = false) {
  for (let t = from; t <= to + 1e-9; t += 1 / 60) {
    play.x = x; play.y = y;
    play.step(t, { ...NO_INPUT, fire }, 1 / 60);
  }
}

describe('PlayState', () => {
  it('aimed patterns land on the ship\'s spawn-time position, exactly on their beat', () => {
    const plan = generatePlan(edm());
    const play = new PlayState(plan, edm());
    play.reset(0);
    const P = { x: 170, y: 560 }; // well away from the nominal target
    const end = 40;
    holdAt(play, 0, end, P.x, P.y);
    const b = plan.bullets;
    let checked = 0;
    for (let e = 0; e < plan.events.length; e++) {
      const ev = plan.events[e];
      if (!ev.aimed || ev.spawn < 1 || ev.arrival > end) continue;
      const scale = Math.hypot(P.x - ev.x, P.y - ev.y) / ev.dist;
      if (scale < AIM_SCALE[0] || scale > AIM_SCALE[1]) continue;
      let best = Infinity;
      for (let i = 0; i < b.count; i++) {
        if (b.ev[i] !== e) continue;
        play.pos(i, ev.arrival);
        best = Math.min(best, Math.hypot(play.px - P.x, play.py - P.y));
      }
      // bursts and streams aim a bullet straight through the ship; rings may be 'split' around it
      if (ev.kind !== 'ring') expect(best).toBeLessThan(0.5);
      else expect(best).toBeLessThan(Math.PI * ev.dist * scale / ev.count + 0.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it('standing still gets hit, with invulnerability between hits; play is deterministic', () => {
    const run = () => {
      const play = new PlayState(generatePlan(edm()), edm());
      play.reset(0);
      const times: number[] = [];
      for (let t = 0; t <= 60; t += 1 / 60) {
        const before = play.hits;
        play.step(t, NO_INPUT, 1 / 60);
        if (play.hits > before) times.push(t);
      }
      return times;
    };
    const a = run();
    expect(a.length).toBeGreaterThan(3);
    for (let i = 1; i < a.length; i++) expect(a[i] - a[i - 1]).toBeGreaterThanOrEqual(PLAYER.invuln - 1 / 60);
    expect(run()).toEqual(a);
  });

  it('auto-fire puts one volley on every 16th step while fire is held, and shots hit emitters', () => {
    const c = edm();
    const play = new PlayState(generatePlan(c), c);
    play.reset(0);
    const grid = new BeatGrid(c.beats);
    const [t0, t1] = [20, 24];
    holdAt(play, 0, t0, TARGET.x, TARGET.y, false);
    const before = play.shotsFired;
    // stand right under the top emitter so the shots connect
    const st = play.sectionAt(t0);
    holdAt(play, t0 + 1 / 60, t1, st.ringEmitter.x, 400, true);
    let steps = 0;
    for (let s = 0; s < grid.stepCount; s++) { const t = grid.stepTime(s); if (t > t0 && t <= t1) steps++; }
    expect(Math.abs(play.shotsFired - before - steps)).toBeLessThanOrEqual(1);
    expect(play.emitterHits).toBeGreaterThan(steps / 2);
  });

  it('seeking forgets future aims and clears shots', () => {
    const c = edm();
    const plan = generatePlan(c);
    const play = new PlayState(plan, c);
    play.reset(0);
    holdAt(play, 0, 40, 100, 700, true);
    const future = plan.events.findIndex((e) => e.spawn > 25 && e.spawn < 39 && e.aimed);
    expect(future).toBeGreaterThanOrEqual(0);
    expect(play.resolved[future]).toBe(1);
    play.step(20, NO_INPUT, 0); // jump back
    expect(play.resolved[future]).toBe(0);
    expect(play.shots).toHaveLength(0);
  });

  it('a dodging bot survives a synthetic EDM track at normal far better than standing still', () => {
    const c = edm();
    const plan = generatePlan(c);
    const bot = runBot(plan, c);
    const idle = new PlayState(plan, c);
    idle.reset(0);
    for (let t = 0; t <= c.meta.durationSec; t += 1 / 60) idle.step(t, NO_INPUT, 1 / 60);
    console.log('edm bot', JSON.stringify(bot), 'idle hits', idle.hits);
    expect(bot.hits).toBeLessThan(idle.hits / 3);
  });
});
