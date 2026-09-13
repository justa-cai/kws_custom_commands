/**
 * 双门限端点检测（短时能量 + 过零率）。
 *
 * 两个用途：
 *   1. 造词时把用户录的一整段切出"这个词"——不然模板里裹着前后静音，
 *      长度和内容都不稳定，几条模板之间先自己打架；
 *   2. 运行时给 DTW 当闸门——没人说话时压根不跑 DTW。
 *      这一条不是优化而是能不能用的分水岭：不做门控的话每 10 ms 要对
 *      几十条模板各跑一次 DTW，浏览器直接卡成幻灯片。
 *
 * 能量门限用**自适应噪声底**而不是固定值：固定值在安静房间和嘈杂环境
 * 里总有一边是废的。噪声底在非语音段做指数滑动平均，启动时额外快一点。
 */

export interface VadConfig {
  sampleRate: number;
  frameLength: number;
  hopLength: number;
  /** 高出噪声底多少 dB 才算语音 */
  speechMarginDb: number;
  /** 过零率上限：摩擦音/噪声的过零率高，用来削一波误判 */
  maxZcr: number;
  /** 起判需要连续多少帧超阈值 */
  onsetFrames: number;
  /** 语音结束后还要挂多少帧算这一句没完 */
  hangoverFrames: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  sampleRate: 16000,
  frameLength: 400,
  hopLength: 160,
  speechMarginDb: 8,
  maxZcr: 0.35,
  onsetFrames: 3,
  hangoverFrames: 12,
};

const EPS = 1e-10;

interface FrameStats {
  db: number;
  zcr: number;
}

function frameStats(src: Float32Array, offset: number, len: number): FrameStats {
  let energy = 0;
  let crossings = 0;
  let prev = src[offset]!;
  for (let i = 0; i < len; i++) {
    const x = src[offset + i]!;
    energy += x * x;
    if (i > 0 && ((x >= 0 && prev < 0) || (x < 0 && prev >= 0))) crossings++;
    prev = x;
  }
  return {
    db: 10 * Math.log10(energy / len + EPS),
    zcr: crossings / len,
  };
}

/**
 * 逐帧给出语音/非语音判定。与 MFCC 用同一套分帧参数，
 * 所以第 i 个 VAD 帧就对应第 i 个特征帧。
 */
export class Vad {
  private readonly cfg: VadConfig;
  private pending = new Float32Array(0);

  /** 自适应噪声底（dB） */
  private noiseDb = -70;
  private noiseInit = 0;

  private inSpeech = false;
  private onsetCount = 0;
  private hangover = 0;

  constructor(cfg: VadConfig = DEFAULT_VAD_CONFIG) {
    this.cfg = cfg;
  }

  get speaking(): boolean {
    return this.inSpeech;
  }

  get currentNoiseDb(): number {
    return this.noiseDb;
  }

  reset(): void {
    this.pending = new Float32Array(0);
    this.noiseDb = -70;
    this.noiseInit = 0;
    this.inSpeech = false;
    this.onsetCount = 0;
    this.hangover = 0;
  }

  process(samples: Float32Array, onFrame: (speech: boolean) => void): void {
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
      onFrame(this.acceptFrame(frameStats(buf, offset, frameLength)));
      offset += hopLength;
    }
    this.pending = buf.slice(offset);
  }

  flush(): void {
    this.pending = new Float32Array(0);
  }

  private acceptFrame(stats: FrameStats): boolean {
    // 噪声底：非语音时快速跟，语音时几乎不动
    if (!this.inSpeech) {
      const lr = this.noiseInit < 50 ? 0.3 : 0.02;
      this.noiseDb = this.noiseDb * (1 - lr) + stats.db * lr;
      this.noiseInit++;
    }

    const loud = stats.db > this.noiseDb + this.cfg.speechMarginDb;
    const clean = stats.zcr < this.cfg.maxZcr;
    const voiced = loud && clean;

    if (this.inSpeech) {
      if (voiced) {
        this.hangover = this.cfg.hangoverFrames;
      } else if (--this.hangover <= 0) {
        this.inSpeech = false;
        this.onsetCount = 0;
      }
    } else if (voiced) {
      if (++this.onsetCount >= this.cfg.onsetFrames) {
        this.inSpeech = true;
        this.hangover = this.cfg.hangoverFrames;
      }
    } else {
      this.onsetCount = 0;
    }

    return this.inSpeech;
  }
}

export interface SpeechSegment {
  /** 采样点下标（含） */
  start: number;
  /** 采样点下标（不含） */
  end: number;
}

/**
 * 离线端点检测：找出一整段录音里最长的那段话。
 * 造词时用它切出用户念的那个词。
 *
 * @param padMs 两端各留一点余量，切太紧会把声母/韵尾削掉
 */
export function findSpeechSegment(
  samples: Float32Array,
  cfg: VadConfig = DEFAULT_VAD_CONFIG,
  padMs = 80,
): SpeechSegment | null {
  const vad = new Vad(cfg);
  const flags: boolean[] = [];
  vad.process(samples, (s) => flags.push(s));
  if (flags.length === 0) return null;

  // 找最长的一段连续 true
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i]!;
    if (on && curStart < 0) curStart = i;
    if (!on && curStart >= 0) {
      const len = i - curStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = curStart;
      }
      curStart = -1;
    }
  }
  if (bestStart < 0 || bestLen <= 0) return null;

  const pad = Math.round((padMs / 1000) * cfg.sampleRate);
  const start = Math.max(0, bestStart * cfg.hopLength - pad);
  const end = Math.min(
    samples.length,
    (bestStart + bestLen - 1) * cfg.hopLength + cfg.frameLength + pad,
  );
  if (end - start < cfg.frameLength) return null;
  return { start, end };
}
