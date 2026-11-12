/**
 * Player state and rules (milestone 3). Pure: no DOM, no PixiJS, so the view and the test bot
 * run exactly the same code.
 *
 * The plan stays deterministic. The only runtime-dependent part is the aim of aimed events:
 * when an event spawns, it is aimed at the player's position at that moment (interpolated within
 * the frame) and its speed is scaled so it still lands on its beat (see resolveAim()).
 * Bullet positions remain a pure function of (song time, that recorded aim), so pausing works and
 * seeking only needs to forget the aims of events that haven't spawned yet.
 */
import type { Chart } from '../chart/types';
import { BeatGrid, lowerBound } from './grid';
import { ARENA, KINDS, TARGET, emittersOf, resolveAim, type EventKind, type Plan, type SectionStyle } from './patterns';

export const PLAYER = {
  /** px/s, unfocused / focused (Shift) */
  speed: 330,
  focusSpeed: 140,
  /** Hitbox radius. Bullets hit with 70 % of their drawn radius, as usual in the genre. */
  hitbox: 2.5,
  bulletHitFrac: 0.7,
  /** A bullet grazes once when its edge comes this close to the player's centre. */
  graze: 24,
  /** Meter gain per graze (meter is 0..1). */
  grazeGain: 0.008,
  /** Keep the ship this far from the arena edge. */
  margin: 10,
  /** Seconds of invulnerability after a hit. */
  invuln: 1.6,
  /** Shots. Grid mode fires on every 16th step; fallback mode at a fixed rate. */
  shotSpeed: 950,
  shotR: 4,
  fallbackRate: 8,
  /** Emitter hit radius for shots. */
  emitterR: 18,
} as const;

/** Frames longer than this (or going backwards) are treated as a seek: no collisions, no shots. */
const SEEK_GAP = 0.25;

export interface PlayInput {
  /** Keyboard direction, each component -1..1. */
  mx: number;
  my: number;
  /** Pointer drag this frame, in arena px (relative movement, like most mobile shmups). */
  dragX: number;
  dragY: number;
  focus: boolean;
  fire: boolean;
}

export const NO_INPUT: PlayInput = { mx: 0, my: 0, dragX: 0, dragY: 0, focus: false, fire: false };

export interface Shot { x: number; y: number; vx: number; vy: number; born: number }
export interface Fx { kind: 'graze' | 'hit' | 'emitter'; x: number; y: number; t: number; color?: EventKind }

export class PlayState {
  x: number = TARGET.x;
  y: number = TARGET.y;
  focus = false;
  firing = false;
  hits = 0;
  /** Which kind of bullet hit you (tuning aid). */
  hitsByKind: Record<EventKind, number> = { ring: 0, burst: 0, spiral: 0, stream: 0 };
  grazes = 0;
  /** 0..1; spent in milestone 4. */
  meter = 0;
  emitterHits = 0;
  shotsFired = 0;
  invulnUntil = -Infinity;
  shots: Shot[] = [];
  /** Recent effects for the view (graze sparks, hit flashes, emitter hits). */
  fx: Fx[] = [];
  /** Last time each emitter key was hit, for the view's flash. */
  emitterFlash = new Map<string, number>();

  /** Per-event aim, resolved at spawn. */
  readonly aimAngle: Float32Array;
  readonly aimScale: Float32Array;
  readonly resolved: Uint8Array;
  /** Per-bullet flags. */
  readonly grazed: Uint8Array;
  readonly removed: Uint8Array;

  private lastT = 0;
  private started = false;
  private spawnOrder: number[];
  private spawnTimes: number[];
  private nextSpawn = 0;
  private grid: BeatGrid | null;
  private nextShotT = 0;

  /** Scratch output of pos(). */
  px = 0;
  py = 0;

  constructor(readonly plan: Plan, chart: Chart) {
    const n = plan.events.length;
    this.aimAngle = new Float32Array(n);
    this.aimScale = new Float32Array(n).fill(1);
    this.resolved = new Uint8Array(n);
    this.grazed = new Uint8Array(plan.bullets.count);
    this.removed = new Uint8Array(plan.bullets.count);
    this.spawnOrder = plan.events.map((_, i) => i).sort((a, b) => plan.events[a].spawn - plan.events[b].spawn);
    this.spawnTimes = this.spawnOrder.map((i) => plan.events[i].spawn);
    this.grid = chart.mode === 'full' && chart.beats.length >= 8 ? new BeatGrid(chart.beats, chart.tempo?.beatsPerBar ?? 4) : null;
  }

  get invulnerable() { return this.lastT < this.invulnUntil; }
  get time() { return this.lastT; }

  sectionAt(t: number): SectionStyle {
    const s = this.plan.sections;
    for (let i = s.length - 1; i >= 0; i--) if (t >= s[i].start) return s[i];
    return s[0];
  }

