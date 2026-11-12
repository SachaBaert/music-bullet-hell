/**
 * Game view (milestone 2): renders a Plan against the audio clock.
 *
 * No simulation state: every frame asks "which bullets are alive at song time t?" and places them
 * analytically (p0 + v·(t − t0)). Seeking, pausing and scrubbing therefore just work.
 * No player yet; a static target dot marks where patterns are aimed and pulses when one arrives.
 */
import { Application, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { sampleCurve, type Chart } from '../chart/types';
import { lowerBound } from './grid';
import { ARENA, KINDS, TARGET, streamEmitterAt, type EventKind, type Plan, type SectionStyle } from './patterns';

const COLOR: Record<EventKind, number> = {
  ring: 0xff4d7a,   // kick / low
  burst: 0x2ee6b0,  // mids
  spiral: 0xb388ff, // mids, spiral style
  stream: 0x4cc9f0, // highs
};
const CURVE_COLOR = { energy: 0xffd166, low: 0xef476f, mid: 0x06d6a0, high: 0x4cc9f0, novelty: 0xffffff };
const TEX_R = 16;

export class GameView {
  private app = new Application();
  private chart: Chart | null = null;
  private plan: Plan | null = null;
  /** Event indices sorted by spawn time, with their spawn times, for telegraph lookups. */
  private spawnOrder: number[] = [];
  private spawnTimes: number[] = [];
  private arrivalTimes: number[] = [];

  private root = new Container();
  private arenaBg = new Graphics();
  private debugG = new Graphics();
  private debugLabels = new Container();
  private emitterG = new Graphics();
  private bulletLayer = new Container();
  private targetG = new Graphics();
  private frameG = new Graphics();
  private arenaMask = new Graphics();
  private debugText!: Text;
  private textures: Texture[] = [];
  private pool: Sprite[] = [];
  private labelPool: Text[] = [];

  debug = false;
  /** Bullets drawn in the last frame (for the debug readout). */
  visibleCount = 0;

  async init(host: HTMLElement) {
    await this.app.init({
      resizeTo: host,
      background: 0x07080c,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);
    this.textures = KINDS.map((k) => this.bulletTexture(COLOR[k]));
    this.debugText = new Text({ text: '', style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11, fill: 0xc9d3e3, lineHeight: 15 } });
    this.debugText.position.set(10, 8);
    this.arenaBg.rect(0, 0, ARENA.w, ARENA.h).fill(0x0d0f14);
    this.arenaMask.rect(0, 0, ARENA.w, ARENA.h).fill(0xffffff);
    this.frameG.rect(0, 0, ARENA.w, ARENA.h).stroke({ width: 1, color: 0x232a38 });
    const inner = new Container();
    inner.addChild(this.arenaBg, this.debugG, this.debugLabels, this.emitterG, this.bulletLayer, this.targetG, this.debugText);
    inner.mask = this.arenaMask;
    this.root.addChild(inner, this.arenaMask, this.frameG);
    this.app.stage.addChild(this.root);
    this.app.renderer.on('resize', () => this.layout());
    new ResizeObserver(() => this.app.resize()).observe(host);
    this.layout();
  }

  setData(chart: Chart, plan: Plan) {
    this.chart = chart;
    this.plan = plan;
    this.spawnOrder = plan.events.map((_, i) => i).sort((a, b) => plan.events[a].spawn - plan.events[b].spawn);
    this.spawnTimes = this.spawnOrder.map((i) => plan.events[i].spawn);
    this.arrivalTimes = plan.events.map((e) => e.arrival);
  }

  /** Stop rendering while hidden (two WebGL views share the page). */
  setActive(on: boolean) {
    if (on) { this.app.start(); this.app.resize(); } else this.app.stop();
  }

  private layout() {
    const w = this.app.screen.width, h = this.app.screen.height;
    const s = Math.max(0.1, Math.min((w - 24) / ARENA.w, (h - 24) / ARENA.h));
    this.root.scale.set(s);
    this.root.position.set((w - ARENA.w * s) / 2, (h - ARENA.h * s) / 2);
  }

  private bulletTexture(color: number): Texture {
    // white core, coloured rim, thin dark outline: bullets must be the most readable thing on screen
    const g = new Graphics()
      .circle(0, 0, TEX_R + 1.5).fill(0x000000)
      .circle(0, 0, TEX_R).fill(color)
      .circle(0, 0, TEX_R * 0.55).fill(0xffffff);
    const tex = this.app.renderer.generateTexture({ target: g, resolution: 2, antialias: true });
    g.destroy();
    return tex;
  }

  // ------------------------------------------------------------------ per frame

  update(t: number) {
    const plan = this.plan;
    if (!plan || !this.chart) {
      this.debugText.text = '';
      return;
    }
    if (this.debug) this.drawDebug(t); else { this.debugG.clear(); this.hideLabels(0); }
    this.drawEmitters(t);
    this.drawBullets(t);
    this.drawTarget(t);
    this.debugText.visible = this.debug;
    if (this.debug) this.debugText.text = this.debugReadout(t);
  }

  private sectionAt(t: number): SectionStyle {
    const s = this.plan!.sections;
    for (let i = s.length - 1; i >= 0; i--) if (t >= s[i].start) return s[i];
    return s[0];
  }

  private drawBullets(t: number) {
    const b = this.plan!.bullets;
    let n = 0;
    for (let i = lowerBound(b.t0, t - this.plan!.maxLife); i < b.count && b.t0[i] <= t; i++) {
      if (t >= b.t1[i]) continue;
      const dt = t - b.t0[i];
      let sp = this.pool[n];
      if (!sp) {
        sp = new Sprite(this.textures[0]);
        sp.anchor.set(0.5);
        this.pool.push(sp);
        this.bulletLayer.addChild(sp);
      }
      n++;
      sp.visible = true;
      sp.texture = this.textures[b.kind[i]];
      sp.position.set(b.x0[i] + b.vx[i] * dt, b.y0[i] + b.vy[i] * dt);
      const pop = Math.min(1, 0.35 + dt / 0.1); // short pop-in at the emitter
      sp.scale.set((b.r[i] / TEX_R) * pop);
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].visible = false;
    this.visibleCount = n;
  }

  private drawEmitters(t: number) {
    const g = this.emitterG.clear();
    const plan = this.plan!;
    const st = this.sectionAt(t);

    // resting emitters of the current section (dim)
    const hex = (x: number, y: number, r: number) => g.poly(Array.from({ length: 12 }, (_, i) => (i % 2 ? y : x) + r * (i % 2 ? Math.sin : Math.cos)(Math.floor(i / 2) * Math.PI / 3)));
    hex(st.ringEmitter.x, st.ringEmitter.y, 14).stroke({ width: 2, color: COLOR.ring, alpha: 0.45 });
    if (st.midStyle === 'burst') {
      for (const e of st.midEmitters) g.poly([e.x, e.y - 11, e.x + 11, e.y, e.x, e.y + 11, e.x - 11, e.y]).stroke({ width: 2, color: COLOR.burst, alpha: 0.45 });
    } else {
      g.circle(st.spiral.x, st.spiral.y, 12).stroke({ width: 2, color: COLOR.spiral, alpha: 0.45 });
    }
    const se = streamEmitterAt(st, t);
    g.poly([se.x - 8, se.y - 6, se.x + 8, se.y - 6, se.x, se.y + 8]).stroke({ width: 2, color: COLOR.stream, alpha: 0.45 });

    // telegraph: charge up before a spawn, flash on it
    const lead = 0.35, tail = 0.15;
    for (let j = lowerBound(this.spawnTimes, t - tail); j < this.spawnTimes.length && this.spawnTimes[j] <= t + lead; j++) {
      const ev = plan.events[this.spawnOrder[j]];
      const c = COLOR[ev.kind];
      const dt = t - ev.spawn;
      const size = ev.kind === 'ring' ? 18 : ev.kind === 'stream' ? 7 : 12;
      if (dt < 0) {
        const f = 1 + dt / lead; // 0 → 1 while charging
        g.circle(ev.x, ev.y, size * (2.2 - 1.2 * f)).stroke({ width: 1.5, color: c, alpha: 0.15 + 0.5 * f });
      } else {
        const f = dt / tail;
        g.circle(ev.x, ev.y, size * (1 + f)).fill({ color: c, alpha: 0.5 * (1 - f) });
      }
    }
  }

  private drawTarget(t: number) {
    const g = this.targetG.clear();
    const plan = this.plan!;
    // pulse for every pattern arriving now: this is the "lands on the beat" check
    const win = 0.25;
    for (let i = lowerBound(this.arrivalTimes, t - win); i < this.arrivalTimes.length && this.arrivalTimes[i] <= t; i++) {
      const ev = plan.events[i];
      const f = (t - ev.arrival) / win;
      const r = (ev.kind === 'ring' ? 26 : ev.kind === 'stream' ? 12 : 18) * (0.6 + f);
      g.circle(TARGET.x, TARGET.y, r).stroke({ width: ev.kind === 'ring' ? 3 : 2, color: COLOR[ev.kind], alpha: 0.9 * (1 - f) });
    }
    g.circle(TARGET.x, TARGET.y, 9).stroke({ width: 1.5, color: 0xffffff, alpha: 0.35 });
    g.circle(TARGET.x, TARGET.y, 4).fill(0xffffff);
  }

  // ------------------------------------------------------------------ debug overlay

  private hideLabels(from: number) {
    for (let i = from; i < this.labelPool.length; i++) this.labelPool[i].visible = false;
  }

  private drawDebug(t: number) {
    const chart = this.chart!, plan = this.plan!;
    const g = this.debugG.clear();
    // the now line runs through the target, so arrival ticks cross it exactly when the target pulses
    const before = 3 * (TARGET.x / ARENA.w) * 2, after = 6 - before, nowX = TARGET.x;
    const pxs = ARENA.w / (before + after);
    const xOf = (s: number) => nowX + (s - t) * pxs;
    const t0 = t - before, t1 = t + after;
    const span = (a: number, b: number, y: number, h: number, color: number, alpha: number) => {
      const x0 = Math.max(0, xOf(a)), x1 = Math.min(ARENA.w, xOf(b));
      if (x1 > x0) g.rect(x0, y, x1 - x0, h).fill({ color, alpha });
    };

    // breathers and drops/builds, full height
    for (const q of plan.breathers) span(q.start, q.end, 0, ARENA.h, 0x3a86ff, 0.07);
    for (const d of chart.drops) if (d.buildStart != null) span(d.buildStart, d.t, 0, ARENA.h, 0xff3864, 0.05);

    // beat grid
    for (const b of chart.beats) {
      if (b.t < t0 || b.t > t1) continue;
      g.rect(xOf(b.t) - 0.5, 0, 1, ARENA.h).fill({ color: 0xffffff, alpha: b.beatInBar === 0 ? 0.13 : 0.05 });
    }

    // curve lanes in the lower part of the arena
    const lanes = ['energy', 'low', 'mid', 'high', 'novelty'] as const;
    const laneH = 46, gap = 6, top = ARENA.h - lanes.length * (laneH + gap) - 4;
    const laneOfKind: Record<EventKind, number> = { ring: 1, burst: 2, spiral: 2, stream: 3 };
    let labelIdx = 0;
    const text = (s: string, x: number, y: number, color: number) => {
      let lb = this.labelPool[labelIdx];
      if (!lb) {
        lb = new Text({ text: '', style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 10, fill: 0xffffff, fontWeight: '700' } });
        this.labelPool.push(lb);
        this.debugLabels.addChild(lb);
      }
      labelIdx++;
      lb.visible = true;
      if (lb.text !== s) lb.text = s;
      lb.style.fill = color;
      lb.position.set(x, y);
    };
    lanes.forEach((key, li) => {
      const y = top + li * (laneH + gap);
      const curve = chart.curves[key];
      const color = CURVE_COLOR[key];
      g.rect(0, y, ARENA.w, laneH).fill({ color: 0x000000, alpha: 0.35 });
      const steps = 150;
      g.moveTo(0, y + laneH);
      for (let k = 0; k <= steps; k++) {
        const s = t0 + ((t1 - t0) * k) / steps;
        const v = s < 0 || s > chart.meta.durationSec ? 0 : sampleCurve(curve, chart.curves.hopSec, s);
        g.lineTo((ARENA.w * k) / steps, y + laneH - v * (laneH - 2));
      }
      g.lineTo(ARENA.w, y + laneH).closePath().fill({ color, alpha: 0.18 });
      for (let k = 0; k <= steps; k++) {
        const s = t0 + ((t1 - t0) * k) / steps;
        const v = s < 0 || s > chart.meta.durationSec ? 0 : sampleCurve(curve, chart.curves.hopSec, s);
        const x = (ARENA.w * k) / steps, yy = y + laneH - v * (laneH - 2);
        if (k === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
      }
      g.stroke({ width: 1.5, color, alpha: 0.75 });
      // gates for the band lanes
      const gate = key === 'low' || key === 'mid' ? 0.3 : key === 'high' ? 0.35 : null;
      if (gate != null) g.rect(0, y + laneH - gate * (laneH - 2), ARENA.w, 1).fill({ color, alpha: 0.3 });
      text(key.toUpperCase(), 6, y + 3, color);
    });

    // scheduled arrivals as ticks on their band lane: they cross the now line when the target pulses
    for (let i = lowerBound(this.arrivalTimes, t0); i < this.arrivalTimes.length && this.arrivalTimes[i] <= t1; i++) {
      const ev = plan.events[i];
      const y = top + laneOfKind[ev.kind] * (laneH + gap);
      const x = xOf(ev.arrival);
      const h = ev.kind === 'ring' ? laneH : ev.kind === 'stream' ? laneH * 0.45 : laneH * 0.75;
      g.rect(x - 1.5, y + laneH - h, 3, h).fill({ color: COLOR[ev.kind], alpha: ev.arrival <= t ? 0.35 : 0.95 });
    }

    // section boundaries and drops
    for (const s of plan.sections) {
      if (s.start < t0 || s.start > t1) continue;
      const x = xOf(s.start);
      g.rect(x - 1, 0, 2, ARENA.h).fill({ color: 0xffffff, alpha: 0.45 });
      text(`§${s.index + 1} ${s.intensity} · ${s.midStyle}`, x + 5, top - 16, 0xffffff);
    }
    for (const d of chart.drops) {
      if (d.t < t0 || d.t > t1) continue;
      g.rect(xOf(d.t) - 1.5, 0, 3, ARENA.h).fill({ color: 0xff3864, alpha: 0.7 });
      text('DROP', xOf(d.t) + 5, top - 30, 0xff3864);
    }
    // now line
    g.rect(nowX - 1, top - 4, 2, ARENA.h - top + 4).fill({ color: 0xffffff, alpha: 0.9 });
    this.hideLabels(labelIdx);
  }

  private debugReadout(t: number): string {
    const chart = this.chart!, plan = this.plan!;
    const st = this.sectionAt(t);
    const at = (c: Float32Array) => sampleCurve(c, chart.curves.hopSec, t);
    const mask = (m: number[]) => m.length === 0 ? '—' : Array.from({ length: 16 }, (_, k) => (m.includes(k) ? 'x' : '·')).join('').replace(/(.{4})(?!$)/g, '$1 ');
    const breather = plan.breathers.some((b) => t >= b.start && t < b.end);
    const tempo = chart.tempo ? `${chart.tempo.bpm.toFixed(1)} bpm` : 'no grid';
    return [
      `§${st.index + 1}/${plan.sections.length} ${st.intensity.padEnd(4)} mids: ${st.midStyle.padEnd(6)} rings: ${st.ringOffset}`,
      `lead ${st.lead.padEnd(4)}  cap ${st.cap.toFixed(2)}${chart.drops.some((d) => t >= d.t && t < d.t + 8 * (chart.tempo ? 240 / chart.tempo.bpm : 2)) ? '  DROP WINDOW' : ''}`,
      `kick  ${mask(st.masks.low)}`,
      `mid   ${mask(st.masks.mid)}`,
      `hat   ${mask(st.masks.high)}`,
      `energy ${at(chart.curves.energy).toFixed(2)}  L ${at(chart.curves.low).toFixed(2)}  M ${at(chart.curves.mid).toFixed(2)}  H ${at(chart.curves.high).toFixed(2)}${breather ? '  BREATHER' : ''}`,
      `bullets ${String(this.visibleCount).padStart(4)} on screen · ${plan.bullets.count} total · ${plan.events.length} patterns`,
      `${chart.mode} · ${tempo} · difficulty ${plan.difficulty} · seed ${chart.meta.fileHash.slice(0, 8)}`,
    ].join('\n');
  }
}
