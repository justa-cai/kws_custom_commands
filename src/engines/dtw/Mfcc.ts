/**
 * 特征提取：13 维 MFCC + 13 维中心差分 = 26 维帧特征。
 *
 * 为什么用 MFCC 而不是梅尔谱：DTW 比的是帧间欧氏距离，MFCC 把频谱包络压成
 * 十几维、顺手去掉了基频和整体响度，同一句话换个音高、换个音量也还能对齐。
 * 梅尔谱在这两件事上都很脆。
 *
 * 差分不是锦上添花：不加差分时"你好"和"你好啊"这类长度不同、音素接近的词
 * DTW 距离几乎贴在一起；加上差分后区分度明显拉开。
 *
 * **这里不做 CMN。** 归一化放在 DTW 那一层（见 normalizeStatics）——因为
 * 归一化必须"按段"而不是"滚动"：滚动均值会让同一帧在不同时刻拿到不同的
 * 归一化结果，模板和运行时对不上。而且差分对整体偏移天然免疫
 * （减去常量再做差分等于没减），所以只有前 13 维静态系数需要处理。
 */

/** 帧特征矩阵：行主序，frames 行 dim 列 */
export interface FeatureMatrix {
  dim: number;
  frames: number;
  data: Float32Array;
}

export interface MfccConfig {
  sampleRate: number;
  /** 25 ms */
  frameLength: number;
  /** 10 ms */
  hopLength: number;
  fftSize: number;
  melBands: number;
  cepstral: number;
  preEmphasis: number;
  lowFreq: number;
  highFreq: number;
  /** 中心差分半径 */
  deltaRadius: number;
}

export const DEFAULT_MFCC_CONFIG: MfccConfig = {
  sampleRate: 16000,
  frameLength: 400,
  hopLength: 160,
  fftSize: 512,
  melBands: 40,
  cepstral: 13,
  preEmphasis: 0.97,
  lowFreq: 20,
  highFreq: 7600,
  deltaRadius: 2,
};

// ---------------------------------------------------------------------------
// FFT：基-2，就地，位反转
// ---------------------------------------------------------------------------

function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const j = i + k + half;
        const vRe = re[j]! * curRe - im[j]! * curIm;
        const vIm = re[j]! * curIm + im[j]! * curRe;
        const uRe = re[i + k]!;
        const uIm = im[i + k]!;

        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[j] = uRe - vRe;
        im[j] = uIm - vIm;

        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 梅尔滤波器组 + DCT（预计算成稠密矩阵，运行时只剩矩阵乘）
// ---------------------------------------------------------------------------

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}
function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function buildMelFilters(cfg: MfccConfig): Float32Array {
  const bins = cfg.fftSize / 2 + 1;
  const minMel = hzToMel(cfg.lowFreq);
  const maxMel = hzToMel(cfg.highFreq);
  const points = new Float32Array(cfg.melBands + 2);
  for (let i = 0; i < points.length; i++) {
    const mel = minMel + ((maxMel - minMel) * i) / (cfg.melBands + 1);
    points[i] = (melToHz(mel) / cfg.sampleRate) * cfg.fftSize;
  }

  const filters = new Float32Array(cfg.melBands * bins);
  for (let m = 0; m < cfg.melBands; m++) {
    const left = points[m]!;
    const center = points[m + 1]!;
    const right = points[m + 2]!;
    for (let k = 0; k < bins; k++) {
      let w = 0;
      if (k >= left && k <= center && center > left) w = (k - left) / (center - left);
      else if (k > center && k <= right && right > center) w = (right - k) / (right - center);
      filters[m * bins + k] = w;
    }
  }
  return filters;
}

function buildDct(cfg: MfccConfig): Float32Array {
  const m = cfg.cepstral;
  const n = cfg.melBands;
  const dct = new Float32Array(m * n);
  const scale0 = Math.sqrt(1 / n);
  for (let i = 0; i < m; i++) {
    const scale = i === 0 ? scale0 : Math.sqrt(2 / n);
    for (let j = 0; j < n; j++) {
      dct[i * n + j] = scale * Math.cos((Math.PI * i * (j + 0.5)) / n);
    }
  }
  return dct;
}

// ---------------------------------------------------------------------------
// 流式 MFCC
// ---------------------------------------------------------------------------

