import './style.css';
import { analyzeInWorker, sha256Hex } from './analysis/client';
import { ClickTrack, Player } from './audio/player';
import { chartToJSON, type AnalysisResult, type Chart } from './chart/types';
import { Viewer } from './viewer/viewer';
import { GameView } from './game/game';
import { generatePlan, type Plan } from './game/patterns';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const player = new Player();
const viewer = new Viewer();
const game = new GameView();
let current: AnalysisResult | null = null;
let plan: Plan | null = null;
type View = 'viewer' | 'game';
let view: View = 'viewer';
const click = new ClickTrack(player, () => current?.chart.beats ?? []);

/** Exposed for debugging in the console: window.chart */
declare global { interface Window { chart?: Chart; plan?: Plan } }

async function main() {
  await viewer.init($('canvas-host'));
  await game.init($('game-host'));
  viewer.onSeek = (t) => { player.seek(t); click.reset(); };
  viewer.onZoom = (w) => { ($('zoom') as HTMLInputElement).value = String(Math.round(w)); $('zoom-label').textContent = `${Math.round(w)} s`; };
  bindUI();
  setView(location.hash === '#game' ? 'game' : 'viewer');
  requestAnimationFrame(frame);
}

function frame() {
  const t = player.visualTime();
  if (view === 'viewer') viewer.update(t); else game.update(t);
  click.update();
  updateTimeReadout(t);
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- loading

async function loadFile(file: File) {
  const dz = $('dropzone');
  dz.classList.remove('hidden');
  $('error').hidden = true;
  $('progress').hidden = false;
  setProgress(0, 'reading file');
  player.pause();
  try {
    const bytes = await file.arrayBuffer();
    const fileHash = await sha256Hex(bytes); // decodeAudioData detaches the buffer, so hash first
    setProgress(0.02, 'decoding audio');
    const buffer = await player.decode(bytes);
    const result = await analyzeInWorker(buffer, { fileHash, fileName: file.name }, (f, stage) => setProgress(f, stage));
    current = result;
    window.chart = result.chart;
    player.load(buffer);
    click.reset();
    viewer.setData(result);
    buildPlan();
    renderStats(result.chart);
    $('file').textContent = file.name;
    $('controls').hidden = false;
    dz.classList.add('hidden');
    $('progress').hidden = true;
    updatePlayButton();
  } catch (err) {
    console.error(err);
    $('progress').hidden = true;
    const e = $('error');
    e.hidden = false;
    e.textContent = `Could not load "${file.name}": ${err instanceof Error ? err.message : String(err)}`;
  }
}

function difficulty() { return Number(($('difficulty') as HTMLSelectElement).value) || 0.7; }

function buildPlan() {
  if (!current) return;
  const t0 = performance.now();
  plan = generatePlan(current.chart, { difficulty: difficulty() });
  window.plan = plan;
  game.setData(current.chart, plan);
  console.info(`plan: ${plan.events.length} patterns, ${plan.bullets.count} bullets in ${(performance.now() - t0).toFixed(1)} ms`);
}

function setView(v: View) {
  view = v;
  document.body.dataset.view = v;
  $('canvas-host').hidden = v !== 'viewer';
  $('game-host').hidden = v !== 'game';
  viewer.setActive(v === 'viewer');
  game.setActive(v === 'game');
  $('tab-viewer').classList.toggle('active', v === 'viewer');
  $('tab-game').classList.toggle('active', v === 'game');
  history.replaceState(null, '', v === 'game' ? '#game' : location.pathname + location.search);
}

function setProgress(f: number, stage: string) {
  $('progress-fill').style.width = `${Math.round(f * 100)}%`;
  $('progress-label').textContent = `${stage}… ${Math.round(f * 100)}%`;
}

// ---------------------------------------------------------------- UI

function bindUI() {
  const picker = $('picker') as HTMLInputElement;
  picker.addEventListener('change', () => { if (picker.files?.[0]) void loadFile(picker.files[0]); picker.value = ''; });

  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; document.body.classList.add('dragging'); $('dropzone').classList.add('over'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); $('dropzone').classList.remove('over'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    $('dropzone').classList.remove('over');
    const file = Array.from(e.dataTransfer?.files ?? []).find((f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name));
    if (file) void loadFile(file);
  });

  $('play').addEventListener('click', togglePlay);
  player.onEnded = updatePlayButton;

  const clickBox = $('click') as HTMLInputElement;
  clickBox.addEventListener('change', () => { click.enabled = clickBox.checked; click.reset(); });

  const zoom = $('zoom') as HTMLInputElement;
  zoom.addEventListener('input', () => viewer.setZoom(Number(zoom.value)));

  const offset = $('offset') as HTMLInputElement;
  offset.addEventListener('input', () => { player.calibration = (Number(offset.value) || 0) / 1000; });

  $('export').addEventListener('click', exportChart);

  for (const v of ['viewer', 'game'] as const) {
    const tab = $(`tab-${v}`);
    tab.addEventListener('click', () => { setView(v); tab.blur(); });
  }
  const debugBox = $('debug') as HTMLInputElement;
  debugBox.addEventListener('change', () => { game.debug = debugBox.checked; });
  $('difficulty').addEventListener('change', () => { buildPlan(); if (current) renderStats(current.chart); });

  window.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (el.tagName === 'SELECT' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'number')) return;
    if (e.key.toLowerCase() === 'g' && !e.ctrlKey && !e.metaKey) { setView(view === 'viewer' ? 'game' : 'viewer'); return; }
    if (!current) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') { player.seek(player.audioTime() - 5); click.reset(); }
    else if (e.code === 'ArrowRight') { player.seek(player.audioTime() + 5); click.reset(); }
    else if (e.key === '+' || e.key === '=') viewer.setZoom(viewer.zoom / 1.25);
    else if (e.key === '-') viewer.setZoom(viewer.zoom * 1.25);
    else if (e.key.toLowerCase() === 'd' && view === 'game') { debugBox.checked = !debugBox.checked; debugBox.dispatchEvent(new Event('change')); }
    else if (e.key.toLowerCase() === 'c') { clickBox.checked = !clickBox.checked; clickBox.dispatchEvent(new Event('change')); }
  });
}

