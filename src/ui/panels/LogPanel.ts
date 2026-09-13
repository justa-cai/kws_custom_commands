/**
 * 事件日志面板。
 *
 * 命中的词要能一眼分辨来源：sherpa-onnx（打字造词）、DTW（录音造词）、
 * 还是"识别到了但没唤醒"（blocked）。最后这一类尤其要有存在感——
 * 状态机开着的时候，用户在待机状态念命令词其实什么都不会发生，
 * 只显示"没反应"的话他会以为程序坏了。
 */

import type { DetectionEvent } from '../../state/Detector';
import { clear, el } from '../dom';

const KIND_LABEL: Record<DetectionEvent['kind'], string> = {
  wake: '唤醒',
  command: '命令',
  voice: '录音词',
  blocked: '未唤醒',
  timeout: '超时',
  info: '信息',
  error: '错误',
};

const MAX_ENTRIES = 500;

function formatTime(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export class LogPanel {
  readonly root: HTMLElement;

  private readonly list = el('div', { class: 'log' });
  private readonly emptyHint = el('div', {
    class: 'empty',
    text: '还没有事件。点上面的「开始监听」。',
  });
  private count = 0;

  constructor() {
    this.root = el(
      'section',
      { class: 'card' },
      el(
        'h2',
        {},
        '事件日志',
        el('span', { class: 'hint', text: '命中、超时、错误都在这' }),
        el('span', { style: { flex: '1' } }),
        el('button', {
          type: 'button',
          class: 'icon-btn',
          text: '清空',
          onClick: () => this.clear(),
        }),
      ),
      this.list,
      this.emptyHint,
    );
  }

  add(e: DetectionEvent): void {
    this.emptyHint.style.display = 'none';
    const line = el(
      'div',
      { class: `log-line ${e.kind}` },
      el('span', { class: 't', text: formatTime(e.at) }),
      el('span', { class: 'kind', text: KIND_LABEL[e.kind] ?? e.kind }),
      el('span', { text: e.text }),
      e.detail ? el('span', { class: 'detail', text: e.detail }) : null,
    );

    // 贴底时才自动滚动，用户在翻历史就别打扰他
    const stick = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 24;
    this.list.appendChild(line);
    this.count++;
    if (this.count > MAX_ENTRIES && this.list.firstChild) {
      this.list.removeChild(this.list.firstChild);
      this.count--;
    }
    if (stick) this.list.scrollTop = this.list.scrollHeight;
  }

  clear(): void {
    clear(this.list);
    this.count = 0;
    this.emptyHint.style.display = '';
  }
}
