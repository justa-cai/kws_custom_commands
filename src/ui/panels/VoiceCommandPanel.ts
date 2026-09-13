/**
 * 录音造词面板。
 *
 * 流程刻意做得啰嗦：**录多遍 → 录一段负样本 → 保存**。
 * 每一遍录音都单独回放确认，因为模板匹配的质量完全取决于这几段录音——
 * 用户没法从"识别不灵"这个结果反推出"是第三遍录的时候旁边有人在说话"。
 *
 * 负样本不是可选项而是推荐项：不录的话阈值只能拍脑袋，
 * 结果要么安静环境里能触发、嘈杂环境里全是误报，要么反过来。
 * 录一段"随便说点别的"，阈值就能落在两者中间（见 DtwEngine.calibrate）。
 */

import { SampleRecorder, samplesToWavBlob } from '../../audio/Recorder';
import type { CalibrationResult } from '../../engines/dtw/DtwEngine';
import type { ExtractedPayload } from '../../engines/dtw/protocol';
import { deserializeTemplate, type DtwTemplate, type VoiceCommand } from '../../engines/dtw/types';
import { uid } from '../../state/store';
import { button, el } from '../dom';

interface DraftTake {
  id: string;
  samples: Float32Array;
  durationSec: number;
}

export interface VoiceCommandPanelOptions {
  getCommands: () => VoiceCommand[];
  setCommands: (commands: VoiceCommand[]) => void;
  /** 交给 DTW worker 做端点检测 + 特征提取 */
  extract: (samples: Float32Array) => Promise<ExtractedPayload>;
  calibrate: (templates: DtwTemplate[], negative: DtwTemplate | null) => Promise<CalibrationResult>;
  /** 录音前后暂停/恢复检测会话（避免两个麦克风同时开） */
  beforeRecord: () => Promise<void>;
  afterRecord: () => Promise<void>;
  log: (text: string, detail?: string) => void;
}

const MAX_TAKES = 5;
const MAX_SECONDS = 5;

export class VoiceCommandPanel {
  readonly root: HTMLElement;

  private readonly nameInput: HTMLInputElement;
  private readonly recordBtn: HTMLButtonElement;
  private readonly negativeBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly hint = el('div', { class: 'record-hint' });
  private readonly takesList = el('div', { class: 'take-list' });
  private readonly commandsList = el('div');
  private readonly progressFill = el('i');

  private readonly recorder = new SampleRecorder({
    maxSeconds: MAX_SECONDS,
    onLevel: (rms) => {
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      this.progressFill.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    },
    onAutoStop: () => void this.stopRecording(),
  });

  private takes: DraftTake[] = [];
  private negative: DraftTake | null = null;
  /** 正在录什么：普通模板 / 负样本 */
  private recordingMode: 'take' | 'negative' | null = null;

  constructor(private readonly opts: VoiceCommandPanelOptions) {
    this.nameInput = el('input', {
      type: 'text',
      placeholder: '给这个词起个名字，例如：打开空调',
      // 名字是"什么时候能保存"的一半条件，边打边更新按钮标签
      onInput: () => this.updateSaveButton(),
    });

    this.recordBtn = button('● 录音', () => void this.toggleRecording('take'), {
      class: 'primary',
      title: `点一下开始，再点一下结束（最多 ${MAX_SECONDS} 秒）`,
    });
    this.negativeBtn = button('录负样本', () => void this.toggleRecording('negative'), {
      title: '随便说一句别的话，用来算触发阈值',
    });
    this.saveBtn = button('保存这个命令', () => void this.save(), { class: 'primary' });

    this.root = el(
      'section',
      { class: 'card' },
      el(
        'h2',
        {},
        '录音造词',
        el('span', { class: 'hint', text: '现场念几遍就能造词，任何语言都行' }),
      ),
      el(
        'div',
        { class: 'card-sub' },
        '录 3~5 遍同样的词。模板匹配只看声音形状、不看文本，所以方言、口音、外语甚至口哨都能造词——这是打字造词做不到的。',
      ),
      el(
        'div',
        { class: 'row' },
        el('div', { style: { flex: '1', minWidth: '180px' } }, this.nameInput),
        this.recordBtn,
        this.negativeBtn,
      ),
      el('div', { class: 'progress' }, this.progressFill),
      this.hint,
      this.takesList,
      el('div', { class: 'row' }, this.saveBtn),
      el('div', { style: { borderTop: '1px solid var(--border)', margin: '18px 0 14px' } }),
      el('h2', { style: { fontSize: '13px', margin: '0 0 10px' } }, '已有的录音命令'),
      this.commandsList,
    );

    this.renderTakes();
    this.renderCommands();
  }

  // -------------------------------------------------------------------------