  private resolve(e: number, x: number, y: number) {
    const a = resolveAim(this.plan.events[e], x, y);
    this.aimAngle[e] = a.angle;
    this.aimScale[e] = a.scale;
    this.resolved[e] = 1;
  }

  /** Position of bullet i at time t → this.px / this.py. */
  pos(i: number, t: number) {
    const b = this.plan.bullets;
    const e = b.ev[i];
    const ev = this.plan.events[e];
    const dt = t - b.t0[i];
    if (!ev.aimed) {
      this.px = b.x0[i] + b.vx[i] * dt;
      this.py = b.y0[i] + b.vy[i] * dt;
      return;
    }
    if (!this.resolved[e]) this.resolve(e, this.x, this.y);
    const a = this.aimAngle[e] + b.ang[i];
    const v = b.spd[i] * this.aimScale[e];
    this.px = b.x0[i] + Math.cos(a) * v * dt;
    this.py = b.y0[i] + Math.sin(a) * v * dt;
  }

  /** Index range of bullets that may be alive at t (check t0 <= t < t1 and bounds per bullet). */
  window(t: number): [number, number] {
    const b = this.plan.bullets;
    return [lowerBound(b.t0, t - this.plan.maxLife), lowerBound(b.t0, t + 1e-9)];
  }

  /** Re-sync after a seek: forget aims of events that haven't spawned yet, clear per-bullet flags. */
  private sync(t: number) {
    const ev = this.plan.events;
    for (let e = 0; e < ev.length; e++) {
      if (ev[e].spawn > t) this.resolved[e] = 0;
      else if (!this.resolved[e]) this.resolve(e, this.x, this.y);
    }
    this.nextSpawn = lowerBound(this.spawnTimes, t + 1e-9);
    this.grazed.fill(0);
    this.removed.fill(0);
    this.shots.length = 0;
    this.fx.length = 0;
    this.nextShotT = t;
    // don't get hit by whatever happens to be on top of you after a jump
    this.invulnUntil = t + 0.75;
    this.lastT = t;
  }

  /** Restart counters and position (new track, difficulty change). */
  reset(t = 0) {
    this.x = TARGET.x; this.y = TARGET.y;
    this.hits = 0; this.grazes = 0;
    this.hitsByKind = { ring: 0, burst: 0, spiral: 0, stream: 0 }; this.meter = 0; this.emitterHits = 0; this.shotsFired = 0;
    this.invulnUntil = -Infinity;
    this.emitterFlash.clear();
    this.started = true;
    this.sync(t);
    this.invulnUntil = -Infinity;
  }

  /**
   * Advance to song time t. `wallDt` is real frame time: while the song is paused (t unchanged)
   * the ship can still be positioned, but nothing fires or collides.
   */
  step(t: number, input: PlayInput, wallDt = 0) {
    if (!this.started) this.reset(t);
    const t0 = this.lastT;
    const dt = t - t0;
    this.focus = input.focus;
    this.firing = input.fire;
    if (dt < 0 || dt > SEEK_GAP) { this.move(input, 0); this.sync(t); return; }
    const x0 = this.x, y0 = this.y;
    this.move(input, dt > 0 ? dt : Math.min(wallDt, 0.05));
    if (dt === 0) return;
    const x1 = this.x, y1 = this.y;
    const lerpX = (s: number) => x0 + (x1 - x0) * ((s - t0) / dt);
    const lerpY = (s: number) => y0 + (y1 - y0) * ((s - t0) / dt);

    // aim the events that spawn in this frame at where the player was at their spawn time
    while (this.nextSpawn < this.spawnTimes.length && this.spawnTimes[this.nextSpawn] <= t) {
      const s = this.spawnTimes[this.nextSpawn];
      const e = this.spawnOrder[this.nextSpawn++];
      const f = Math.max(t0, s);
      this.resolve(e, lerpX(f), lerpY(f));
    }

    this.collide(t0, t, x0, y0, x1, y1);
    this.advanceShots(dt);
    this.fire(t0, t, input.fire, lerpX, lerpY);
    this.hitEmitters(t, dt);
    this.lastT = t;
    // keep fx short
    if (this.fx.length && this.fx[0].t < t - 0.6) this.fx = this.fx.filter((f) => f.t >= t - 0.6);
  }

  private move(input: PlayInput, dt: number) {
    const sp = input.focus ? PLAYER.focusSpeed : PLAYER.speed;
    let mx = input.mx, my = input.my;
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    this.x += mx * sp * dt + input.dragX;
    this.y += my * sp * dt + input.dragY;
    const m = PLAYER.margin;
    this.x = Math.min(ARENA.w - m, Math.max(m, this.x));
    this.y = Math.min(ARENA.h - m, Math.max(m, this.y));
  }

