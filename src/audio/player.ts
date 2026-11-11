/**
 * Playback with AudioContext.currentTime as the master clock.
 *
 * position = offsetAtStart + (ctx.currentTime - ctxTimeAtStart)
 *
 * `visualTime()` subtracts the output latency the browser reports, so what you see lines up
 * with what you hear on wired outputs. Bluetooth latency is often under-reported; the game
 * will add a manual calibration offset on top (milestone 5).
 */
export class Player {
  readonly ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startCtxTime = 0;
  private startOffset = 0;
  private pausedAt = 0;
  private _playing = false;
  readonly master: GainNode;
  /** Extra user calibration in seconds (positive = visuals later). */
  calibration = 0;
  onEnded: (() => void) | null = null;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
  }

  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(bytes);
  }

  load(buffer: AudioBuffer) {
    this.stopSource();
    this.buffer = buffer;
    this.pausedAt = 0;
    this._playing = false;
  }

  get playing() { return this._playing; }
  get duration() { return this.buffer?.duration ?? 0; }

  /** Song position in seconds according to the audio clock. */
  audioTime(): number {
    if (!this._playing) return this.pausedAt;
    return Math.min(this.duration, this.startOffset + (this.ctx.currentTime - this.startCtxTime));
  }

  /** Position of the sound currently reaching the speakers. */
  visualTime(): number {
    if (!this._playing) return this.pausedAt;
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.max(0, this.audioTime() - latency - this.calibration);
  }

  /** Convert a song time to an AudioContext time (for scheduling clicks). Only valid while playing. */
  songToCtxTime(t: number): number {
    return this.startCtxTime + (t - this.startOffset);
  }

  async play(from = this.pausedAt) {
    if (!this.buffer) return;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.master);
    const offset = Math.min(Math.max(0, from), this.buffer.duration);
    this.startCtxTime = this.ctx.currentTime + 0.02;
    this.startOffset = offset;
    src.start(this.startCtxTime, offset);
    src.onended = () => {
      if (this.source !== src) return;
      this._playing = false;
      this.pausedAt = this.duration;
      this.source = null;
      this.onEnded?.();
    };
    this.source = src;
    this._playing = true;
  }

  pause() {
    if (!this._playing) return;
    this.pausedAt = this.audioTime();
    this.stopSource();
    this._playing = false;
  }

  seek(t: number) {
    const clamped = Math.min(Math.max(0, t), this.duration);
    if (this._playing) void this.play(clamped);
    else this.pausedAt = clamped;
  }

  toggle() { if (this._playing) this.pause(); else void this.play(); }

  private stopSource() {
    if (!this.source) return;
    const s = this.source;
    this.source = null;
    s.onended = null;
    try { s.stop(); } catch { /* already stopped */ }
    s.disconnect();
  }
}

/**
 * Metronome on the detected beat grid, scheduled ahead on the audio clock
 * (the classic "two clocks" lookahead pattern). Lets you hear whether the grid is right.
 */
export class ClickTrack {
  enabled = false;
  private nextIndex = 0;
  private lastSongTime = -1;

  constructor(private player: Player, private getBeats: () => { t: number; beatInBar: number }[]) {}

  reset() { this.nextIndex = 0; this.lastSongTime = -1; }

  /** Call every animation frame. */
  update() {
    const beats = this.getBeats();
    if (!this.enabled || !this.player.playing || beats.length === 0) return;
    const now = this.player.audioTime();
    if (now < this.lastSongTime - 0.05 || now - this.lastSongTime > 0.5) {
      // seek happened: find the first beat after now
      this.nextIndex = beats.findIndex((b) => b.t >= now);
      if (this.nextIndex < 0) this.nextIndex = beats.length;
    }
    this.lastSongTime = now;
    const horizon = now + 0.15;
    const ctx = this.player.ctx;
    while (this.nextIndex < beats.length && beats[this.nextIndex].t < horizon) {
      const b = beats[this.nextIndex++];
      const when = this.player.songToCtxTime(b.t);
      if (when < ctx.currentTime) continue;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = b.beatInBar === 0 ? 1600 : 1000;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.5, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      osc.connect(g).connect(this.player.master);
      osc.start(when);
      osc.stop(when + 0.06);
    }
  }
}
