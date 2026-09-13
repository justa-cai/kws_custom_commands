/**
 * 页面装配。
 *
 * 这里只做三件事：把面板摆上去、把事件接到一起、把状态存回 localStorage。
 * 识别逻辑一行都不在这——那是 Detector 和两个引擎的事。
 *
 * 一个刻意的取舍：模型**不自动加载**。这是个 13 MB 的 wasm + 8 MB 的模型，
 * 进来就默默下载会让移动端用户直接关掉页面。所以首页只有一句话和一个
 * 「加载模型」按钮，点了才开始下，下载进度条挂在上面。
 */

import { MicrophoneSource } from '../audio/AudioCapture';
import { assetUrl } from '../audio/constants';
import { fileToSource, urlToSource, type PlaybackSpeed } from '../audio/WavFileSource';
import type { ExtractedPayload } from '../engines/dtw/protocol';
import type { CalibrationResult } from '../engines/dtw/DtwEngine';
import type { DtwTemplate } from '../engines/dtw/types';
import { loadTokenizeContext } from '../models/loadContext';
import { getModel, MODELS, type ModelDescriptor } from '../models/descriptors';
import { runGoldenSelfTest, type GoldenReport } from '../selftest/golden';
import { Detector, type DetectionEvent, type WordIssue } from '../state/Detector';
import {
  defaultState,
  exportStateJson,
  importStateJson,
  loadState,
  saveState,
  type AppState,
} from '../state/store';
import { button, el, field } from './dom';
import { KeywordListPanel } from './panels/KeywordListPanel';
import { LogPanel } from './panels/LogPanel';
import { StatusBar } from './panels/StatusBar';
import { VoiceCommandPanel } from './panels/VoiceCommandPanel';
import './styles.css';

type SourceKind = 'mic' | 'sample' | 'file';

export class App {
  private state: AppState;
  private model: ModelDescriptor;
  private ctx: Awaited<ReturnType<typeof loadTokenizeContext>> | null = null;

  private readonly detector: Detector;
  private readonly log = new LogPanel();
  private readonly status = new StatusBar();
  private readonly notice = el('div');

  private wakePanel!: KeywordListPanel;
  private typedPanel!: KeywordListPanel;
  private voicePanel!: VoiceCommandPanel;

