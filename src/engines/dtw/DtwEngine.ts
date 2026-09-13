/**
 * DTW 关键词检测引擎。
 *
 * 一条流水线：音频块 → VAD（逐帧语音/非语音）→ MFCC 原始帧 → 特征缓冲，
 * 每 stepFrames 帧取缓冲区尾部的一段，做**按段 CMN** 归一化后，
 * 对每条命令的每条模板跑一次子序列 DTW。
 *
 * 三件事共同决定了它能不能实时跑：
 *   1. **VAD 门控**——没人说话就完全不算，这一条省掉绝大部分开销；
 *   2. **早停**——不匹配的模板通常在前几行就被 DTW 砍掉（见 Dtw.ts）；
 *   3. **步长**——每 30 ms 算一次而不是每帧算一次。
 *
 * 归一化是这里最容易做错的地方，所以特意放在这一层显式做：
 *   · **按段**而不是滚动——滚动均值会让同一帧在不同时刻拿到不同结果，
 *     模板和运行时必然对不上；
 *   · 均值**只统计语音帧**——模板是端点检测切出来的、全是语音，
 *     而运行时窗口里混着前后静音，不挑出来均值会被静音拉偏。
 */

import {
  computeMfcc,
  DEFAULT_MFCC_CONFIG,
  MfccExtractor,
  normalizeStatics,
  type FeatureMatrix,
  type MfccConfig,
} from './Mfcc';
import { DEFAULT_VAD_CONFIG, findSpeechSegment, Vad, type VadConfig } from './Vad';
import { subsequenceDtw } from './Dtw';
import type { DtwHit, DtwTemplate, VoiceCommand } from './types';

export interface DtwEngineOptions {
  mfcc?: MfccConfig;
  vad?: VadConfig;
  /** 每隔多少帧（10 ms）跑一次匹配 */
  stepFrames?: number;
  /** 命中后多少帧内不再触发 */
  cooldownFrames?: number;
  /** 连续多少次判定都指向同一个词才真触发 */
  confirmCount?: number;
  /** 候选窗口长度 = 模板最长帧数 × 这个倍数 */
  windowScale?: number;
  /** 超过多少帧没有语音活动就停止匹配 */
  speechGateFrames?: number;
  /**
   * 早停阈值在命令阈值上放宽的倍数。
   * 早停比的是"部分路径的平均代价"，后面几帧还有变便宜的可能，
   * 卡太死会把本来能过的候选误杀。
   */
  cutoffSlack?: number;
  /** 统计 CMN 均值至少需要多少语音帧，不够就跳过这次匹配 */
  minSpeechFrames?: number;
  onHit?: (hit: DtwHit) => void;
}

const DEFAULTS = {
  stepFrames: 3,
  // 1.5 秒。窗口滑过同一个词的尾巴时还会再匹配上几次，冷却期太短的话
  // 一次发音会连着报好几条。这个值要明显大于"一个词的时长"。
  cooldownFrames: 150,
  confirmCount: 2,
  windowScale: 1.8,
  speechGateFrames: 100,
  cutoffSlack: 1.5,
  minSpeechFrames: 10,
};

interface PendingWinner {
  id: string;
  text: string;
  distance: number;
  count: number;
}

export class DtwEngine {
  private readonly mfccCfg: MfccConfig;
  private readonly vadCfg: VadConfig;
  private readonly opts: Required<Omit<DtwEngineOptions, 'mfcc' | 'vad' | 'onHit'>>;

  private readonly mfcc: MfccExtractor;
  private readonly vad: Vad;

  private commands: VoiceCommand[] = [];

  /** 原始特征帧缓冲（26 维，未归一化）；尾部一段始终连续，便于直接 subarray */
  private buf: Float32Array;
  /** 与 buf 逐帧对齐的语音标记，给 CMN 挑帧用 */
  private speech: Uint8Array;
  private start = 0;
  private count = 0;
  private readonly featDim: number;

  /** 归一化后的候选窗口，预分配避免每次匹配都申请内存 */
  private readonly candNorm: FeatureMatrix;
  private candCapacity = 0;

  private totalFrames = 0;
  private frameMismatchWarned = false;
  private lastCheckFrame = -1e9;
  private lastSpeechFrame = -1e9;
  private cooldownUntil = -1e9;
  private pending: PendingWinner | null = null;

