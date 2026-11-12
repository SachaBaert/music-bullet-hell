/**
 * A simple dodging bot that plays through PlayState with the same rules as the browser.
 * Used as a tuning proxy for "how hard is this", not as ground truth: it reacts at 10 Hz
 * with a 0.4 s look-ahead and only sees bullets that have already spawned (like a player).
 */
import type { Chart } from '../src/chart/types';
import { PlayState, type PlayInput } from '../src/game/play';
import { ARENA, KINDS, TARGET, type EventKind, type Plan } from '../src/game/patterns';
import { PLAYER } from '../src/game/play';

export interface BotResult {
  hits: number;
  hitsPerMin: number;
  grazesPerMin: number;
  emitterHits: number;
  hitsByKind: Record<EventKind, number>;
  /** Median number of bullets within 100 px of the ship (pressure). */
  pressure: number;
  /** Share of time spent in focus mode. */
  focusShare: number;
}

const DIRS: [number, number][] = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export interface BotOptions {
  fps?: number;
  /** Decisions per second. */
  decideHz?: number;
  /** Look-ahead, s. */
  horizon?: number;
  /** Reaction time: a decision only takes effect this much later. The bot plans for that lag (as a person anticipates). */
  reaction?: number;
  /** Clearance beyond which the bot stops caring (px). Lower = skims closer, like a confident player. */
  comfort?: number;
  /** Plan for the reaction lag (true) or act as if the decision applied immediately (false: purely reactive). */
  anticipate?: boolean;
  /** Misjudged bullet speed: each bullet's extrapolation is off by up to ± this fraction (seeded per bullet). */
  misjudge?: number;
}

/** Perfect-information reflexes: an upper bound on what's dodgeable. */
export const EXPERT: BotOptions = { decideHz: 10, horizon: 0.4, reaction: 0, comfort: 45 };
/** Rough stand-in for a reasonable human: slower updates, ~200 ms reaction, shorter look-ahead. */
export const CASUAL: BotOptions = { decideHz: 8, horizon: 0.4, reaction: 0.2, comfort: 35, misjudge: 0.2 };
/** Reacts 200 ms late without anticipating it: a measure of how much fast reaction a chart demands. */
export const REACTIVE: BotOptions = { decideHz: 10, horizon: 0.4, reaction: 0.2, comfort: 45, anticipate: false };

export function runBot(plan: Plan, chart: Chart, opts: BotOptions = EXPERT): BotResult {
  const fps = opts.fps ?? 60, decideHz = opts.decideHz ?? 10, horizon = opts.horizon ?? 0.4;
  const anticipate = opts.anticipate ?? true;
  const reaction = opts.reaction ?? 0, comfort = opts.comfort ?? 45, misjudge = opts.misjudge ?? 0;
  // fixed per-bullet error in [-1, 1] (deterministic)
  const err = (i: number) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return ((h >>> 0) / 0xffffffff) * 2 - 1; };
  const pending: { at: number; input: PlayInput }[] = [];
  const play = new PlayState(plan, chart);
  const b = plan.bullets;
  const dur = chart.meta.durationSec;
  play.reset(0);
  let input: PlayInput = { mx: 0, my: 0, dragX: 0, dragY: 0, focus: false, fire: true };
  let nextDecision = 0;
  const pressure: number[] = [];
  let focusFrames = 0, frames = 0;
  const samples = [0.05, 0.1, 0.15, 0.2, 0.3, horizon];

  for (let f = 1; f * (1 / fps) <= dur; f++) {
    const t = f / fps;
    if (t >= nextDecision) {
      nextDecision = t + 1 / decideHz;
      // nearby, already-spawned bullets (spawning ones are aimed at the ship, not yet known)
      const [lo, hi] = play.window(t);
      const near: number[] = [];
      for (let i = lo; i < hi; i++) {
        if (t >= b.t1[i] || play.removed[i]) continue;
        play.pos(i, t);
        if (Math.hypot(play.px - play.x, play.py - play.y) < 220) near.push(i);
      }
      pressure.push(near.filter((i) => { play.pos(i, t); return Math.hypot(play.px - play.x, play.py - play.y) < 100; }).length);
      // where the ship will be when this decision takes effect (inputs already in the pipeline)
      let sx = play.x, sy = play.y;
      const lag = anticipate ? reaction : 0;
      if (anticipate) {
        let tt = t, cur = input;
        for (const p of [...pending, { at: t + reaction, input }]) {
          const span = Math.max(0, Math.min(p.at, t + reaction) - tt);
          const spd = cur.focus ? PLAYER.focusSpeed : PLAYER.speed;
          sx += cur.mx * spd * span; sy += cur.my * spd * span;
          tt += span; cur = p.input;
        }
      }
      let best = -Infinity, bestIn = input;
      for (const focus of [false, true]) {
        const sp = focus ? PLAYER.focusSpeed : PLAYER.speed;
        for (const [dx, dy] of DIRS) {
          if (focus && dx === 0 && dy === 0) continue;
          const n = Math.hypot(dx, dy) || 1;
          let clear = comfort + 15;
          for (const s of samples) {
            const x = Math.min(ARENA.w - PLAYER.margin, Math.max(PLAYER.margin, sx + (dx / n) * sp * s));
            const y = Math.min(ARENA.h - PLAYER.margin, Math.max(PLAYER.margin, sy + (dy / n) * sp * s));
            const ts = t + lag + s;
            for (const i of near) {
              if (ts >= b.t1[i]) continue;
              play.pos(i, t);
              const nx = play.px, ny = play.py;
              play.pos(i, ts);
              // what the bot *thinks*: the true motion from now, with the speed misjudged
              const k = 1 + misjudge * err(i);
              const gx = nx + (play.px - nx) * k, gy = ny + (play.py - ny) * k;
              const d = Math.hypot(gx - x, gy - y) - (PLAYER.hitbox + b.r[i] * PLAYER.bulletHitFrac);
              // near-term danger counts more than far-term
              const w = d + 40 * s;
              if (w < clear) clear = w;
            }
          }
          const ex = sx + (dx / n) * sp * 0.3, ey = sy + (dy / n) * sp * 0.3;
          const home = Math.hypot(ex - TARGET.x, ey - (TARGET.y - 20));
          const score = Math.min(clear, comfort) - 0.03 * home - (focus ? 0.5 : 0);
          if (score > best) { best = score; bestIn = { mx: dx / n, my: dy / n, dragX: 0, dragY: 0, focus, fire: true }; }
        }
      }
      if (reaction > 0) pending.push({ at: t + reaction, input: bestIn }); else input = bestIn;
    }
    while (pending.length && t >= pending[0].at) input = pending.shift()!.input;
    play.step(t, input, 1 / fps);
    frames++;
    if (input.focus) focusFrames++;
  }
  const s = [...pressure].sort((a, c) => a - c);
  return {
    hits: play.hits,
    hitsPerMin: (play.hits / dur) * 60,
    grazesPerMin: (play.grazes / dur) * 60,
    emitterHits: play.emitterHits,
    hitsByKind: { ...play.hitsByKind },
    pressure: s[s.length >> 1] ?? 0,
    focusShare: focusFrames / Math.max(1, frames),
  };
}

export { KINDS };