  private async toggleRecording(mode: 'take' | 'negative'): Promise<void> {
    if (this.recordingMode) {
      await this.stopRecording();
      return;
    }

    if (mode === 'take' && this.takes.length >= MAX_TAKES) {
      this.opts.log(`最多 ${MAX_TAKES} 遍就够了`, '先保存或删掉几遍');
      return;
    }

    this.recordingMode = mode;
    this.recordBtn.textContent = mode === 'take' ? '■ 停止' : '● 录音';
    this.negativeBtn.textContent = mode === 'negative' ? '■ 停止' : '录负样本';
    this.recordBtn.disabled = mode === 'negative';
    this.negativeBtn.disabled = mode === 'take';
    this.saveBtn.disabled = true;
    this.hint.textContent =
      mode === 'negative'
        ? '录一段"别的话"（不是这个词）—— 用来把阈值定在"像"和"不像"之间。'
        : `第 ${this.takes.length + 1} 遍：念一遍这个命令词，念完停一下。`;

    try {
      await this.opts.beforeRecord();
      await this.recorder.start();
    } catch (e) {
      this.recordingMode = null;
      this.resetButtons();
      this.hint.textContent = '';
      this.opts.log('录音失败', (e as Error).message);
      await this.opts.afterRecord();
    }
  }

  private async stopRecording(): Promise<void> {
    const mode = this.recordingMode;
    if (!mode) return;
    this.recordingMode = null;

    const samples = await this.recorder.stop();
    await this.opts.afterRecord();
    this.resetButtons();
    this.progressFill.style.width = '0%';

    if (samples.length === 0) {
      this.opts.log('没录到声音', '检查麦克风权限');
      this.hint.textContent = '';
      return;
    }

    const payload = await this.opts.extract(samples);
    if (!payload.template) {
      this.hint.textContent = payload.reason ?? '这段用不了，重录一遍。';
      this.opts.log('这一遍用不了', payload.reason);
      return;
    }

    // 用切好的那段（而不是整段）来算时长与回放，所见即所得
    const trimmed = payload.trimmed ?? samples;
    const take: DraftTake = {
      id: uid(),
      samples: trimmed,
      durationSec: trimmed.length / 16000,
    };

    if (mode === 'negative') {
      this.negative = take;
      this.hint.textContent = `负样本已录（${take.durationSec.toFixed(2)}s）。再录 ${MAX_TAKES - this.takes.length} 遍目标词就可以保存了。`;
    } else {
      this.takes.push(take);
      this.hint.textContent =
        this.takes.length >= 2
          ? `已录 ${this.takes.length} 遍。多录几遍能显著降低误触发，也可以现在直接保存。`
          : '建议至少录 3 遍。';
    }

    this.renderTakes();
    this.updateSaveButton();
  }

  private resetButtons(): void {
    this.recordBtn.textContent = '● 录音';
    this.negativeBtn.textContent = '录负样本';
    this.recordBtn.disabled = false;
    this.negativeBtn.disabled = false;
    this.saveBtn.disabled = false;
  }

  private updateSaveButton(): void {
    const ready = this.takes.length > 0 && this.nameInput.value.trim().length > 0;
    this.saveBtn.disabled = !ready;
    this.saveBtn.textContent = ready
      ? `保存「${this.nameInput.value.trim()}」（${this.takes.length} 遍）`
      : '保存这个命令';
  }

  private renderTakes(): void {
    this.takesList.replaceChildren();
    for (const [i, take] of this.takes.entries()) {
      this.takesList.appendChild(
        el(
          'div',
          { class: 'take' },
          el('span', { text: `第 ${i + 1} 遍` }),
          el('span', { class: 'dur', text: `${take.durationSec.toFixed(2)}s` }),
          el('button', {
            type: 'button',
            class: 'icon-btn',
            text: '▶',
            title: '试听',
            onClick: () => this.play(take.samples),
          }),
          el('button', {
            type: 'button',
            class: 'icon-btn danger',
            text: '✕',
            title: '删掉这一遍',
            onClick: () => {
              this.takes = this.takes.filter((t) => t.id !== take.id);
              this.renderTakes();
              this.updateSaveButton();
            },
          }),
        ),
      );
    }

    if (this.negative) {
      this.takesList.appendChild(
        el(
          'div',
          { class: 'take' },
          el('span', { text: '负样本' }),
          el('span', { class: 'dur', text: `${this.negative.durationSec.toFixed(2)}s` }),
          el('button', {
            type: 'button',
            class: 'icon-btn',
            text: '▶',
            title: '试听',
            onClick: () => this.play(this.negative!.samples),
          }),
          el('button', {
            type: 'button',
            class: 'icon-btn danger',
            text: '✕',
            title: '删掉负样本',
            onClick: () => {
              this.negative = null;
              this.renderTakes();
            },
          }),
        ),
      );
    }
  }

  private play(samples: Float32Array): void {
    const url = URL.createObjectURL(samplesToWavBlob(samples));
    const audio = new Audio(url);
    audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
    void audio.play();
  }

