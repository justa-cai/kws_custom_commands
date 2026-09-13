/**
 * 检测会话编排：把音频源、两个识别引擎、状态机和 UI 事件缝在一起。
 *
 * 这一层不做算法，只决定"什么音频喂给谁"以及"谁的结果算数"：
 *
 *   音频块 ──┬─▶ sherpa 唤醒词 stream   （待机时）
 *            ├─▶ sherpa 命令词 stream   （唤醒后 / 关掉状态机时）
 *            └─▶ DTW worker（录音命令词，两路并行）
 *
 * 关掉状态机时三路并行独立监听，命中的命令词会标记成"未唤醒"——
 * 那个标记很重要，否则用户会以为是识别坏了，其实只是没先喊唤醒词。
 */

import { MicrophoneSource } from '../audio/AudioCapture';
import type { AudioSource } from '../audio/types';
import { DtwWorkerClient } from '../engines/dtw/DtwWorkerClient';
import type { CalibrationResult } from '../engines/dtw/DtwEngine';
import type { ExtractedPayload } from '../engines/dtw/protocol';
import type { DtwHit, DtwTemplate } from '../engines/dtw/types';
import { KwsEngine, type KwsHit, type KwsStream } from '../engines/sherpa/KwsEngine';
import {
  buildKeywordLine,
  buildKeywordsPayload,
  tokenize,
  type TokenizeContext,
} from '../engines/sherpa/tokenizer';
import type { ModelDescriptor } from '../models/descriptors';
import { WakeCommandMachine, type MachineState, type MachineTransition } from './Machine';
import type { AppState, KeywordEntry } from './store';

export interface DetectionEvent {
  at: number;
  kind: 'wake' | 'command' | 'voice' | 'blocked' | 'timeout' | 'info' | 'error';
  text: string;
  detail?: string;
  score?: number;
}

export interface WordIssue {
  list: 'wake' | 'command';
  text: string;
  message: string;
}

export interface DetectorEvents {
  onEvent: (e: DetectionEvent) => void;
  onMachine: (state: MachineState, remainingMs: number) => void;
  onLevel: (rms: number) => void;
  onRunningChange: (running: boolean) => void;
  onWordIssues: (issues: WordIssue[]) => void;
}

export class Detector {
  readonly machine: WakeCommandMachine;

  private kws: KwsEngine | null = null;
  private wakeStream: KwsStream | null = null;
  private cmdStream: KwsStream | null = null;

  private readonly dtw = new DtwWorkerClient();
  private source: AudioSource | null = null;
  private state: AppState | null = null;
  private tokenizeCtx: TokenizeContext | null = null;

  private running = false;

