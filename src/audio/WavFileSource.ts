/**
 * 文件音频源：把 wav/mp3/… 解码成 16 kHz 单声道，再按同样的 64 ms 定长块
 * 灌进流水线。
 *
 * 存在的意义有两个，都很实际：
 *   1. 没麦克风的环境（CI、别人刚 clone 下来、静音的远程桌面）也能验证整套逻辑；
 *   2. 调 DTW 阈值时，能用同一段音频反复跑——靠嘴重复同一句话是不可复现的。
 *
 * 重采样交给 OfflineAudioContext 做，它比我们自己写的插值器质量好得多。
 */

import { CHUNK_SAMPLES, TARGET_SAMPLE_RATE } from './constants';
import type { AudioSource, AudioSourceEvents } from './types';

/** 解码任意浏览器支持的音频格式 → 16 kHz 单声道 Float32 */
export async function decodeTo16kMono(data: ArrayBuffer): Promise<Float32Array> {
  // 先用一个只为了拿 decodeAudioData 的 OfflineAudioContext
  const probe = new OfflineAudioContext(1, 1, TARGET_SAMPLE_RATE);
  const decoded = await probe.decodeAudioData(data.slice(0));

  if (decoded.sampleRate === TARGET_SAMPLE_RATE && decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0);
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const off = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

export type PlaybackSpeed = 1 | 2 | 4 | 'instant';

export class WavFileSource implements AudioSource {
  readonly kind = 'file' as const;
  readonly label: string;

  private timer: number | null = null;
  private cancelled = false;

  constructor(
    private readonly data: ArrayBuffer,
    label: string,
    private readonly speed: PlaybackSpeed = 1,
  ) {
    this.label = label;
  }

  async start(events: AudioSourceEvents): Promise<void> {
    const samples = await decodeTo16kMono(this.data);
    if (this.cancelled) return;

    const total = Math.ceil(samples.length / CHUNK_SAMPLES);
    const chunkMs = (CHUNK_SAMPLES / TARGET_SAMPLE_RATE) * 1000;
    const delayMs = this.speed === 'instant' ? 0 : chunkMs / this.speed;
    let index = 0;

    await new Promise<void>((resolve) => {
      const tick = () => {
        if (this.cancelled || index >= total) {
          events.onEnded?.();
          resolve();
          return;
        }
        const start = index * CHUNK_SAMPLES;
        const chunk = samples.slice(start, start + CHUNK_SAMPLES);
        index += 1;

        let sum = 0;
        for (let i = 0; i < chunk.length; i++) sum += chunk[i]! * chunk[i]!;
        events.onLevel?.(Math.sqrt(sum / chunk.length));
        events.onChunk(chunk);

        // instant 也要让出事件循环，否则 UI 不重绘、引擎也来不及处理
        this.timer = window.setTimeout(tick, delayMs);
      };
      tick();
    });
  }

  async stop(): Promise<void> {
    this.cancelled = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export async function fileToSource(file: File, speed: PlaybackSpeed): Promise<WavFileSource> {
  const data = await file.arrayBuffer();
  return new WavFileSource(data, file.name, speed);
}

export async function urlToSource(url: string, speed: PlaybackSpeed): Promise<WavFileSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载音频失败: ${url} (${res.status})`);
  const data = await res.arrayBuffer();
  return new WavFileSource(data, url.split('/').pop() ?? url, speed);
}