  private async save(): Promise<void> {
    const name = this.nameInput.value.trim();
    if (!name || this.takes.length === 0) return;

    this.saveBtn.disabled = true;
    this.saveBtn.textContent = '正在算特征…';

    try {
      const templates: DtwTemplate[] = [];
      for (const take of this.takes) {
        const payload = await this.opts.extract(take.samples);
        if (payload.template) templates.push(deserializeTemplate(payload.template));
      }

      let negative: DtwTemplate | null = null;
      if (this.negative) {
        const payload = await this.opts.extract(this.negative.samples);
        if (payload.template) negative = deserializeTemplate(payload.template);
      }

      if (templates.length === 0) {
        this.opts.log('保存失败', '所有录音都没能提取出模板');
        return;
      }

      const calib = await this.opts.calibrate(templates, negative);

      const command: VoiceCommand = {
        id: uid(),
        text: name,
        templates,
        threshold: calib.threshold,
        enabled: true,
        createdAt: Date.now(),
        negative,
      };

      this.opts.setCommands([...this.opts.getCommands(), command]);
      this.opts.log(
        `已保存录音命令「${name}」`,
        `模板 ${templates.length} 条 · 阈值 ${calib.threshold.toFixed(2)} · ${calib.note}`,
      );

      this.nameInput.value = '';
      this.takes = [];
      this.negative = null;
      this.hint.textContent = '';
      this.renderTakes();
      this.renderCommands();
      this.updateSaveButton();
    } catch (e) {
      this.opts.log('保存失败', (e as Error).message);
    } finally {
      this.saveBtn.disabled = false;
      this.updateSaveButton();
    }
  }

  private renderCommands(): void {
    this.commandsList.replaceChildren();
    const commands = this.opts.getCommands();

    if (commands.length === 0) {
      this.commandsList.appendChild(
        el('div', { class: 'empty', text: '还没有录音命令。上面录几遍就能建一个。' }),
      );
      return;
    }

    for (const cmd of commands) {
      const thresholdValue = el('input', {
        type: 'number',
        step: '0.05',
        min: '0.3',
        max: '3',
        value: cmd.threshold.toFixed(2),
        title: '触发阈值：越小越严格',
        onChange: (ev: Event) => {
          cmd.threshold = Number((ev.target as HTMLInputElement).value) || cmd.threshold;
          this.opts.setCommands([...this.opts.getCommands()]);
        },
      });
      thresholdValue.style.width = '72px';

      const node = el(
        'div',
        { class: `voice-cmd${cmd.enabled ? '' : ' disabled'}` },
        el(
          'div',
          { class: 'head' },
          el('input', {
            type: 'checkbox',
            checked: cmd.enabled,
            title: cmd.enabled ? '停用' : '启用',
            onChange: (ev: Event) => {
              cmd.enabled = (ev.target as HTMLInputElement).checked;
              node.classList.toggle('disabled', !cmd.enabled);
              this.opts.setCommands([...this.opts.getCommands()]);
            },
          }),
          el('span', { class: 'name', text: cmd.text }),
          el('span', { class: 'field-label', text: '阈值' }),
          thresholdValue,
          el('button', {
            type: 'button',
            class: 'icon-btn',
            text: '▶ 试听',
            title: '试听第一条模板',
            onClick: () => this.playTemplate(cmd.templates[0]),
          }),
          el('button', {
            type: 'button',
            class: 'icon-btn',
            text: '重算阈值',
            title: '拿现有的模板和负样本重新校准',
            onClick: () => void this.recalibrate(cmd),
          }),
          el('button', {
            type: 'button',
            class: 'icon-btn danger',
            text: '删除',
            onClick: () => {
              this.opts.setCommands(this.opts.getCommands().filter((c) => c.id !== cmd.id));
              this.renderCommands();
            },
          }),
        ),
        el('div', {
          class: 'meta',
          text: `${cmd.templates.length} 条模板 · 共 ${cmd.templates.reduce((n, t) => n + t.frames, 0)} 帧${
            cmd.negative ? ' · 有负样本' : ' · 无负样本'
          }`,
        }),
      );

      this.commandsList.appendChild(node);
    }
  }

  private async recalibrate(cmd: VoiceCommand): Promise<void> {
    const calib = await this.opts.calibrate(cmd.templates, cmd.negative ?? null);
    cmd.threshold = calib.threshold;
    this.opts.setCommands([...this.opts.getCommands()]);
    this.opts.log(`重算「${cmd.text}」的阈值`, `${calib.threshold.toFixed(2)} · ${calib.note}`);
    this.renderCommands();
  }

  /**
   * 试听模板：模板里存的是特征帧不是波形，没法还原成声音。
   * 这里用一条平坦的提示音占位不合适，所以直接取原始录音——
   * 但重新渲染后原始样本已经丢了，只能提示用户看"第 N 遍"的 ▶。
   */
  private playTemplate(template: DtwTemplate | undefined): void {
    if (!template) return;
    this.opts.log(
      '模板不能直接试听',
      `模板存的是 ${template.frames} 帧声学特征，还原不出声音；请用上面每一遍录音的 ▶ 试听。`,
    );
  }

  /** 模型/词表变化后由 App 调用 */
  refresh(): void {
    this.renderCommands();
  }
}