  constructor(private readonly events: DetectorEvents) {
    this.machine = new WakeCommandMachine(
      (t) => this.onMachineTransition(t),
      5000,
    );
    this.dtw.onHit = (hit) => this.onDtwHit(hit);
    this.dtw.onError = (message) =>
      this.events.onEvent({ at: Date.now(), kind: 'error', text: 'DTW 引擎出错', detail: message });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get modelLoaded(): boolean {
    return this.kws !== null;
  }

  /**
   * 录音造词面板要单独调 DTW worker 做"提取模板"和"校准阈值"。
   * 这两件事必须走**同一个** worker，否则运行时打分用的特征提取参数
   * 和造词时用的就不是一套，现象是"录音时看着好好的、运行时一个都不触发"。
   */
  get workerBridge(): {
    extract: (samples: Float32Array) => Promise<ExtractedPayload>;
    calibrate: (templates: DtwTemplate[], negative: DtwTemplate | null) => Promise<CalibrationResult>;
  } {
    return {
      extract: (samples) => this.dtw.extract(samples),
      calibrate: (templates, negative) => this.dtw.calibrate(templates, negative),
    };
  }

  /** 加载模型并建好两路 stream。切模型时会被再调一次 */
  async loadModel(model: ModelDescriptor, tokenizeCtx: TokenizeContext): Promise<void> {
    this.teardownStreams();
    this.kws?.dispose();

    this.tokenizeCtx = tokenizeCtx;

    // 每个文件只报一行：onProgress 是逐块的，直接往日志里写会刷出上千条
    let lastLoggedFile = -1;
    this.kws = await KwsEngine.create(model, {
      onLog: (line) => {
        if (/error|fail/i.test(line)) {
          this.events.onEvent({ at: Date.now(), kind: 'error', text: 'sherpa', detail: line });
        }
      },
      onProgress: (p) => {
        if (p.fileIndex === lastLoggedFile) return;
        lastLoggedFile = p.fileIndex;
        this.events.onEvent({
          at: Date.now(),
          kind: 'info',
          text: `加载模型 ${p.fileIndex + 1}/${p.fileCount}`,
          detail: `${p.file}${p.total ? ` · ${formatBytes(p.total)}` : ''}`,
        });
      },
    });

    if (this.state) this.rebuildStreams(this.state);
  }

  /** 词表/设置变了就调一次；不重建模型，只重建 stream */
  applyState(state: AppState, tokenizeCtx: TokenizeContext): void {
    this.state = state;
    this.tokenizeCtx = tokenizeCtx;
    this.machine.setAwakeWindow(state.settings.awakeWindowMs);
    this.dtw.setCommands(state.voiceCommands.filter((c) => c.enabled));
    if (this.kws) this.rebuildStreams(state);
  }

  async start(source: AudioSource): Promise<void> {
    if (this.running) await this.stop();
    if (!this.kws) throw new Error('模型还没加载');

    this.source = source;
    this.machine.reset();
    this.dtw.reset();

    // running 和日志都要早于 await：文件源会在一口气喂完之后立刻回调 onEnded，
    // 那时 stop() 得能认出"确实在跑"，日志顺序也不该倒过来
    this.running = true;
    this.events.onRunningChange(true);
    this.events.onEvent({
      at: Date.now(),
      kind: 'info',
      text: `开始监听（${source.label}）`,
      detail: this.state?.settings.useStateMachine ? '待机中，等唤醒词' : '三路并行监听',
    });

    try {
      await source.start({
        onChunk: (chunk) => this.onChunk(chunk),
        onLevel: (rms) => this.events.onLevel(rms),
        onEnded: () => {
          this.events.onEvent({ at: Date.now(), kind: 'info', text: '音频播完了' });
          void this.stop();
        },
      });
    } catch (e) {
      this.running = false;
      this.events.onRunningChange(false);
      this.source = null;
      throw e;
    }
  }

  async stop(): Promise<void> {
    if (this.source) {
      await this.source.stop();
      this.source = null;
    }
    this.machine.reset();
    this.dtw.flush();
    this.dtw.reset();
    if (this.running) {
      this.running = false;
      this.events.onRunningChange(false);
      this.events.onEvent({ at: Date.now(), kind: 'info', text: '已停止监听' });
    }
  }

  dispose(): void {
    this.teardownStreams();
    this.kws?.dispose();
    this.kws = null;
    this.dtw.dispose();
  }

  // -------------------------------------------------------------------------

  private teardownStreams(): void {
    this.wakeStream?.dispose();
    this.cmdStream?.dispose();
    this.wakeStream = null;
    this.cmdStream = null;
  }

  private rebuildStreams(state: AppState): void {
    if (!this.kws || !this.tokenizeCtx) return;

    const issues: WordIssue[] = [];
    this.wakeStream?.dispose();
    this.cmdStream?.dispose();

    this.wakeStream = this.makeStream(state.wakeWords, 'wake', issues);
    this.cmdStream = this.makeStream(state.typedCommands, 'command', issues);

    this.events.onWordIssues(issues);
  }

  private makeStream(
    entries: KeywordEntry[],
    list: 'wake' | 'command',
    issues: WordIssue[],
  ): KwsStream | null {
    const ctx = this.tokenizeCtx!;
    const lines: string[] = [];

    for (const entry of entries) {
      if (!entry.enabled) continue;
      const text = entry.text.trim();
      if (!text) continue;

      const result = tokenize(text, ctx);
      if (!result.ok) {
        for (const issue of result.issues) {
          issues.push({ list, text, message: issue.message });
        }
        continue;
      }
      lines.push(
        buildKeywordLine(text, result.phones, {
          ...(entry.boost !== undefined ? { boost: entry.boost } : {}),
          ...(entry.threshold !== undefined ? { threshold: entry.threshold } : {}),
        }),
      );
    }

    if (lines.length === 0) return null;

    const payload = buildKeywordsPayload(lines);
    const stream = this.kws!.createStream(payload);
    if (!stream) {
      issues.push({
        list,
        text: '(整表)',
        message: 'sherpa-onnx 拒绝了这批词条（音素不在 tokens.txt 里）。看控制台的 [sherpa] 日志。',
      });
    }
    return stream;
  }

  private onChunk(chunk: Float32Array): void {
    const useMachine = this.state?.settings.useStateMachine ?? true;
    const awake = this.machine.state === 'awake';

    if (this.wakeStream && (!useMachine || !awake)) {
      for (const hit of this.wakeStream.feed(chunk)) this.onSherpaHit(hit, 'wake');
    }
    if (this.cmdStream && (!useMachine || awake)) {
      for (const hit of this.cmdStream.feed(chunk)) this.onSherpaHit(hit, 'command');
    }

    this.dtw.feed(chunk);
    this.machine.tick(performance.now());
  }

  private onSherpaHit(hit: KwsHit, role: 'wake' | 'command'): void {
    const now = performance.now();
    // sherpa 的 KWS 结果没有"置信度"，只有命中/未命中，所以这里不带分数
    if (role === 'wake') {
      this.events.onEvent({
        at: Date.now(),
        kind: 'wake',
        text: hit.keyword,
        detail: `sherpa-onnx · ${hit.tokens.join(' ')}`,
      });
      this.machine.triggerWake(hit.keyword, undefined, now);
    } else {
      this.reportCommand(hit.keyword, undefined, 'sherpa-onnx');
    }
  }

  private onDtwHit(hit: DtwHit): void {
    this.reportCommand(hit.text, hit.distance, 'DTW 录音');
  }

  private reportCommand(text: string, score: number | undefined, source: string): void {
    const wasAwake = this.machine.state === 'awake';
    const useMachine = this.state?.settings.useStateMachine ?? true;

    this.events.onEvent({
      at: Date.now(),
      kind: !useMachine || wasAwake ? 'command' : 'blocked',
      text,
      detail:
        !useMachine || wasAwake
          ? `${source}${score !== undefined ? ` · 距离 ${score.toFixed(3)}` : ''}`
          : `${source} · 但还没唤醒（先喊唤醒词）`,
      ...(score !== undefined ? { score } : {}),
    });

    this.machine.triggerCommand(text, score);
  }

  private onMachineTransition(t: MachineTransition): void {
    if (t.reason === 'timeout') {
      this.events.onEvent({
        at: Date.now(),
        kind: 'timeout',
        text: '听命令超时，回待机',
        detail: `${(this.machine.windowMs / 1000).toFixed(1)} 秒内没听到命令词`,
      });
    }
    this.events.onMachine(this.machine.state, this.machine.remainingMs(performance.now()));
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export { MicrophoneSource };