function togglePlay() {
  if (!current) return;
  if (!player.playing && player.audioTime() >= player.duration - 0.01) player.seek(0);
  player.toggle();
  click.reset();
  updatePlayButton();
}

function updatePlayButton() {
  $('play').textContent = player.playing ? '❚❚ Pause' : '▶ Play';
}

function fmt(t: number, ms = true) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${ms ? s.toFixed(3).padStart(6, '0') : String(Math.floor(s)).padStart(2, '0')}`;
}

let lastNowHtml = '';
function updateTimeReadout(t: number) {
  if (!current) return;
  const c = current.chart;
  $('time').textContent = `${fmt(t)} / ${fmt(c.meta.durationSec, false)}`;
  const sec = c.sections.find((s) => t >= s.start && t < s.end);
  const tags: string[] = [];
  if (sec) tags.push(`<span class="tag">§${sec.index + 1} · ${sec.intensity}</span>`);
  if (c.tempo && c.beats.length) {
    const b = [...c.beats].reverse().find((x) => x.t <= t);
    if (b) tags.push(`<span class="tag mono">bar ${b.barIndex + 1}.${b.beatInBar + 1}</span>`);
  }
  if (c.quiet.some((q) => t >= q.start && t < q.end)) tags.push('<span class="tag quiet">quiet</span>');
  const build = c.drops.find((d) => d.buildStart != null && t >= d.buildStart && t < d.t);
  if (build) tags.push(`<span class="tag build">build · drop in ${(build.t - t).toFixed(1)} s</span>`);
  if (c.drops.some((d) => t >= d.t && t < d.t + 2)) tags.push('<span class="tag drop">DROP</span>');
  const html = tags.join('');
  if (html !== lastNowHtml) { $('now').innerHTML = html; lastNowHtml = html; }
}

function renderStats(c: Chart) {
  const chips: string[] = [];
  const chip = (k: string, v: string, cls = '') => chips.push(`<span class="chip ${cls}">${k}<b>${v}</b></span>`);
  if (c.tempo) {
    chip('BPM', c.tempo.bpm.toFixed(1));
    chip('beat confidence', `${Math.round(c.tempo.confidence * 100)}%`);
    chip('bars', String(Math.max(0, ...c.beats.map((b) => b.barIndex)) + 1));
  } else {
    chip('mode', 'fallback: no reliable beat grid', 'warn');
  }
  chip('length', fmt(c.meta.durationSec, false));
  chip('sections', String(c.sections.length));
  chip('drops', String(c.drops.length));
  chip('quiet parts', String(c.quiet.length));
  chip('onsets L/M/H', `${c.onsets.low.length}/${c.onsets.mid.length}/${c.onsets.high.length}`);
  chip('analysis', `${c.meta.analysisMs} ms`);
  chip('seed', c.meta.fileHash.slice(0, 8));
  if (plan) chip('patterns / bullets', `${plan.events.length} / ${plan.bullets.count}`);
  const el = $('stats');
  el.innerHTML = chips.join('');
  el.hidden = false;
}

function exportChart() {
  if (!current) return;
  const blob = new Blob([JSON.stringify(chartToJSON(current.chart), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${current.chart.meta.fileName.replace(/\.[^.]+$/, '')}.chart.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

void main();
