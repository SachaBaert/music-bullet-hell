import type { AnalysisResult } from '../chart/types';
import type { WorkerRequest, WorkerResponse } from './worker';

/** Run the analyzer in a Web Worker. Copies the channel data so the AudioBuffer stays usable. */
export function analyzeInWorker(
  buffer: AudioBuffer,
  meta: { fileHash: string; fileName: string },
  onProgress: (fraction: number, stage: string) => void,
): Promise<AnalysisResult> {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i).slice());
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === 'progress') onProgress(msg.fraction, msg.stage);
      else {
        worker.terminate();
        if (msg.type === 'done') resolve(msg.result);
        else reject(new Error(msg.message));
      }
    };
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Worker failed')); };
    const req: WorkerRequest = { type: 'analyze', channels, sampleRate: buffer.sampleRate, ...meta };
    worker.postMessage(req, channels.map((c) => c.buffer));
  });
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
