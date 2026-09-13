/**
 * 状态条：当前该听什么 + 还剩多久 + 输入音量。
 *
 * 这几样是"跑起来之后唯一需要一直看"的信息，所以放在最显眼的位置，
 * 而且待机/唤醒两种状态在视觉上要拉开（边框和背景都换）。
 */

import type { MachineState } from '../../state/Machine';
import { el } from '../dom';

export class StatusBar {
  readonly root: HTMLElement;

  private readonly lamp = el('span', { class: 'lamp' });
  private readonly stateText = el('span', { class: 'state-text', text: '待机' });
  private readonly countdown = el('span', { class: 'countdown' });
  private readonly modeText = el('span', { class: 'countdown' });
  private readonly meterFill = el('i');
  private readonly machine: HTMLElement;

  constructor() {
    this.machine = el(
      'div',
      { class: 'machine' },
      this.lamp,
      this.stateText,
      this.countdown,
      el('span', { style: { flex: '1' } }),
      this.modeText,
      el('div', { class: 'meter', title: '输入音量' }, this.meterFill),
    );
    this.root = this.machine;
  }

  setMode(text: string): void {
    this.modeText.textContent = text;
  }

  setState(state: MachineState, remainingMs: number): void {
    const awake = state === 'awake';
    this.machine.classList.toggle('awake', awake);
    this.stateText.textContent = awake ? '已唤醒 · 听命令' : '待机 · 听唤醒词';
    this.setRemaining(remainingMs);
  }

  setRemaining(ms: number): void {
    this.countdown.textContent = ms > 0 ? `${(ms / 1000).toFixed(1)}s` : '';
  }

  /** rms 大概在 0~0.3 之间，用 dB 映射才看得清小声 */
  setLevel(rms: number): void {
    const db = 20 * Math.log10(Math.max(rms, 1e-6));
    const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
    this.meterFill.style.width = `${pct}%`;
  }
}
