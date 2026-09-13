/**
 * 流式线性插值重采样。
 *
 * 只在设备采样率不是 16 kHz 时才用得上（Chrome/Firefox/Safari 现在大多
 * 能按 `new AudioContext({sampleRate: 16000})` 直接给 16 k，但不是所有
 * 设备都认）。关键是**跨块连续**：不能在每块边界上把相位归零，
 * 否则每 64 ms 就有一个咔哒声，特征里全是毛刺，DTW 会疯掉。
 */
export class StreamingResampler {
  /** 上块最后一个样本，用来在块边界上插值 */
  private prev: number | null = null;
  /** 当前输出相位，落在 [0,1)，相对「上块末尾样本」 */
  private phase = 0;

  /**
   * @param ratio 输入采样率 / 输出采样率。比例为 1 时直接透传
   */
  constructor(private readonly ratio: number) {}

  get passthrough(): boolean {
    return this.ratio === 1;
  }

  /**
   * @param input 新的输入样本
   * @param emit 每个输出样本回调一次。为了不给 GC 添堵，用回调而不是返回数组
   */
  process(input: Float32Array, emit: (sample: number) => void): void {
    if (this.passthrough) {
      for (let i = 0; i < input.length; i++) emit(input[i]!);
      return;
    }
    if (input.length === 0) return;

    // 虚拟缓冲区 = [上块末样本, ...本块]，这样跨块插值不用特判
    const buf = new Float32Array(input.length + 1);
    buf[0] = this.prev ?? input[0]!;
    buf.set(input, 1);

    let p = this.phase;
    const last = buf.length - 1;
    while (p < last) {
      const i = Math.floor(p);
      const frac = p - i;
      const a = buf[i]!;
      const b = buf[i + 1]!;
      emit(a + (b - a) * frac);
      p += this.ratio;
    }

    this.prev = buf[last]!;
    this.phase = p - last;
  }

  reset(): void {
    this.prev = null;
    this.phase = 0;
  }
}
