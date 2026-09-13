/**
 * 麦克风音频源。
 *
 * 尽量让 AudioContext 直接跑在 16 kHz 上，那样下游一帧都不用重采样。
 * 但并非所有设备都认这个请求（尤其 Safari 和某些安卓机），
 * 所以拿到 ctx.sampleRate 后如果对不上，就挂一个带跨块相位的
 * StreamingResampler 兜住。
 *
 * 用 AudioWorklet 而不是已废弃的 createScriptProcessor：后者跑在主线程上，
 * 一卡顿就丢样本，唤醒率直接掉。
 */

import { assetUrl, CHUNK_SAMPLES, TARGET_SAMPLE_RATE } from './constants';
import { StreamingResampler } from './resample';
import type { AudioSource, AudioSourceEvents } from './types';

/**
 * worklet 脚本放在 public/worklet/ 下由静态服务器直接托管，而不是 import 进来。
 * 原因见那个文件的头部注释：Vite 对 TS 文件的 `?url` 处理不可靠，
 * 而 worklet 必须能被 addModule() 直接加载。
 */
const WORKLET_URL = 'worklet/mic-capture.js';

export interface MicrophoneInfo {
  deviceId: string;
  label: string;
}

export async function listMicrophones(): Promise<MicrophoneInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `麦克风 ${i + 1}`,
      }));
  } catch {
    return [];
  }
}

export class MicrophoneSource implements AudioSource {
  readonly kind = 'mic' as const;
  readonly label = '麦克风';

  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private sinkNode: GainNode | null = null;
  private resampler: StreamingResampler | null = null;

  private readonly chunk = new Float32Array(CHUNK_SAMPLES);
  private filled = 0;
  private events: AudioSourceEvents | null = null;

  constructor(private readonly deviceId?: string) {}

  /** 实际用上的采样率，便于在 UI 上说明有没有走重采样 */
  actualSampleRate = TARGET_SAMPLE_RATE;

  async start(events: AudioSourceEvents): Promise<void> {
    this.events = events;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('这个浏览器不支持 getUserMedia，换个 Chrome/Edge/Firefox 试试。');
    }

    const ctx = new AudioContext({
      sampleRate: TARGET_SAMPLE_RATE,
      latencyHint: 'interactive',
    });
    this.ctx = ctx;
    this.actualSampleRate = ctx.sampleRate;

    await ctx.audioWorklet.addModule(assetUrl(WORKLET_URL));

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.sourceNode = ctx.createMediaStreamSource(this.stream);

    this.node = new AudioWorkletNode(ctx, 'kws-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    this.node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
      this.onBlock(ev.data);
    };

    // worklet 只有连到 destination 才会被音频图拉着跑；
    // 用一个 0 增益的节点接上，免得把自己的声音回放出来。
    this.sinkNode = ctx.createGain();
    this.sinkNode.gain.value = 0;
    this.sourceNode.connect(this.node);
    this.node.connect(this.sinkNode);
    this.sinkNode.connect(ctx.destination);

    if (ctx.state === 'suspended') await ctx.resume();

    this.resampler =
      ctx.sampleRate === TARGET_SAMPLE_RATE
        ? null
        : new StreamingResampler(ctx.sampleRate / TARGET_SAMPLE_RATE);
  }

  private onBlock(block: Float32Array): void {
    const emit = (s: number) => {
      this.chunk[this.filled++] = s;
      if (this.filled === CHUNK_SAMPLES) {
        const out = this.chunk.slice();
        this.filled = 0;
        this.push(out);
      }
    };

    if (this.resampler) {
      this.resampler.process(block, emit);
    } else {
      for (let i = 0; i < block.length; i++) emit(block[i]!);
    }
  }

  private push(chunk: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i]! * chunk[i]!;
    this.events?.onLevel?.(Math.sqrt(sum / chunk.length));
    this.events?.onChunk(chunk);
  }

  async stop(): Promise<void> {
    this.node?.port.close();
    this.node?.disconnect();
    this.sourceNode?.disconnect();
    this.sinkNode?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close();

    this.node = null;
    this.sourceNode = null;
    this.sinkNode = null;
    this.stream = null;
    this.ctx = null;
    this.resampler = null;
    this.filled = 0;
    this.events = null;
  }
}
