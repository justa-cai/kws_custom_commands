/**
 * 打字造词的词条列表（唤醒词和命令词共用一套）。
 *
 * 每行实时显示分词结果——这是这个页面最有价值的一处反馈：
 * 用户敲"重庆"，如果模型里没有那个音素，这里会当场标红说明原因，
 * 而不是等他喊了半天没反应再来猜。分词在浏览器里做，所以是即时的。
 */

import { tokenize, type TokenizeContext } from '../../engines/sherpa/tokenizer';
import { type KeywordEntry, newKeyword, uid } from '../../state/store';
import { button, el } from '../dom';

export interface KeywordListPanelOptions {
  title: string;
  hint: string;
  placeholder: string;
  /** 当前模型的分词上下文；模型没加载时返回 null */
  getContext: () => TokenizeContext | null;
  getEntries: () => KeywordEntry[];
  setEntries: (entries: KeywordEntry[]) => void;
}

export class KeywordListPanel {
  readonly root: HTMLElement;

  private readonly list = el('div', { class: 'word-list' });
  private readonly input: HTMLInputElement;
  private readonly notice = el('div', { class: 'empty' });
  private readonly rows = new Map<string, { preview: HTMLElement; row: HTMLElement }>();

  constructor(private readonly opts: KeywordListPanelOptions) {
    this.input = el('input', {
      type: 'text',
      placeholder: opts.placeholder,
      onKeydown: (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') this.addFromInput();
      },
    });

    this.root = el(
      'section',
      { class: 'card' },
      el('h2', {}, opts.title, el('span', { class: 'hint', text: opts.hint })),
      this.list,
      el(
        'div',
        { class: 'row' },
        el('div', { class: 'grow', style: { flex: '1' } }, this.input),
        button('添加', () => this.addFromInput()),
      ),
      this.notice,
    );

    this.render();
  }

  private addFromInput(): void {
    const text = this.input.value.trim();
    if (!text) return;
    this.opts.setEntries([...this.opts.getEntries(), newKeyword(text)]);
    this.input.value = '';
    this.render();
  }

  render(): void {
    this.rows.clear();
    this.list.replaceChildren();

    const entries = this.opts.getEntries();
    if (entries.length === 0) {
      this.list.appendChild(el('div', { class: 'empty', text: '还没有词条。' }));
    }

    for (const entry of entries) {
      const preview = el('span', { class: 'word-phones' });
      const row = el('div', { class: 'word-row' });

      const toggle = el('input', {
        type: 'checkbox',
        checked: entry.enabled,
        title: entry.enabled ? '停用' : '启用',
        onChange: (ev: Event) => {
          entry.enabled = (ev.target as HTMLInputElement).checked;
          row.classList.toggle('disabled', !entry.enabled);
          this.commit();
        },
      });

      const text = el('input', {
        type: 'text',
        value: entry.text,
        class: 'word-text',
        onChange: (ev: Event) => {
          entry.text = (ev.target as HTMLInputElement).value.trim();
          this.updatePreview(entry, preview, row);
          this.commit();
        },
      });

      const boost = el('input', {
        type: 'number',
        step: '0.1',
        min: '0',
        value: entry.boost ?? '',
        placeholder: '默认',
        title: '增强分数（boost）：越大越容易触发',
        onChange: (ev: Event) => {
          const v = (ev.target as HTMLInputElement).value;
          entry.boost = v === '' ? undefined : Number(v);
          this.commit();
        },
      });

      const threshold = el('input', {
        type: 'number',
        step: '0.05',
        min: '0',
        max: '1',
        value: entry.threshold ?? '',
        placeholder: '默认',
        title: '触发阈值：越小越容易触发',
        onChange: (ev: Event) => {
          const v = (ev.target as HTMLInputElement).value;
          entry.threshold = v === '' ? undefined : Number(v);
          this.commit();
        },
      });

      const remove = el('button', {
        type: 'button',
        class: 'icon-btn danger',
        text: '✕',
        title: '删除',
        onClick: () => {
          this.opts.setEntries(this.opts.getEntries().filter((e) => e.id !== entry.id));
          this.render();
        },
      });

      row.append(
        toggle,
        text,
        preview,
        el('span', { class: 'field-label', text: 'boost' }),
        boost,
        el('span', { class: 'field-label', text: '阈值' }),
        threshold,
        remove,
      );
      row.classList.toggle('disabled', !entry.enabled);

      this.list.appendChild(row);
      this.rows.set(entry.id, { preview, row });
      this.updatePreview(entry, preview, row);
    }

    this.notice.textContent =
      this.opts.getEntries().length === 0 ? '至少要有一个启用的词条，否则这一路不会建 stream。' : '';
  }

  /** 模型切换后调用：分词上下文变了，所有预览要重算 */
  refreshPreviews(): void {
    for (const entry of this.opts.getEntries()) {
      const found = this.rows.get(entry.id);
      if (found) this.updatePreview(entry, found.preview, found.row);
    }
  }

  private updatePreview(entry: KeywordEntry, preview: HTMLElement, row: HTMLElement): void {
    row.querySelector('.reason')?.remove();
    row.classList.remove('invalid');

    const ctx = this.opts.getContext();
    const text = entry.text.trim();
    if (!text) {
      preview.textContent = '';
      return;
    }
    if (!ctx) {
      preview.textContent = '（模型还没加载）';
      return;
    }

    const result = tokenize(text, ctx);
    preview.textContent = result.phones.join(' ');
    if (!result.ok) {
      row.classList.add('invalid');
      const reasons = [...new Set(result.issues.map((i) => i.message))].join('；');
      row.appendChild(el('span', { class: 'reason', text: reasons }));
    }
  }

  private commit(): void {
    this.opts.setEntries([...this.opts.getEntries()]);
  }
}

export { uid };