  onHit?: (hit: DtwHit) => void;

  constructor(options: DtwEngineOptions = {}) {
    this.mfccCfg = options.mfcc ?? DEFAULT_MFCC_CONFIG;
    this.vadCfg = options.vad ?? DEFAULT_VAD_CONFIG;
    this.opts = {
      stepFrames: options.stepFrames ?? DEFAULTS.stepFrames,
      cooldownFrames: options.cooldownFrames ?? DEFAULTS.cooldownFrames,
      confirmCount: options.confirmCount ?? DEFAULTS.confirmCount,
      windowScale: options.windowScale ?? DEFAULTS.windowScale,
      speechGateFrames: options.speechGateFrames ?? DEFAULTS.speechGateFrames,
      cutoffSlack: options.cutoffSlack ?? DEFAULTS.cutoffSlack,
      minSpeechFrames: options.minSpeechFrames ?? DEFAULTS.minSpeechFrames,
    };
    this.onHit = options.onHit;

    this.mfcc = new MfccExtractor(this.mfccCfg);
    this.vad = new Vad(this.vadCfg);
    this.featDim = this.mfcc.frameDim;
    this.buf = new Float32Array(this.featDim * 1024);
    this.speech = new Uint8Array(1024);
    this.candNorm = { dim: this.featDim, frames: 0, data: new Float32Array(0) };
    this.ensureCandidateCapacity(1024);
  }

  get frameDim(): number {
    return this.featDim;
  }

  get speaking(): boolean {
    return this.vad.speaking;
  }

  /** 已处理时长（秒） */
  get elapsed(): number {
    return (this.totalFrames * this.mfccCfg.hopLength) / this.mfccCfg.sampleRate;
  }

  setCommands(commands: VoiceCommand[]): void {
    this.commands = commands;
    this.pending = null;
  }

  reset(): void {
    this.mfcc.reset();
    this.vad.reset();
    this.start = 0;
    this.count = 0;
    this.totalFrames = 0;
    this.lastCheckFrame = -1e9;
    this.lastSpeechFrame = -1e9;
    this.cooldownUntil = -1e9;
    this.pending = null;
  }

  /** 喂一块 16 kHz 单声道音频 */
  feed(chunk: Float32Array): void {
    // VAD 与 MFCC 用同一套分帧参数，逐帧对齐。
    // 万一哪天真错位了，语音标记会整体偏移，CMN 挑错帧、门控也失准——
    // 那种 bug 从识别结果上完全看不出来，所以这里显式喊一嗓子。
    const flags: boolean[] = [];
    this.vad.process(chunk, (s) => flags.push(s));

    let i = 0;
    this.mfcc.process(chunk, (frame) => {
      const isSpeech = flags[i] ?? false;
      i++;
      if (isSpeech) this.lastSpeechFrame = this.totalFrames;
      this.appendFrame(frame, isSpeech);
    });

    if (i !== flags.length && !this.frameMismatchWarned) {
      this.frameMismatchWarned = true;
      console.warn(
        `[dtw] VAD 帧数(${flags.length}) 与 MFCC 帧数(${i}) 对不上，语音标记会错位。` +
          '检查两边的 frameLength / hopLength 是否一致。',
      );
    }

    this.maybeMatch();
  }

  /** 音频播完后调用，把压在差分历史里的帧冲出来 */
  flush(): void {
    this.mfcc.flush((frame) => this.appendFrame(frame, true));
    this.maybeMatch();
  }

  private appendFrame(frame: Float32Array, isSpeech: boolean): void {
    const need = (this.start + this.count + 1) * this.featDim;
    if (need > this.buf.length) this.grow(need);

    const at = this.start + this.count;
    this.buf.set(frame, at * this.featDim);
    this.speech[at] = isSpeech ? 1 : 0;
    this.count++;
    this.totalFrames++;

    // 丢掉太老的：留够最长窗口 + 余量
    const keep = this.maxWindowFrames() + 200;
    if (this.count > keep) {
      this.start += this.count - keep;
      this.count = keep;
    }
    if (this.start > 512) this.compact();
  }

  private grow(need: number): void {
    const next = new Float32Array(Math.max(need, this.buf.length * 2));
    next.set(this.buf.subarray(this.start * this.featDim, (this.start + this.count) * this.featDim));
    this.buf = next;

    const nextSpeech = new Uint8Array(next.length / this.featDim);
    nextSpeech.set(this.speech.subarray(this.start, this.start + this.count));
    this.speech = nextSpeech;
    this.start = 0;
  }