export class MfccExtractor {
  readonly cfg: MfccConfig;
  /** 每帧输出的维数 = 2 × cepstral（静态倒谱 + 差分） */
  readonly frameDim: number;

  private readonly melFilters: Float32Array;
  private readonly melBins: number;
  private readonly dct: Float32Array;
  private readonly window: Float32Array;

  private readonly frameBuf: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly melScratch: Float32Array;

  /** 上一块没凑成一整帧的尾巴，保证跨块成帧连续 */
  private pending = new Float32Array(0);
  private prevSample = 0;

  /** 原始倒谱帧，append-only；emitIndex 之前的已经吐出去了 */
  private frames: Float32Array;
  private frameCount = 0;
  private emitIndex = 0;
  private emitted = 0;

  constructor(cfg: MfccConfig = DEFAULT_MFCC_CONFIG) {
    this.cfg = cfg;
    this.frameDim = cfg.cepstral * 2;

    this.melFilters = buildMelFilters(cfg);
    this.melBins = cfg.fftSize / 2 + 1;
    this.dct = buildDct(cfg);

    this.window = new Float32Array(cfg.frameLength);
    for (let i = 0; i < cfg.frameLength; i++) {
      this.window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (cfg.frameLength - 1));
    }

    this.frameBuf = new Float32Array(cfg.fftSize);
    this.re = new Float32Array(cfg.fftSize);
    this.im = new Float32Array(cfg.fftSize);
    this.melScratch = new Float32Array(cfg.melBands);
    this.frames = new Float32Array(cfg.cepstral * 512);
  }

  reset(): void {
    this.pending = new Float32Array(0);
    this.prevSample = 0;
    this.frameCount = 0;
    this.emitIndex = 0;
    this.emitted = 0;
  }

  /** 喂入样本。右侧上下文够了的帧会即时回调出去 */
  process(samples: Float32Array, onFrame: (frame: Float32Array, index: number) => void): void {
    let buf: Float32Array;
    if (this.pending.length === 0) {
      buf = samples;
    } else {
      buf = new Float32Array(this.pending.length + samples.length);
      buf.set(this.pending, 0);
      buf.set(samples, this.pending.length);
    }

    const { frameLength, hopLength } = this.cfg;
    let offset = 0;
    while (offset + frameLength <= buf.length) {
      this.pushFrame(this.frameToCepstrum(buf, offset));
      offset += hopLength;
    }
    this.pending = buf.slice(offset);
    this.drain(onFrame, false);
  }

  /** 收尾：把还压在差分历史里的帧全部吐出 */
  flush(onFrame: (frame: Float32Array, index: number) => void): void {
    this.drain(onFrame, true);
  }

  private drain(onFrame: (frame: Float32Array, index: number) => void, final: boolean): void {
    const dim = this.cfg.cepstral;
    const r = this.cfg.deltaRadius;
    // 非收尾时，右侧还差 r 帧的不能吐（中心差分需要它）
    const limit = final ? this.frameCount : this.frameCount - r;

    while (this.emitIndex < limit) {
      const i = this.emitIndex;
      const base = i * dim;
      const frame = new Float32Array(dim * 2);
      for (let k = 0; k < dim; k++) frame[k] = this.frames[base + k]!;

      const left = Math.max(0, i - r);
      const right = Math.min(this.frameCount - 1, i + r);
      const span = right - left;
      if (span > 0) {
        const rb = right * dim;
        const lb = left * dim;
        for (let k = 0; k < dim; k++) {
          frame[dim + k] = (this.frames[rb + k]! - this.frames[lb + k]!) / span;
        }
      }

      this.emitIndex++;
      onFrame(frame, this.emitted++);
    }

    // 丢掉已经不需要的历史（早于 emitIndex - r 的），防止无限增长
    if (this.emitIndex > r + 256) {
      const keepFrom = this.emitIndex - r;
      this.frames.copyWithin(0, keepFrom * dim, this.frameCount * dim);
      this.frameCount -= keepFrom;
      this.emitIndex -= keepFrom;
    }
  }

  private frameToCepstrum(src: Float32Array, offset: number): Float32Array {
    const { frameLength, fftSize, melBands, cepstral } = this.cfg;

    // 预加重 + 加窗
    let prev = this.prevSample;
    for (let i = 0; i < frameLength; i++) {
      const x = src[offset + i]!;
      this.frameBuf[i] = (x - this.cfg.preEmphasis * prev) * this.window[i]!;
      prev = x;
    }
    this.prevSample = prev;
    for (let i = frameLength; i < fftSize; i++) this.frameBuf[i] = 0;

    this.re.set(this.frameBuf);
    this.im.fill(0);
    fftInPlace(this.re, this.im);

    for (let m = 0; m < melBands; m++) {
      let acc = 0;
      const base = m * this.melBins;
      for (let k = 0; k < this.melBins; k++) {
        const w = this.melFilters[base + k]!;
        if (w === 0) continue;
        acc += w * (this.re[k]! * this.re[k]! + this.im[k]! * this.im[k]!);
      }
      this.melScratch[m] = Math.log(acc + 1e-10);
    }

    const out = new Float32Array(cepstral);
    for (let i = 0; i < cepstral; i++) {
      let acc = 0;
      const base = i * melBands;
      for (let j = 0; j < melBands; j++) acc += this.dct[base + j]! * this.melScratch[j]!;
      out[i] = acc;
    }
    return out;
  }

  private pushFrame(raw: Float32Array): void {
    const dim = this.cfg.cepstral;
    const need = (this.frameCount + 1) * dim;
    if (need > this.frames.length) {
      const next = new Float32Array(Math.max(need, this.frames.length * 2));
      next.set(this.frames.subarray(0, this.frameCount * dim));
      this.frames = next;
    }
    this.frames.set(raw, this.frameCount * dim);
    this.frameCount++;
  }
}

