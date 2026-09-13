/**
 * 短时录音器：录一段就停，拿到完整的 16 kHz 单声道样本。
 *
 * 和检测用的 MicrophoneSource 是同一个采集实现，但用途不同：
 * 这里是"按住说话"式的整段收集，检测那边是流式。分开写是为了让
 * 录音过程能独立于检测会话——录命令词时检测会先停下来
 * （两个 getUserMedia 同时跑既浪费又容易互相干扰）。
 */

import { MicrophoneSource } from './AudioCapture';
import { TARGET_SAMPLE_RATE } from './constants';

export interface RecorderOptions {
  /** 超过这个时长自动停，防止用户忘了松手 */
  maxSeconds?: number;
  onLevel?: (rms: number) => void;
  onAutoStop?: () => void;
}

export class SampleRecorder {
  private source: MicrophoneSource | null = null;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private active = false;

  constructor(private readonly options: RecorderOptions = {}) {}

  get recording(): boolean {
    return this.active;
  }

  get durationSec(): number {
    return this.samples / TARGET_SAMPLE_RATE;
  }

  async start(deviceId?: string): Promise<void> {
    if (this.active) return;
    this.chunks = [];
    this.samples = 0;

    const max = this.options.maxSeconds ?? 5;
    const maxSamples = Math.round(max * TARGET_SAMPLE_RATE);

    this.source = new MicrophoneSource(deviceId);
    this.active = true;
    await this.source.start({
      onChunk: (chunk) => {
        if (!this.active) return;
        this.chunks.push(chunk);
        this.samples += chunk.length;
        if (this.samples >= maxSamples) {
          this.options.onAutoStop?.();
        }
      },
      onLevel: (rms) => this.options.onLevel?.(rms),
    });
  }

  /** 停止并返回录到的全部样本 */
  async stop(): Promise<Float32Array> {
    if (!this.active) return new Float32Array(0);
    this.active = false;
    await this.source?.stop();
    this.source = null;

    const out = new Float32Array(this.samples);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    this.chunks = [];
    return out;
  }

  async cancel(): Promise<void> {
    this.active = false;
    await this.source?.stop();
    this.source = null;
    this.chunks = [];
    this.samples = 0;
  }
}

/** 把 16 kHz 单声道样本编成 wav，用于在页面里回放试听 */
export function samplesToWavBlob(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, s * 32767, true);
    offset += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}