  private compact(): void {
    this.buf.copyWithin(0, this.start * this.featDim, (this.start + this.count) * this.featDim);
    this.speech.copyWithin(0, this.start, this.start + this.count);
    this.start = 0;
  }

  private ensureCandidateCapacity(frames: number): void {
    if (frames <= this.candCapacity) return;
    this.candCapacity = frames;
    this.candNorm.data = new Float32Array(frames * this.featDim);
  }

  private maxWindowFrames(): number {
    let max = 1;
    for (const cmd of this.commands) {
      for (const t of cmd.templates) if (t.frames > max) max = t.frames;
    }
    return Math.round(max * this.opts.windowScale);
  }

  /**
   * 取窗口尾部的候选帧并做 CMN。所有命令共用同一个候选窗口——
   * 子序列 DTW 本来就是自由起止的，模板短一点也能在里面找到对齐。
   */
  private buildCandidate(windowFrames: number): FeatureMatrix | null {
    const frames = Math.min(windowFrames, this.count);
    if (frames <= 0) return null;
    this.ensureCandidateCapacity(frames);

    const from = this.start + this.count - frames;
    const src: FeatureMatrix = {
      dim: this.featDim,
      frames,
      data: this.buf.subarray(from * this.featDim, (from + frames) * this.featDim),
    };
    const mask = this.speech.subarray(from, from + frames);
    const used = normalizeStatics(src, this.candNorm, mask);
    if (used < this.opts.minSpeechFrames) return null;
    return this.candNorm;
  }

  private maybeMatch(): void {
    if (this.count === 0 || this.commands.length === 0) return;
    const now = this.totalFrames;
    if (now - this.lastCheckFrame < this.opts.stepFrames) return;
    this.lastCheckFrame = now;

    if (now - this.lastSpeechFrame > this.opts.speechGateFrames) {
      this.pending = null;
      return;
    }
    if (now < this.cooldownUntil) return;

    const candidate = this.buildCandidate(this.maxWindowFrames());
    if (!candidate) return;

    let best: { cmd: VoiceCommand; distance: number } | null = null;

    for (const cmd of this.commands) {
      if (!cmd.enabled || cmd.templates.length === 0) continue;

      const cutoff = Math.max(cmd.threshold, 0.05) * this.opts.cutoffSlack;
      let bestForCmd = Infinity;
      for (const template of cmd.templates) {
        const match = subsequenceDtw(template, candidate, { cutoff });
        if (match && match.distance < bestForCmd) bestForCmd = match.distance;
      }
      if (!Number.isFinite(bestForCmd)) continue;
      if (bestForCmd >= cmd.threshold) continue;

      if (!best || bestForCmd < best.distance) best = { cmd, distance: bestForCmd };
    }

    if (!best) {
      this.pending = null;
      return;
    }

    if (this.pending && this.pending.id === best.cmd.id) {
      this.pending.count++;
      this.pending.distance = best.distance;
    } else {
      this.pending = { id: best.cmd.id, text: best.cmd.text, distance: best.distance, count: 1 };
    }

    if (this.pending.count >= this.opts.confirmCount) {
      this.fire(best.cmd, this.pending.distance);
      this.pending = null;
      this.cooldownUntil = now + this.opts.cooldownFrames;
    }
  }

  private fire(cmd: VoiceCommand, distance: number): void {
    this.onHit?.({
      commandId: cmd.id,
      text: cmd.text,
      distance,
      time: this.elapsed,
    });
  }
}

// ---------------------------------------------------------------------------
// 造词与校准（离线，一次性跑）
// ---------------------------------------------------------------------------

export interface ExtractTemplateResult {
  template: DtwTemplate | null;
  /** 失败原因，成功了是 undefined */
  reason?: string;
  /** 切出来的那段音频，用于回放试听 */
  trimmed?: Float32Array;
}

/**
 * 把一段录音切成模板：端点检测 → 切出那个词 → 算特征 → 按段 CMN。
 * 切端点这一步很关键——不切的话前后静音也进了模板，
 * 同一句话录三遍会因为静音长度不同而互相都对不齐。
 */
