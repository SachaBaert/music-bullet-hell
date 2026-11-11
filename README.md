# Music Bullet Hell

A browser bullet hell where the music drives the enemy patterns and the player's powers.
Bring your own MP3s: each song is analyzed locally, before playback, into a **chart** the game plays from.

**Live:** https://sachabaert.github.io/music-bullet-hell/

## Status: milestone 1, the analysis viewer

Drop an audio file and you get:

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

## Develop

```bash
npm install
npm run dev     # http://localhost:5173/music-bullet-hell/
npm test        # analysis tests on synthetic tracks
npm run build
```

Pushing to `main` runs tests, builds, and deploys to GitHub Pages via GitHub Actions.
