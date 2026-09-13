/**
 * 唤醒 → 听命令 的状态机。
 *
 * 为什么要有这个东西：唤醒词和命令词如果只是"两路并行各听各的"，
 * 那就等于没有唤醒概念——用户随便说句话，只要撞上命令词就直接执行了，
 * 唤醒词完全成了摆设。真实产品的语义是：
 *
 *   待机 ──唤醒词命中──▶ 听命令（N 秒窗口）──命令词命中──▶ 执行，回待机
 *                              │
 *                              └──窗口超时──▶ 回待机
 *
 * 所以这里只认一个"当前该听什么"的状态，由它决定哪一路关键词 stream 在吃音频。
 * 好处除了语义正确，还有实打实的省电：待机时只有唤醒词那一路在跑。
 */

export type MachineState = 'idle' | 'awake';

export type TransitionReason = 'wake' | 'command' | 'timeout' | 'reset' | 'manual';

export interface MachineTransition {
  from: MachineState;
  to: MachineState;
  reason: TransitionReason;
  /** 触发这次转移的词条文本（超时/重置时没有） */
  text?: string;
  /** 归一化后的分数：sherpa 那路是距离意义上的，DTW 那路是距离 */
  score?: number;
}

export const DEFAULT_AWAKE_WINDOW_MS = 5000;

export class WakeCommandMachine {
  private _state: MachineState = 'idle';
  private awakeUntil = 0;
  private awakeWindowMs: number;

  constructor(
    private readonly onTransition: (t: MachineTransition) => void,
    awakeWindowMs = DEFAULT_AWAKE_WINDOW_MS,
  ) {
    this.awakeWindowMs = awakeWindowMs;
  }

  get state(): MachineState {
    return this._state;
  }

  get windowMs(): number {
    return this.awakeWindowMs;
  }

  setAwakeWindow(ms: number): void {
    this.awakeWindowMs = ms;
  }

  /** 距离回待机还剩多少毫秒；待机时返回 0 */
  remainingMs(now: number): number {
    if (this._state !== 'awake') return 0;
    return Math.max(0, this.awakeUntil - now);
  }

  /** 唤醒词命中 */
  triggerWake(text: string, score: number | undefined, now: number): void {
    const from = this._state;
    this._state = 'awake';
    this.awakeUntil = now + this.awakeWindowMs;
    this.onTransition({ from, to: 'awake', reason: 'wake', text, ...(score !== undefined ? { score } : {}) });
  }

  /** 命令词命中（打字命令词或录音命令词都走这里） */
  triggerCommand(text: string, score: number | undefined): void {
    const from = this._state;
    if (from !== 'awake') {
      // 待机状态下命中的命令词不执行，但仍要报出来——
      // 否则用户会以为"没反应"，其实是没先唤醒。
      this.onTransition({
        from,
        to: from,
        reason: 'command',
        text,
        ...(score !== undefined ? { score } : {}),
      });
      return;
    }
    this._state = 'idle';
    this.awakeUntil = 0;
    this.onTransition({ from, to: 'idle', reason: 'command', text, ...(score !== undefined ? { score } : {}) });
  }

  /** 每帧调用，检查听命令窗口有没有超时 */
  tick(now: number): void {
    if (this._state === 'awake' && now >= this.awakeUntil) {
      this._state = 'idle';
      this.awakeUntil = 0;
      this.onTransition({ from: 'awake', to: 'idle', reason: 'timeout' });
    }
  }

  reset(): void {
    if (this._state === 'idle' && this.awakeUntil === 0) return;
    const from = this._state;
    this._state = 'idle';
    this.awakeUntil = 0;
    this.onTransition({ from, to: 'idle', reason: 'reset' });
  }
}
