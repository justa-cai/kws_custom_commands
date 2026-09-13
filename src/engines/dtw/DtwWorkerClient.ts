/**
 * DTW Worker 的主线程侧代理。
 *
 * 对外长得像一个普通的 DTW 引擎：`feed()` / `onHit` / `reset()`。
 * 底下的线程边界藏在 `extract()` 和 `calibrate()` 这两个一次性调用里——
 * 它们要等结果，所以用 id 配上 Promise 做请求应答。
 */

import type { CalibrationResult } from './DtwEngine';
import type { DtwHit, DtwTemplate, VoiceCommand } from './types';
import type { DtwRequest, DtwResponse, DtwRuntimeOptions, ExtractedPayload } from './protocol';

export class DtwWorkerClient {
  private readonly worker: Worker;
  private seq = 0;
  private readonly pending = new Map<
    number,
    { resolve: (p: ExtractedPayload) => void; reject: (e: Error) => void }
  >();
  private readonly pendingCalibration = new Map<
    number,
    { resolve: (r: CalibrationResult) => void; reject: (e: Error) => void }
  >();

  onHit?: (hit: DtwHit) => void;
  onError?: (message: string) => void;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<DtwResponse>) => this.handle(ev.data);
    this.worker.onerror = (ev) => {
      this.onError?.(`DTW worker 崩了: ${ev.message}`);
    };
  }

  private handle(msg: DtwResponse): void {
    switch (msg.type) {
      case 'hit':
        this.onHit?.(msg.hit);
        break;
      case 'extracted': {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        entry?.resolve(msg.payload);
        break;
      }
      case 'calibrated': {
        const entry = this.pendingCalibration.get(msg.id);
        this.pendingCalibration.delete(msg.id);
        entry?.resolve(msg.result);
        break;
      }
      case 'error':
        this.onError?.(msg.message);
        for (const [, e] of this.pending) e.reject(new Error(msg.message));
        for (const [, e] of this.pendingCalibration) e.reject(new Error(msg.message));
        this.pending.clear();
        this.pendingCalibration.clear();
        break;
    }
  }

  private send(msg: DtwRequest): void {
    this.worker.postMessage(msg);
  }

  setCommands(commands: VoiceCommand[]): void {
    this.send({ type: 'setCommands', commands });
  }

  setOptions(options: DtwRuntimeOptions): void {
    this.send({ type: 'setOptions', options });
  }

  feed(chunk: Float32Array): void {
    this.send({ type: 'feed', chunk });
  }

  flush(): void {
    this.send({ type: 'flush' });
  }

  reset(): void {
    this.send({ type: 'reset' });
  }

  extract(samples: Float32Array): Promise<ExtractedPayload> {
    const id = ++this.seq;
    return new Promise<ExtractedPayload>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, type: 'extract', samples });
    });
  }

  calibrate(templates: DtwTemplate[], negative: DtwTemplate | null): Promise<CalibrationResult> {
    const id = ++this.seq;
    return new Promise<CalibrationResult>((resolve, reject) => {
      this.pendingCalibration.set(id, { resolve, reject });
      this.send({ id, type: 'calibrate', templates, negative });
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
    this.pendingCalibration.clear();
  }
}
