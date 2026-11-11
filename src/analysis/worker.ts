/// <reference lib="webworker" />
import { analyze } from './analyze';
import type { AnalysisResult } from '../chart/types';

export type WorkerRequest = {
  type: 'analyze';
  channels: Float32Array[];
  sampleRate: number;
  fileHash: string;
  fileName: string;
};

export type WorkerResponse =
  | { type: 'progress'; fraction: number; stage: string }
  | { type: 'done'; result: AnalysisResult }
  | { type: 'error'; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type !== 'analyze') return;
  try {
    const result = analyze(req.channels, req.sampleRate, {
      fileHash: req.fileHash,
      fileName: req.fileName,
      onProgress: (fraction, stage) => ctx.postMessage({ type: 'progress', fraction, stage } satisfies WorkerResponse),
    });
    const c = result.chart.curves;
    const transfer = [c.energy, c.low, c.mid, c.high, c.novelty, result.waveform.min, result.waveform.max].map((a) => a.buffer);
    ctx.postMessage({ type: 'done', result } satisfies WorkerResponse, transfer);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies WorkerResponse);
  }
};