  private readonly modelSelect = el('select', {});
  private readonly loadBtn: HTMLButtonElement;
  private readonly modelStatus = el('span', { class: 'field-label' });
  private readonly progressFill = el('i');
  private readonly startBtn: HTMLButtonElement;
  private readonly sourceSelect = el('select', {});
  private readonly sampleSelect = el('select', {});
  private readonly speedSelect = el('select', {});
  private readonly fileInput = el('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
  private readonly selfTestOut = el('div', { class: 'selftest' });

  private sourceKind: SourceKind = 'mic';
  private selectedFile: File | null = null;
  private pausedForRecording = false;

  constructor(private readonly root: HTMLElement) {
    this.state = loadState();
    this.model = getModel(this.state.settings.modelId);

    this.detector = new Detector({
      onEvent: (e) => this.onEvent(e),
      onMachine: (s, ms) => this.status.setState(s, ms),
      onLevel: (rms) => this.status.setLevel(rms),
      onRunningChange: (running) => this.onRunningChange(running),
      onWordIssues: (issues) => this.onWordIssues(issues),
    });

    this.loadBtn = button('加载模型', () => void this.loadModel(), { class: 'primary' });
    this.startBtn = button('开始监听', () => void this.toggleDetection(), { class: 'primary' });
    this.startBtn.disabled = true;

    this.buildLayout();
    this.status.setMode(this.state.settings.useStateMachine ? '状态机：唤醒 → 听命令' : '三路并行监听');
  }

  // -------------------------------------------------------------------------
  // 布局
  // -------------------------------------------------------------------------

  private buildLayout(): void {
    for (const m of MODELS) {
      this.modelSelect.appendChild(
        el('option', { value: m.id, text: m.label, selected: m.id === this.state.settings.modelId }),
      );
    }
    this.modelSelect.addEventListener('change', () => {
      this.state.settings.modelId = this.modelSelect.value;
      this.model = getModel(this.modelSelect.value);
      this.persist();
      this.setNotice(
        'info',
        `已切到「${this.model.label}」。点「加载模型」生效——换模型要重新下载权重并重建词表。`,
      );
      this.renderSampleOptions();
    });

    this.sourceSelect.append(
      el('option', { value: 'mic', text: '麦克风' }),
      el('option', { value: 'sample', text: '示例音频' }),
      el('option', { value: 'file', text: '上传文件…' }),
    );
    this.sourceSelect.addEventListener('change', () => {
      this.sourceKind = this.sourceSelect.value as SourceKind;
      if (this.sourceKind === 'file') this.fileInput.click();
      this.syncSourceControls();
    });

    this.speedSelect.append(
      el('option', { value: '1', text: '1×' }),
      el('option', { value: '2', text: '2×' }),
      el('option', { value: '4', text: '4×' }),
      el('option', { value: 'instant', text: '尽快跑完' }),
    );
    this.speedSelect.value = String(this.state.settings.fileSpeed);
    this.speedSelect.addEventListener('change', () => {
      const v = this.speedSelect.value;
      this.state.settings.fileSpeed = (v === 'instant' ? 'instant' : Number(v)) as PlaybackSpeed;
      this.persist();
    });

    this.fileInput.addEventListener('change', () => {
      this.selectedFile = this.fileInput.files?.[0] ?? null;
      this.setNotice(this.selectedFile ? 'info' : 'warn', this.selectedFile ? `已选：${this.selectedFile.name}` : '没选文件');
      this.syncSourceControls();
    });

    this.renderSampleOptions();

    const toolbar = el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'toolbar' },
        field('模型', this.modelSelect),
        el('div', { class: 'field' }, el('span', { class: 'field-label', text: ' ' }), this.loadBtn),
        el('div', { class: 'field grow' }, el('span', { class: 'field-label', text: '状态' }), this.modelStatus),
        field('音频来源', this.sourceSelect),
        field('示例', this.sampleSelect),
        field('速度', this.speedSelect),
        el('div', { class: 'field' }, el('span', { class: 'field-label', text: ' ' }), this.startBtn),
      ),
      el('div', { class: 'progress' }, this.progressFill),
      this.notice,
      this.fileInput,
    );

    this.wakePanel = new KeywordListPanel({
      title: '唤醒词',
      hint: '待机时只认这些词',
      placeholder: '例如：小爱同学 / LIGHT UP',
      getContext: () => this.ctx,
      getEntries: () => this.state.wakeWords,
      setEntries: (entries) => {
        this.state.wakeWords = entries;
        this.persistAndApply();
      },
    });

    this.typedPanel = new KeywordListPanel({
      title: '打字造词',
      hint: '输入文字即生成，不用录音',
      placeholder: '例如：打开空调 / TURN ON THE LIGHT',
      getContext: () => this.ctx,
      getEntries: () => this.state.typedCommands,
      setEntries: (entries) => {
        this.state.typedCommands = entries;
        this.persistAndApply();
      },
    });

    this.voicePanel = new VoiceCommandPanel({
      getCommands: () => this.state.voiceCommands,
      setCommands: (commands) => {
        this.state.voiceCommands = commands;
        this.persistAndApply();
        if (this.pausedForRecording && !this.detector.isRunning) {
          this.setNotice('info', '录音命令已保存。监听还处于暂停状态——点「开始监听」继续。');
        }
      },
      extract: (samples) => this.extractViaWorker(samples),
      calibrate: (templates, negative) => this.calibrateViaWorker(templates, negative),
      beforeRecord: async () => {
        if (this.detector.isRunning) {
          this.pausedForRecording = true;
          await this.detector.stop();
          this.setNotice('info', '为了不抢麦克风，录音期间已暂停监听。录完点「开始监听」继续。');
        }
      },
      afterRecord: async () => {},
      log: (text, detail) => this.log.add({ at: Date.now(), kind: 'info', text, ...(detail ? { detail } : {}) }),
    });

    // 打字造词和录音造词是两个独立的能力，用标签页分开；
    // 两个面板自己就是 card，所以标签条单独摆在上面
    const typedPane = this.typedPanel.root;
    const voicePane = this.voicePanel.root;
    voicePane.style.display = 'none';

    const typedBtn = el('button', { type: 'button', text: '打字造词', 'aria-selected': 'true' });
    const voiceBtn = el('button', { type: 'button', text: '录音造词', 'aria-selected': 'false' });
    const selectTab = (which: 'typed' | 'voice') => {
      typedBtn.setAttribute('aria-selected', String(which === 'typed'));
      voiceBtn.setAttribute('aria-selected', String(which === 'voice'));
      typedPane.style.display = which === 'typed' ? '' : 'none';
      voicePane.style.display = which === 'voice' ? '' : 'none';
    };
    typedBtn.addEventListener('click', () => selectTab('typed'));
    voiceBtn.addEventListener('click', () => selectTab('voice'));

    const left = el(
      'div',
      {},
      this.wakePanel.root,
      el(
        'div',
        { class: 'tabs', style: { marginTop: '16px' } },
        typedBtn,
        voiceBtn,
      ),
      typedPane,
      voicePane,
    );

    const right = el('div', {}, this.status.root, this.log.root, this.buildSettingsCard());

    this.root.append(
      el(
        'header',
        { class: 'masthead' },
        el('h1', { text: 'KWS 唤醒词 · 自定义命令词' }),
        el('span', {
          class: 'tagline',
          text: '纯浏览器端 · 无后端 · 中英文',
        }),
        el('a', {
          class: 'repo-link',
          href: 'https://github.com/justa-cai/kws_custom_commands',
          target: '_blank',
          rel: 'noreferrer',
          text: 'GitHub',
        }),
      ),
      toolbar,
      el('div', { class: 'columns' }, left, right),
    );

    this.syncSourceControls();
    this.persistAndApply();
  }

  private buildSettingsCard(): HTMLElement {
    const machineToggle = el('input', {
      type: 'checkbox',
      checked: this.state.settings.useStateMachine,
      onChange: (ev: Event) => {
        this.state.settings.useStateMachine = (ev.target as HTMLInputElement).checked;
        this.status.setMode(
          this.state.settings.useStateMachine ? '状态机：唤醒 → 听命令' : '三路并行监听',
        );
        this.persistAndApply();
      },
    });

    const windowInput = el('input', {
      type: 'number',
      min: '1',
      max: '30',
      step: '0.5',
      value: (this.state.settings.awakeWindowMs / 1000).toFixed(1),
      onChange: (ev: Event) => {
        const sec = Number((ev.target as HTMLInputElement).value);
        if (Number.isFinite(sec) && sec > 0) {
          this.state.settings.awakeWindowMs = Math.round(sec * 1000);
          this.persistAndApply();
        }
      },
    });
    windowInput.style.width = '80px';

    return el(
      'section',
      { class: 'card' },
      el('h2', {}, '设置与自检'),
      el(
        'div',
        { class: 'row', style: { marginBottom: '10px' } },
        machineToggle,
        el('span', { text: '状态机（唤醒后 N 秒内才认命令词）' }),
      ),
      el('div', { class: 'row', style: { marginBottom: '14px' } }, el('span', { text: '听命令窗口' }), windowInput, el('span', { text: '秒' })),
      el(
        'div',
        { class: 'row' },
        button('跑一遍分词器自检', () => void this.runSelfTest()),
        button('导出配置', () => this.exportConfig()),
        button('导入配置', () => this.importConfig()),
        button('恢复默认', () => this.resetAll(), { class: 'danger' }),
      ),
      this.selfTestOut,
    );
  }

  private syncSourceControls(): void {
    this.sampleSelect.disabled = this.sourceKind !== 'sample';
    this.speedSelect.disabled = this.sourceKind === 'mic';
    if (this.sourceKind === 'file' && !this.selectedFile) {
      this.startBtn.disabled = true;
      this.modelStatus.textContent = '还没选文件';
    } else {
      this.startBtn.disabled = !this.detector.modelLoaded;
    }
  }

  private renderSampleOptions(): void {
    this.sampleSelect.replaceChildren();
    for (const path of this.model.sampleWavs) {
      this.sampleSelect.appendChild(
        el('option', { value: path, text: path.split('/').pop() ?? path, selected: path === this.model.sampleWavs[0] }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // 模型
  // -------------------------------------------------------------------------

  private async loadModel(): Promise<void> {
    this.loadBtn.disabled = true;
    this.modelSelect.disabled = true;
    this.progressFill.style.width = '0%';
    this.setNotice('info', `正在加载 ${this.model.label}…（wasm 13 MB + 模型 8 MB，第一次会慢）`);

    try {
      this.modelStatus.textContent = '拉取 tokens / 词典…';
      this.ctx = await loadTokenizeContext(this.model);
      this.modelStatus.textContent = `tokens ${this.ctx.tokens.size} 个${
        this.ctx.lexicon ? ` · 英文词典 ${this.ctx.lexicon.size} 词` : ' · 无英文词典'
      }`;

      this.detector.applyState(this.state, this.ctx);
      await this.detector.loadModel(this.model, this.ctx);

      this.progressFill.style.width = '100%';
      this.modelStatus.textContent = `${this.model.label} 已就绪`;
      this.setNotice('info', '模型就绪。选个音频来源，点「开始监听」。');

      this.wakePanel.refreshPreviews();
      this.typedPanel.refreshPreviews();
      this.syncSourceControls();
    } catch (e) {
      this.progressFill.style.width = '0%';
      this.modelStatus.textContent = '加载失败';
      this.setNotice('error', (e as Error).message);
    } finally {
      this.loadBtn.disabled = false;
      this.modelSelect.disabled = false;
    }
  }

  // -------------------------------------------------------------------------
  // 检测
  // -------------------------------------------------------------------------

  private async toggleDetection(): Promise<void> {
    if (this.detector.isRunning) {
      await this.detector.stop();
      return;
    }
    if (!this.detector.modelLoaded) {
      this.setNotice('warn', '先点「加载模型」。');
      return;
    }

    this.startBtn.disabled = true;
    try {
      const source = await this.buildSource();
      await this.detector.start(source);
    } catch (e) {
      this.setNotice('error', `启动失败：${(e as Error).message}`);
      this.startBtn.disabled = false;
    }
  }

  private async buildSource() {
    if (this.sourceKind === 'mic') {
      return new MicrophoneSource();
    }
    const speed = this.state.settings.fileSpeed;
    if (this.sourceKind === 'sample') {
      const path = this.sampleSelect.value;
      if (!path) throw new Error('没选示例音频');
      return urlToSource(assetUrl(path), speed);
    }
    if (!this.selectedFile) throw new Error('没选文件');
    return fileToSource(this.selectedFile, speed);
  }

  private onRunningChange(running: boolean): void {
    this.startBtn.disabled = false;
    this.startBtn.textContent = running ? '停止监听' : '开始监听';
    this.startBtn.classList.toggle('danger', running);
    this.sourceSelect.disabled = running;
    this.modelSelect.disabled = running;
    this.loadBtn.disabled = running;
    if (running) this.pausedForRecording = false;
  }

  private onEvent(e: DetectionEvent): void {
    this.log.add(e);
  }

  private onWordIssues(issues: WordIssue[]): void {
    if (issues.length === 0) {
      this.setNotice('info', this.detector.modelLoaded ? '词表已生效。' : '');
      return;
    }
    const lines = issues.map((i) => `· [${i.list === 'wake' ? '唤醒词' : '命令词'}] ${i.text}：${i.message}`);
    this.setNotice('warn', `有 ${issues.length} 条词没能进词表：\n${lines.join('\n')}`);
  }

  // -------------------------------------------------------------------------
  // DTW worker 桥
  // -------------------------------------------------------------------------

  private async extractViaWorker(samples: Float32Array): Promise<ExtractedPayload> {
    return this.dtwBridge.extract(samples);
  }

  private async calibrateViaWorker(
    templates: DtwTemplate[],
    negative: DtwTemplate | null,
  ): Promise<CalibrationResult> {
    return this.dtwBridge.calibrate(templates, negative);
  }

  /** 面板需要一个能直接调 extract/calibrate 的对象；Detector 里的那个不对外 */
  private get dtwBridge(): {
    extract: (s: Float32Array) => Promise<ExtractedPayload>;
    calibrate: (t: DtwTemplate[], n: DtwTemplate | null) => Promise<CalibrationResult>;
  } {
    return this.detector.workerBridge;
  }

  // -------------------------------------------------------------------------
  // 自检 / 配置
  // -------------------------------------------------------------------------

  private async runSelfTest(): Promise<void> {
    this.selfTestOut.textContent = '跑自检中…';
    try {
      const report: GoldenReport = await runGoldenSelfTest(this.model, {
        readText: (p) => fetch(`${assetUrl(this.model.dir)}/${p}`).then((r) => r.text()),
      });

      this.selfTestOut.replaceChildren();
      if (report.fatal) {
        this.selfTestOut.appendChild(el('div', { class: 'bad', text: `✗ ${report.fatal}` }));
        return;
      }
      this.selfTestOut.appendChild(
        el('div', {
          class: report.ok ? 'ok' : 'bad',
          text: `${report.ok ? '✓' : '✗'} ${report.modelLabel}：${report.passed}/${report.total} 逐音素命中官方样本`,
        }),
      );
      for (const c of report.cases) {
        this.selfTestOut.appendChild(
          el('div', {
            class: c.passed === c.total ? 'ok' : 'bad',
            text: `  ${c.label}[${c.kind}] ${c.passed}/${c.total}`,
          }),
        );
        for (const f of c.failures) {
          this.selfTestOut.appendChild(
            el('div', { text: `    ${f.display}  期望「${f.expected}」得到「${f.actual}」` }),
          );
        }
      }
    } catch (e) {
      this.selfTestOut.textContent = `自检失败：${(e as Error).message}`;
    }
  }

  private exportConfig(): void {
    const blob = new Blob([exportStateJson(this.state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: 'kws-custom-commands.json' });
    a.click();
    URL.revokeObjectURL(url);
  }

  private importConfig(): void {
    const input = el('input', { type: 'file', accept: 'application/json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        this.state = importStateJson(await file.text());
        this.model = getModel(this.state.settings.modelId);
        saveState(this.state);
        location.reload();
      } catch (e) {
        this.setNotice('error', `导入失败：${(e as Error).message}`);
      }
    });
    input.click();
  }

  private resetAll(): void {
    if (!confirm('清空所有词条、录音模板和设置？这一步不可撤销。')) return;
    this.state = defaultState();
    saveState(this.state);
    location.reload();
  }

  // -------------------------------------------------------------------------
  // 状态
  // -------------------------------------------------------------------------

  private persist(): void {
    saveState(this.state);
  }

  private persistAndApply(): void {
    saveState(this.state);
    if (this.ctx) this.detector.applyState(this.state, this.ctx);
    else this.detector.applyState(this.state, { tokens: new Set(), lexicon: null });
  }

  private setNotice(kind: 'info' | 'warn' | 'error', message: string): void {
    this.notice.className = kind && message ? `notice ${kind}` : '';
    this.notice.replaceChildren();
    if (!message) return;
    const lines = message.split('\n');
    this.notice.appendChild(document.createTextNode(lines[0]!));
    if (lines.length > 1) {
      this.notice.appendChild(el('pre', { text: lines.slice(1).join('\n') }));
    }
  }

  /** 给 main.ts 用的收尾钩子 */
  dispose(): void {
    this.detector.dispose();
  }
}