export function extractTemplate(
  samples: Float32Array,
  mfccCfg: MfccConfig = DEFAULT_MFCC_CONFIG,
  vadCfg: VadConfig = DEFAULT_VAD_CONFIG,
): ExtractTemplateResult {
  const segment = findSpeechSegment(samples, vadCfg);
  if (!segment) {
    return { template: null, reason: '没听到人声——靠近麦克风，念完等半秒再松手。' };
  }
  const trimmed = samples.slice(segment.start, segment.end);
  const minSamples = Math.round(0.15 * mfccCfg.sampleRate);
  if (trimmed.length < minSamples) {
    return { template: null, reason: '这段太短了，听不出是个词。' };
  }

  const raw = computeMfcc(trimmed, mfccCfg);
  if (raw.frames < 8) {
    return { template: null, reason: '有效帧太少了，再念长一点。' };
  }

  // 切出来的这一段全是语音，直接用自己的均值做 CMN
  const norm: FeatureMatrix = {
    dim: raw.dim,
    frames: raw.frames,
    data: new Float32Array(raw.frames * raw.dim),
  };
  normalizeStatics(raw, norm, null);

  return {
    template: { dim: norm.dim, frames: norm.frames, data: norm.data },
    trimmed,
  };
}

export interface CalibrationResult {
  threshold: number;
  /** 同一词不同模板之间的最大距离 */
  maxIntra: number | null;
  /** 模板与负样本之间的最小距离 */
  minNegative: number | null;
  note: string;
}

/**
 * 阈值自校准。
 *
 * 思路很朴素：好阈值应该落在"同一个词的几条模板之间有多散"和
 * "模板跟别的话有多远"之间。取两者中点，再夹到合理区间里。
 *
 * 让用户录一小段负样本（随便说点别的）比什么先验阈值都管用——
 * 不录的话只能拍一个默认值，安静房间里能触发、嘈杂环境里全是误报。
 */
export function calibrate(
  templates: DtwTemplate[],
  negative: DtwTemplate | null,
): CalibrationResult {
  if (templates.length === 0) {
    return { threshold: 1.2, maxIntra: null, minNegative: null, note: '还没有模板，先用默认阈值 1.2。' };
  }

  let maxIntra: number | null = null;
  for (let i = 0; i < templates.length; i++) {
    for (let j = 0; j < templates.length; j++) {
      if (i === j) continue;
      const match = subsequenceDtw(templates[i]!, templates[j]!, { cutoff: Infinity });
      if (match && (maxIntra === null || match.distance > maxIntra)) {
        maxIntra = match.distance;
      }
    }
  }

  let minNegative: number | null = null;
  if (negative) {
    for (const t of templates) {
      const match = subsequenceDtw(t, negative, { cutoff: Infinity });
      if (match && (minNegative === null || match.distance < minNegative)) {
        minNegative = match.distance;
      }
    }
  }

  const clamp = (v: number) => Math.min(3.0, Math.max(0.3, v));

  if (maxIntra === null && minNegative === null) {
    return { threshold: 1.2, maxIntra, minNegative, note: '只有一条模板且没录负样本，用默认阈值 1.2。' };
  }
  if (maxIntra === null) {
    const t = clamp(minNegative! * 0.7);
    return { threshold: t, maxIntra, minNegative, note: `只有一条模板，按负样本的 70% 定阈值 ${t.toFixed(2)}。` };
  }
  if (minNegative === null) {
    const t = clamp(maxIntra * 1.4);
    return {
      threshold: t,
      maxIntra,
      minNegative,
      note: `没录负样本，按模板间最大距离的 1.4 倍定阈值 ${t.toFixed(2)}。建议补录一段负样本。`,
    };
  }
  if (minNegative <= maxIntra) {
    const t = clamp(maxIntra * 1.2);
    return {
      threshold: t,
      maxIntra,
      minNegative,
      note: `模板太散（${maxIntra.toFixed(2)}）而负样本太近（${minNegative.toFixed(2)}），两者没分开。建议多录几遍、或换个更"独立"的词。暂用 ${t.toFixed(2)}。`,
    };
  }
  const t = clamp((maxIntra + minNegative) / 2);
  return {
    threshold: t,
    maxIntra,
    minNegative,
    note: `模板间距 ${maxIntra.toFixed(2)}，离负样本 ${minNegative.toFixed(2)}，取中点 ${t.toFixed(2)}。`,
  };
}