/** 离线批处理：整段音频 → 特征矩阵 */
export function computeMfcc(
  samples: Float32Array,
  cfg: MfccConfig = DEFAULT_MFCC_CONFIG,
): FeatureMatrix {
  const ex = new MfccExtractor(cfg);
  const frames: Float32Array[] = [];
  ex.process(samples, (f) => frames.push(f));
  ex.flush((f) => frames.push(f));

  const dim = ex.frameDim;
  const data = new Float32Array(frames.length * dim);
  frames.forEach((f, i) => data.set(f, i * dim));
  return { dim, frames: frames.length, data };
}

// ---------------------------------------------------------------------------
// 静态系数的归一化（CMN）
// ---------------------------------------------------------------------------

/**
 * 减去静态倒谱（前 dim/2 维）的均值。
 *
 * 只动静态部分：差分是「相邻帧作差」，整体加一个常量再作差结果不变，
 * 所以差分天然免疫增益/信道偏移，重复归一化反而会把它破坏掉。
 *
 * 均值默认按 `speechMask` 只在语音帧上统计——模板是端点检测切出来的、
 * 全是语音；运行时窗口里混着前后静音，不挑出来的话均值会被静音拉偏，
 * 而静音和语音的倒谱差得远，这一偏就足以让模板对不上。
 *
 * @param src       原始特征矩阵（read-only）
 * @param dst       输出矩阵，容量需 >= src.frames * src.dim
 * @param speechMask 每帧是否语音；传 null 表示全部计入
 * @returns 实际参与统计的帧数
 */
export function normalizeStatics(
  src: FeatureMatrix,
  dst: FeatureMatrix,
  speechMask?: Uint8Array | null,
): number {
  const dim = src.dim;
  const half = dim >> 1;
  const frames = src.frames;
  dst.dim = dim;
  dst.frames = frames;

  const mean = new Float32Array(half);
  let used = 0;
  for (let i = 0; i < frames; i++) {
    if (speechMask && speechMask[i] === 0) continue;
    const base = i * dim;
    for (let k = 0; k < half; k++) mean[k] += src.data[base + k]!;
    used++;
  }

  if (used === 0) {
    // 没有可用统计量，原样拷贝（调用方应该在此之前就跳过）
    dst.data.set(src.data.subarray(0, frames * dim));
    return 0;
  }
  for (let k = 0; k < half; k++) mean[k]! /= used;

  for (let i = 0; i < frames; i++) {
    const base = i * dim;
    for (let k = 0; k < half; k++) dst.data[base + k] = src.data[base + k]! - mean[k]!;
    for (let k = half; k < dim; k++) dst.data[base + k] = src.data[base + k]!;
  }
  return used;
}

/** 从矩阵里切一帧（返回的是 view，别改） */
export function frameAt(m: FeatureMatrix, i: number): Float32Array {
  return m.data.subarray(i * m.dim, (i + 1) * m.dim);
}
