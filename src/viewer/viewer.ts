import { Application, Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import { sampleCurve, type AnalysisResult } from '../chart/types';

const C = {
  bg: 0x0d0f14,
  lane: 0x151922,
  laneEdge: 0x232a38,
  text: 0x9aa7bd,
  wave: 0x8fa3bf,
  beat: 0xffffff,
  energy: 0xffd166,
  novelty: 0xffffff,
  low: 0xef476f,
  mid: 0x06d6a0,
  high: 0x4cc9f0,
  drop: 0xff3864,
  build: 0xff3864,
  quiet: 0x3a86ff,
  playhead: 0xffffff,
  sectionA: 0x1b2130,
  sectionB: 0x161b27,
};

const GUTTER = 72;
const PLAYHEAD_FRAC = 0.3;
const CHUNK_PX = 1024;

interface Lane { key: 'wave' | 'energy' | 'low' | 'mid' | 'high'; label: string; y: number; h: number; color: number }

const label = (text: string, size = 11, fill = C.text, weight: TextStyleOptions['fontWeight'] = '500') =>
  new Text({ text, style: { fontFamily: 'Inter, system-ui, sans-serif', fontSize: size, fill, fontWeight: weight } });

export class Viewer {
  private app = new Application();
  private data: AnalysisResult | null = null;
  private windowSec = 12;
  private width = 0;
  private height = 0;
  private lanes: Lane[] = [];
  private overview = new Container();
  private overviewPlayhead = new Graphics();
  private overviewWindow = new Graphics();
  private detail = new Container();
  private detailMask = new Graphics();
  private chunks = new Map<number, Container>();
  private chunkLayer = new Container();
  private hud = new Container();
  private hudLabels = new Container();
  private laneBg = new Graphics();
  private overviewBody = new Container();
  private playheadG = new Graphics();
  private meters = new Graphics();
  private pulse = new Graphics();
  private pulseLevel = 0;
  private lastBeatIdx = -1;
  private rebuildTimer: number | undefined;
  private builtPxPerSec = 0;

  /** Called when the user clicks/drags to a time. */
  onSeek: ((t: number) => void) | null = null;
  /** Called on wheel zoom so the UI can mirror it. */
  onZoom: ((windowSec: number) => void) | null = null;

  async init(host: HTMLElement) {
    await this.app.init({
      resizeTo: host,
      background: C.bg,
      antialias: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      autoDensity: true,
    });
    host.appendChild(this.app.canvas);
    this.detail.addChild(this.laneBg, this.chunkLayer);
    this.detail.mask = this.detailMask;
    this.overview.addChild(this.overviewBody, this.overviewWindow, this.overviewPlayhead);
    this.hud.addChild(this.hudLabels, this.meters, this.pulse, this.playheadG);
    this.app.stage.addChild(this.overview, this.detail, this.detailMask, this.hud);
    this.app.renderer.on('resize', () => this.layout());
    // resizeTo only reacts to window resizes; the host also changes size when UI appears
    new ResizeObserver(() => this.app.resize()).observe(host);
    this.bindInput(this.app.canvas);
    this.layout();
  }

  setData(data: AnalysisResult) {
    this.data = data;
    this.lastBeatIdx = -1;
    this.layout();
  }

  get zoom() { return this.windowSec; }
  setZoom(windowSec: number) {
    const w = Math.min(60, Math.max(3, windowSec));
    if (w === this.windowSec) return;
    this.windowSec = w;
    this.onZoom?.(w);
    // instant preview by scaling the existing chunks, then rebuild crisp geometry
    window.clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => this.clearChunks(), 120);
  }

  private get detailW() { return Math.max(100, this.width - GUTTER - 12); }
  private get pxPerSec() { return this.detailW / this.windowSec; }
  private get playheadX() { return GUTTER + this.detailW * PLAYHEAD_FRAC; }
  private get overviewRect() { return { x: GUTTER, y: 10, w: this.detailW, h: 56 }; }

  private layout() {
    this.width = this.app.screen.width;
    this.height = this.app.screen.height;
    const top = 92;
    const avail = this.height - top - 18;
    const gap = 6;
    const unit = (avail - gap * 4) / (2.6 + 1.2 + 3 * 0.9);
    let y = top;
    const mk = (key: Lane['key'], labelText: string, rel: number, color: number): Lane => {
      const lane = { key, label: labelText, y, h: Math.round(unit * rel), color };
      y += lane.h + gap;
      return lane;
    };
    this.lanes = [
      mk('wave', 'WAVE', 2.6, C.wave),
      mk('energy', 'ENERGY', 1.2, C.energy),
      mk('low', 'LOW', 0.9, C.low),
      mk('mid', 'MID', 0.9, C.mid),
      mk('high', 'HIGH', 0.9, C.high),
    ];
    this.detailMask.clear().rect(GUTTER, top - 4, this.detailW, y - top).fill(0xffffff);
    this.buildStatic();
    this.buildOverview();
    this.clearChunks();
  }

  // ------------------------------------------------------------------ static chrome

  private buildStatic() {
    this.hudLabels.removeChildren().forEach((c) => c.destroy());
    this.laneBg.clear();
    for (const l of this.lanes) {
      this.laneBg.rect(GUTTER, l.y, this.detailW, l.h).fill(C.lane);
      const t = label(l.label, 10, l.color, '700');
      t.position.set(8, l.y + 4);
      this.hudLabels.addChild(t);
    }
    const ov = label('SONG', 10, C.text, '700');
    ov.position.set(8, this.overviewRect.y + 4);
    this.hudLabels.addChild(ov);
  }

  // ------------------------------------------------------------------ overview strip

  private buildOverview() {
    this.overviewBody.removeChildren().forEach((c) => c.destroy());
    const r = this.overviewRect;
    const g = new Graphics();
    g.rect(r.x, r.y, r.w, r.h).fill(C.lane);
    this.overviewBody.addChild(g);
    if (!this.data) return;
    const { chart, waveform } = this.data;
    const dur = chart.meta.durationSec;
    const xOf = (t: number) => r.x + (t / dur) * r.w;

    for (const s of chart.sections) g.rect(xOf(s.start), r.y, xOf(s.end) - xOf(s.start), r.h).fill(s.index % 2 ? C.sectionB : C.sectionA);
    for (const q of chart.quiet) g.rect(xOf(q.start), r.y, xOf(q.end) - xOf(q.start), r.h).fill({ color: C.quiet, alpha: 0.18 });
    for (const d of chart.drops) if (d.buildStart != null) this.buildRamp(g, xOf(d.buildStart), xOf(d.t), r.y, r.h, 0.35);

    // waveform: min/max per pixel column
    const mid = r.y + r.h / 2;
    const perPx = waveform.min.length / r.w;
    for (let x = 0; x < r.w; x++) {
      let lo = 0, hi = 0;
      for (let i = Math.floor(x * perPx); i < Math.floor((x + 1) * perPx); i++) {
        if (waveform.min[i] < lo) lo = waveform.min[i];
        if (waveform.max[i] > hi) hi = waveform.max[i];
      }
      g.rect(r.x + x, mid - hi * (r.h / 2), 1, Math.max(1, (hi - lo) * (r.h / 2)));
    }
    g.fill({ color: C.wave, alpha: 0.75 });
    // energy line
    for (let x = 0; x < r.w; x += 2) {
      const v = sampleCurve(chart.curves.energy, chart.curves.hopSec, (x / r.w) * dur);
      const y = r.y + r.h - v * r.h;
      if (x === 0) g.moveTo(r.x, y); else g.lineTo(r.x + x, y);
    }
    g.stroke({ width: 1.5, color: C.energy, alpha: 0.9 });
    for (const s of chart.sections.slice(1)) g.rect(xOf(s.start), r.y, 1, r.h).fill({ color: 0xffffff, alpha: 0.35 });
    for (const d of chart.drops) {
      const x = xOf(d.t);
      g.rect(x - 1, r.y, 2, r.h).fill(C.drop);
      g.poly([x - 5, r.y, x + 5, r.y, x, r.y + 8]).fill(C.drop);
    }
  }

  private buildRamp(g: Graphics, x0: number, x1: number, y: number, h: number, maxAlpha: number) {
    const steps = Math.max(1, Math.min(40, Math.floor((x1 - x0) / 3)));
    const w = (x1 - x0) / steps;
    for (let i = 0; i < steps; i++) g.rect(x0 + i * w, y, w + 0.5, h).fill({ color: C.build, alpha: (maxAlpha * (i + 1)) / steps });
  }

  // ------------------------------------------------------------------ detail chunks

  private clearChunks() {
    for (const c of this.chunks.values()) c.destroy({ children: true });
    this.chunks.clear();
    this.chunkLayer.scale.x = 1;
    this.builtPxPerSec = this.pxPerSec;
  }

  private ensureChunks(t: number) {
    if (!this.data) return;
    const pps = this.builtPxPerSec;
    const chunkSec = CHUNK_PX / pps;
    const viewStart = t - (this.playheadX - GUTTER) / this.pxPerSec;
    const viewEnd = viewStart + this.windowSec;
    const first = Math.max(0, Math.floor(viewStart / chunkSec));
    const last = Math.min(Math.ceil(this.data.chart.meta.durationSec / chunkSec), Math.floor(viewEnd / chunkSec));
    for (let i = first; i <= last; i++) if (!this.chunks.has(i)) this.chunks.set(i, this.buildChunk(i, chunkSec, pps));
    for (const [i, c] of this.chunks) if (i < first - 2 || i > last + 2) { c.destroy({ children: true }); this.chunks.delete(i); }
  }

  private buildChunk(index: number, chunkSec: number, pps: number): Container {
    const { chart, waveform } = this.data!;
    const t0 = index * chunkSec, t1 = Math.min(chart.meta.durationSec, t0 + chunkSec);
    const c = new Container();
    c.x = t0 * pps;
    const xOf = (t: number) => (t - t0) * pps;
    const lane = (k: Lane['key']) => this.lanes.find((l) => l.key === k)!;
    const top = this.lanes[0].y, bottom = this.lanes[this.lanes.length - 1].y + this.lanes[this.lanes.length - 1].h;
    const width = Math.ceil((t1 - t0) * pps);
    const overlaps = (a: number, b: number) => b > t0 && a < t1;

    // ---- overlays behind the data: sections, quiet, builds
    const back = new Graphics();
    for (const s of chart.sections) if (overlaps(s.start, s.end) && s.index % 2 === 1)
      back.rect(xOf(Math.max(s.start, t0)), top, xOf(Math.min(s.end, t1)) - xOf(Math.max(s.start, t0)), bottom - top).fill({ color: 0xffffff, alpha: 0.025 });
    for (const q of chart.quiet) if (overlaps(q.start, q.end))
      back.rect(xOf(Math.max(q.start, t0)), top, xOf(Math.min(q.end, t1)) - xOf(Math.max(q.start, t0)), bottom - top).fill({ color: C.quiet, alpha: 0.12 });
    for (const d of chart.drops) if (d.buildStart != null && overlaps(d.buildStart, d.t)) {
      // full ramp geometry in song space, clipped by chunk bounds
      const a = xOf(d.buildStart), b = xOf(d.t);
      const steps = Math.max(1, Math.min(60, Math.floor((b - a) / 6)));
      const w = (b - a) / steps;
      for (let i = 0; i < steps; i++) {
        const x = a + i * w;
        if (x + w < 0 || x > width) continue;
        back.rect(x, top, w + 0.5, bottom - top).fill({ color: C.build, alpha: (0.22 * (i + 1)) / steps });
      }
    }
    c.addChild(back);

    // ---- beat grid
    const grid = new Graphics();
    for (const b of chart.beats) {
      if (b.t < t0 || b.t >= t1) continue;
      const down = b.beatInBar === 0;
      grid.rect(Math.round(xOf(b.t)), top, 1, bottom - top).fill({ color: C.beat, alpha: down ? 0.32 : 0.1 });
      if (down && pps > 25) {
        const t = label(String(b.barIndex + 1), 9, C.text);
        t.alpha = 0.6;
        t.position.set(Math.round(xOf(b.t)) + 3, top + 2);
        c.addChild(t);
      }
    }
    c.addChildAt(grid, 1);

    // ---- waveform
    const wl = lane('wave');
    const wg = new Graphics();
    const mid = wl.y + wl.h / 2, amp = wl.h / 2 - 4;
    for (let x = 0; x < width; x++) {
      const a = Math.floor((t0 + x / pps) * waveform.peaksPerSec);
      const b = Math.max(a + 1, Math.floor((t0 + (x + 1) / pps) * waveform.peaksPerSec));
      let lo = 0, hi = 0;
      for (let i = a; i < b && i < waveform.min.length; i++) {
        if (waveform.min[i] < lo) lo = waveform.min[i];
        if (waveform.max[i] > hi) hi = waveform.max[i];
      }
      wg.rect(x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    }
    wg.fill({ color: C.wave, alpha: 0.85 });
    c.addChild(wg);

    // ---- energy + novelty
    const el = lane('energy');
    const eg = new Graphics();
    const step = Math.max(1, Math.floor(pps / 120));
    const curvePath = (curve: Float32Array, l: Lane) => {
      for (let x = 0; x <= width; x += step) {
        const v = sampleCurve(curve, chart.curves.hopSec, t0 + x / pps);
        const y = l.y + l.h - 3 - v * (l.h - 6);
        if (x === 0) eg.moveTo(x, y); else eg.lineTo(x, y);
      }
    };
    curvePath(chart.curves.novelty, el);
    eg.stroke({ width: 1, color: C.novelty, alpha: 0.25 });
    curvePath(chart.curves.energy, el);
    eg.stroke({ width: 2, color: C.energy });
    c.addChild(eg);

    // ---- bands: filled areas + onset ticks
    for (const key of ['low', 'mid', 'high'] as const) {
      const l = lane(key);
      const bg = new Graphics();
      for (let x = 0; x < width; x += step) {
        const v = sampleCurve(chart.curves[key], chart.curves.hopSec, t0 + x / pps);
        const h = v * (l.h - 4);
        bg.rect(x, l.y + l.h - h, step, h);
      }
      bg.fill({ color: l.color, alpha: 0.55 });
      for (const t of chart.onsets[key]) {
        if (t < t0 || t >= t1) continue;
        bg.rect(Math.round(xOf(t)), l.y, 1, 7);
      }
      bg.fill({ color: l.color, alpha: 1 });
      c.addChild(bg);
    }

    // ---- section boundaries and drops on top
    const fore = new Graphics();
    for (const s of chart.sections) {
      if (s.index === 0 || s.start < t0 || s.start >= t1) continue;
      fore.rect(Math.round(xOf(s.start)) - 1, top, 2, bottom - top).fill({ color: 0xffffff, alpha: 0.6 });
    }
    for (const s of chart.sections) {
      if (s.start < t0 || s.start >= t1) continue;
      const t = label(`§${s.index + 1} ${s.intensity}`, 10, 0xffffff, '700');
      t.alpha = 0.75;
      t.position.set(Math.round(xOf(s.start)) + 5, bottom - 16);
      c.addChild(t);
    }
    for (const q of chart.quiet) {
      if (q.start < t0 || q.start >= t1) continue;
      const t = label('quiet', 10, C.quiet, '700');
      t.position.set(Math.round(xOf(q.start)) + 5, wl.y + wl.h - 16);
      c.addChild(t);
    }
    for (const d of chart.drops) {
      if (d.buildStart != null && d.buildStart >= t0 && d.buildStart < t1) {
        const t = label('build ▶', 10, C.build, '700');
        t.position.set(Math.round(xOf(d.buildStart)) + 5, wl.y + 16);
        c.addChild(t);
      }
      if (d.t < t0 || d.t >= t1) continue;
      const x = Math.round(xOf(d.t));
      fore.rect(x - 1.5, top, 3, bottom - top).fill(C.drop);
      fore.poly([x - 8, top, x + 8, top, x, top + 12]).fill(C.drop);
      const t = label(`DROP ${(d.intensity * 100).toFixed(0)}%`, 11, C.drop, '800');
      t.position.set(x + 6, top + 14);
      c.addChild(t);
    }
    c.addChild(fore);
    this.chunkLayer.addChild(c);
    return c;
  }

  // ------------------------------------------------------------------ per frame

  /** Call every animation frame with the playhead time (visual time). */
  update(t: number) {
    this.currentT = t;
    const ph = this.playheadX;
    if (this.data) {
      this.ensureChunks(t);
      const scale = this.pxPerSec / this.builtPxPerSec;
      this.chunkLayer.scale.x = scale;
      this.chunkLayer.x = ph - t * this.pxPerSec;
    }
    const top = this.lanes[0].y, last = this.lanes[this.lanes.length - 1];
    this.playheadG.clear().rect(ph - 1, top - 4, 2, last.y + last.h - top + 4).fill(C.playhead);

    const r = this.overviewRect;
    const dur = this.data?.chart.meta.durationSec || 1;
    const xOf = (s: number) => r.x + (s / dur) * r.w;
    this.overviewPlayhead.clear().rect(xOf(t) - 1, r.y - 3, 2, r.h + 6).fill(C.playhead);
    const ws = t - this.windowSec * PLAYHEAD_FRAC;
    this.overviewWindow.clear().rect(xOf(ws), r.y, (this.windowSec / dur) * r.w, r.h).stroke({ width: 1, color: 0xffffff, alpha: 0.5 });

    this.drawMeters(t);
  }

  private drawMeters(t: number) {
    const m = this.meters.clear();
    if (!this.data) return;
    const { chart } = this.data;
    for (const l of this.lanes) {
      if (l.key === 'wave') continue;
      const v = sampleCurve(chart.curves[l.key], chart.curves.hopSec, t);
      const h = l.h - 22;
      m.rect(10, l.y + 18, 8, h).fill({ color: 0xffffff, alpha: 0.08 });
      m.rect(10, l.y + 18 + h * (1 - v), 8, h * v).fill(l.color);
    }
    // beat pulse in the waveform lane gutter
    const beats = chart.beats;
    let idx = this.lastBeatIdx;
    if (idx >= beats.length || (idx >= 0 && beats[idx].t > t)) idx = -1;
    while (idx + 1 < beats.length && beats[idx + 1].t <= t) idx++;
    if (idx !== this.lastBeatIdx && idx >= 0 && t - beats[idx].t < 0.1) this.pulseLevel = beats[idx].beatInBar === 0 ? 1 : 0.6;
    this.lastBeatIdx = idx;
    this.pulseLevel *= 0.88;
    const wl = this.lanes[0];
    const big = idx >= 0 && beats[idx].beatInBar === 0;
    this.pulse.clear()
      .circle(36, wl.y + wl.h / 2 + 8, big ? 14 : 10).stroke({ width: 1, color: 0xffffff, alpha: 0.2 })
      .circle(36, wl.y + wl.h / 2 + 8, (big ? 14 : 10) * (0.4 + 0.6 * this.pulseLevel)).fill({ color: 0xffffff, alpha: this.pulseLevel });
  }

  // ------------------------------------------------------------------ input

  private bindInput(canvas: HTMLCanvasElement) {
    let dragging: 'overview' | 'detail' | null = null;
    let dragStartX = 0, dragStartT = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const overviewT = (x: number) => {
      const r = this.overviewRect;
      return ((x - r.x) / r.w) * (this.data?.chart.meta.durationSec ?? 0);
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.data) return;
      const p = local(e);
      try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
      const r = this.overviewRect;
      if (p.y <= r.y + r.h + 8) { dragging = 'overview'; this.onSeek?.(overviewT(p.x)); }
      else if (p.x > GUTTER) {
        dragging = 'detail';
        dragStartX = p.x;
        dragStartT = this.currentT;
      }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const p = local(e);
      if (dragging === 'overview') this.onSeek?.(overviewT(p.x));
      else if (Math.abs(p.x - dragStartX) > 3) this.onSeek?.(dragStartT - (p.x - dragStartX) / this.pxPerSec);
    });
    canvas.addEventListener('pointerup', (e) => {
      const p = local(e);
      if (dragging === 'detail' && Math.abs(p.x - dragStartX) <= 3) {
        // click in the detail view: jump to that time
        this.onSeek?.(dragStartT + (p.x - this.playheadX) / this.pxPerSec);
      }
      dragging = null;
    });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.setZoom(this.windowSec * Math.exp(e.deltaY * 0.0015));
    }, { passive: false });
  }

  /** Last time passed to update(); used for drag-scrubbing. */
  currentT = 0;
}