  /**
   * Swept test over the frame: bullet and player both move linearly from t0 to t1, so the closest
   * approach of their relative motion is exact. Fast bullets can't tunnel through the hitbox.
   */
  private collide(t0: number, t1: number, x0: number, y0: number, x1: number, y1: number) {
    const b = this.plan.bullets;
    const [lo, hi] = this.window(t1);
    const inv = t1 < this.invulnUntil;
    for (let i = lo; i < hi; i++) {
      if (t1 >= b.t1[i] || this.removed[i]) continue;
      const s0 = Math.max(t0, b.t0[i]);
      this.pos(i, s0);
      const bx0 = this.px, by0 = this.py;
      this.pos(i, t1);
      const bx1 = this.px, by1 = this.py;
      const f0 = (s0 - t0) / (t1 - t0);
      const pxs = x0 + (x1 - x0) * f0, pys = y0 + (y1 - y0) * f0;
      // relative position at start and its change over the (sub)interval
      const rx = bx0 - pxs, ry = by0 - pys;
      const dx = (bx1 - x1) - rx, dy = (by1 - y1) - ry;
      const dd = dx * dx + dy * dy;
      const u = dd > 1e-9 ? Math.min(1, Math.max(0, -(rx * dx + ry * dy) / dd)) : 1;
      const cx = rx + dx * u, cy = ry + dy * u;
      const d = Math.hypot(cx, cy);
      const r = b.r[i];
      if (d > PLAYER.graze + r) continue;
      const tc = s0 + (t1 - s0) * u;
      if (!inv && d < PLAYER.hitbox + r * PLAYER.bulletHitFrac) {
        this.hits++;
        this.hitsByKind[KINDS[b.kind[i]]]++;
        this.removed[i] = 1;
        this.invulnUntil = tc + PLAYER.invuln;
        this.fx.push({ kind: 'hit', x: x1, y: y1, t: tc });
        return; // invulnerable from here on in this frame
      }
      if (!inv && !this.grazed[i] && d < PLAYER.graze + r * 0.5) {
        this.grazed[i] = 1;
        this.grazes++;
        this.meter = Math.min(1, this.meter + PLAYER.grazeGain);
        this.fx.push({ kind: 'graze', x: x1 + cx, y: y1 + cy, t: tc });
      }
    }
  }

  /** Auto-fire: one volley on every 16th step of the beat grid while fire is held. */
  private fire(t0: number, t1: number, held: boolean, lx: (s: number) => number, ly: (s: number) => number) {
    if (!held) { this.nextShotT = t1; return; }
    const times: number[] = [];
    if (this.grid) {
      for (let s = this.grid.firstStepAtOrAfter(t0 + 1e-9); ; s++) {
        const st = this.grid.stepTime(s);
        if (st > t1) break;
        if (st > t0) times.push(st);
      }
    } else {
      const gap = 1 / PLAYER.fallbackRate;
      if (this.nextShotT < t0) this.nextShotT = t0;
      while (this.nextShotT <= t1) { times.push(this.nextShotT); this.nextShotT += gap; }
    }
    for (const st of times) {
      const x = lx(st), y = ly(st) - 10;
      const v = PLAYER.shotSpeed;
      // unfocused: a 3-way spread; focused: two parallel shots, all damage straight ahead
      const vols = this.focus
        ? [[-5, 0], [5, 0]]
        : [[0, 0], [-6, -0.13], [6, 0.13]];
      for (const [ox, a] of vols) {
        const shot = { x: x + ox, y, vx: Math.sin(a) * v, vy: -Math.cos(a) * v, born: st };
        shot.x += shot.vx * (t1 - st);
        shot.y += shot.vy * (t1 - st);
        this.shots.push(shot);
      }
      this.shotsFired++;
    }
  }

  /** Advance shots that existed before this frame (new ones are already placed at t by fire()). */
  private advanceShots(dt: number) {
    for (const s of this.shots) { s.x += s.vx * dt; s.y += s.vy * dt; }
  }

  /** Shots vs the current section's emitters, swept over the frame (shots move ~16 px per frame). */
  private hitEmitters(t: number, dt: number) {
    const emitters = emittersOf(this.sectionAt(t), t);
    const R = PLAYER.emitterR + PLAYER.shotR;
    let w = 0;
    for (const s of this.shots) {
      const back = Math.min(dt, t - s.born);
      const ax = s.x - s.vx * back, ay = s.y - s.vy * back;
      let hit = false;
      for (const e of emitters) {
        if (segDist(ax, ay, s.x, s.y, e.x, e.y) < R) {
          hit = true;
          this.emitterHits++;
          this.emitterFlash.set(e.key, t);
          this.fx.push({ kind: 'emitter', x: e.x, y: e.y, t, color: e.kind });
          break;
        }
      }
      if (!hit && s.y > -20 && s.x > -20 && s.x < ARENA.w + 20) this.shots[w++] = s;
    }
    this.shots.length = w;
  }
}

function segDist(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  const dx = bx - ax, dy = by - ay;
  const dd = dx * dx + dy * dy;
  const u = dd > 1e-9 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / dd)) : 0;
  return Math.hypot(ax + dx * u - px, ay + dy * u - py);
}
