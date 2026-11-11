# Music Bullet Hell

A browser bullet hell where the music drives the enemy patterns and the player's powers.
Bring your own MP3s: each song is analyzed locally, before playback, into a **chart** the game plays from.

**Live:** https://sachabaert.github.io/music-bullet-hell/

## Status: milestone 2, emitters

Two views share one loaded track (switch with the tabs or **G**):

**Game** (milestone 2): the chart drives enemy emitters. No player yet; a static target dot marks where patterns aim.

- **kick → rings** from the top emitter, **mids → aimed bursts or a spiral** (picked per section), **hats → one stream** on the song's regularized hat sub-rhythm
- every pattern is scheduled backwards from its beat so it **arrives on the beat**; the target pulses on each arrival
- density and speed follow the per-track **energy**; quiet parts are **breathers**
- patterns are seeded with `chart.meta.fileHash`: the same file always plays the same way
- **Debug curves** (**D**) draws energy/low/mid/high/novelty under the arena, with the beat grid, breathers, sections, drops and every scheduled arrival as a tick that crosses the now line when it lands

**Viewer** (milestone 1): drop an audio file and you get

- waveform with the **beat grid** (downbeats and bar numbers)
- **energy** curve plus structural novelty
- **low / mid / high** band energy, with per-band onsets
- **sections**, **drops** with their **build-ups**, and **quiet** passages
- a playhead synced to `AudioContext.currentTime`, an optional click track on the beat grid to check it by ear, and an A/V offset field
- **Export chart JSON** to inspect the exact data the game will consume

Everything runs in the browser; nothing is uploaded.

## Architecture

```
src/chart/types.ts       Chart: the typed contract between analysis and game
src/analysis/analyze.ts  Pure analysis function (no DOM), runs in a Web Worker and in Node tests
src/analysis/dsp.ts      FFT and small DSP helpers
src/analysis/worker.ts   Worker entry; client.ts wraps it in a Promise
src/audio/player.ts      Playback with the audio clock as master clock + click track
src/viewer/viewer.ts     PixiJS renderer (overview strip + zoomable lanes, chunked rendering)
src/game/patterns.ts     Pure, seeded pattern generator: Chart → Plan (events + bullets)
src/game/grid.ts         Beat grid with 16th subdivisions, per-band rhythm masks
src/game/rng.ts          Seeded PRNG streams derived from the file hash
src/game/game.ts         PixiJS game view: emitters, bullets, target, debug overlay
tests/                   Synthetic tracks with known ground truth (vitest)
```

### Analysis pipeline (custom DSP, ~13 KB)

1. STFT (Hann, ~46 ms frames, 75 % overlap) on the mono mixdown
2. Short-term loudness per band → dB → per-track percentile normalization (p5 → 0, p95 → 1)
3. Spectral flux on 64 log-compressed mel bands (+ an explicit bass term for beat tracking)
4. Tempo: onset autocorrelation with a prior around 120 BPM, plus a windowed stability check → confidence
5. Beats: dynamic-programming beat tracker (Ellis 2007); downbeat phase from bass onsets, harmonic change, energy rises and backbeat
6. Sections: Foote checkerboard novelty on a self-similarity matrix (spectral shape + chroma)
7. Drops: bass comes in hard and stays at near-full loudness; build = rising energy/brightness before it
8. Quiet: sustained low normalized energy
9. **Fallback mode** when beat confidence is low: no grid, energy/sections only

### Pattern generation (milestone 2)

Bullets move in straight lines, so a bullet's position is a pure function of song time: `p(t) = p0 + v·(t − t0)`.
The generator picks the **arrival** time first (a 16th-note grid step, or an onset in fallback mode) and derives the spawn time
from the distance and speed. The game view just asks "which bullets are alive at t?" each frame, so seeking and pausing need no simulation.

Per section, each band gets a **rhythm mask**: how often each 16th position in the bar carries an onset of that band.
Steps that recur in ≥ 25–30 % of bars form the band's sub-rhythm; energy decides how many of them (strongest first) actually fire.

## Develop

```bash
npm install
npm run dev     # http://localhost:5173/music-bullet-hell/
npm test        # analysis + pattern tests on synthetic tracks
npm run build
```

Pushing to `main` runs tests, builds, and deploys to GitHub Pages via GitHub Actions.
