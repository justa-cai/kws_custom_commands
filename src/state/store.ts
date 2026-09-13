/**
 * 词表 / 模板 / 设置的持久化。
 *
 * 全塞 localStorage，没有后端。DTW 模板是 Float32 特征帧，直接 JSON 化会
 * 膨胀成几 MB 的十进制数字，所以按 base64 存（见 types.ts 的 serializeTemplate）。
 *
 * 另外提供导出/导入 JSON：模板是用户花时间录出来的，浏览器一清缓存就没了，
 * 得给他们一条能自己备份的路。也方便把一份调好的词表分享给别人。
 */

import {
  DEFAULT_DTW_THRESHOLD,
  deserializeTemplate,
  serializeTemplate,
  type SerializedTemplate,
  type VoiceCommand,
} from '../engines/dtw/types';
import { DEFAULT_MODEL_ID, MODELS } from '../models/descriptors';
import { DEFAULT_AWAKE_WINDOW_MS } from './Machine';

const STORAGE_KEY = 'kws_custom_commands.state.v1';
const SCHEMA_VERSION = 1;

export interface KeywordEntry {
  id: string;
  /** 用户敲的原文，汉字/英文都行 */
  text: string;
  /** 增强分数，越大越容易触发；留空用模型默认 */
  boost?: number;
  /** 触发阈值（0~1），越小越容易触发；留空用模型默认 */
  threshold?: number;
  enabled: boolean;
}

export type PlaybackSpeed = 1 | 2 | 4 | 'instant';

export interface AppSettings {
  modelId: string;
  /** 唤醒后听命令的窗口（毫秒） */
  awakeWindowMs: number;
  /** 开状态机（唤醒→听命令）还是三路并行独立监听 */
  useStateMachine: boolean;
  fileSpeed: PlaybackSpeed;
  dtw: {
    stepFrames: number;
    confirmCount: number;
    cooldownFrames: number;
    windowScale: number;
  };
}

export interface AppState {
  version: number;
  settings: AppSettings;
  wakeWords: KeywordEntry[];
  typedCommands: KeywordEntry[];
  voiceCommands: VoiceCommand[];
}

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function newKeyword(text: string, enabled = true): KeywordEntry {
  return { id: uid(), text, enabled };
}

export function defaultState(): AppState {
  return {
    version: SCHEMA_VERSION,
    settings: {
      modelId: DEFAULT_MODEL_ID,
      awakeWindowMs: DEFAULT_AWAKE_WINDOW_MS,
      useStateMachine: true,
      fileSpeed: 1,
      dtw: { stepFrames: 3, confirmCount: 2, cooldownFrames: 150, windowScale: 1.8 },
    },
    // 默认给两个能在模型自带 test_wavs 上直接验证的词，打开页面就能试
    wakeWords: [newKeyword('小爱同学'), newKeyword('LIGHT UP')],
    typedCommands: [newKeyword('打开空调'), newKeyword('关闭空调')],
    voiceCommands: [],
  };
}

// ---------------------------------------------------------------------------
// 序列化
// ---------------------------------------------------------------------------

interface PersistedVoiceCommand extends Omit<VoiceCommand, 'templates' | 'negative'> {
  templates: SerializedTemplate[];
  negative?: SerializedTemplate | null;
}

interface PersistedState extends Omit<AppState, 'voiceCommands'> {
  voiceCommands: PersistedVoiceCommand[];
}

function toPersisted(state: AppState): PersistedState {
  return {
    ...state,
    voiceCommands: state.voiceCommands.map((c) => ({
      ...c,
      templates: c.templates.map(serializeTemplate),
      negative: c.negative ? serializeTemplate(c.negative) : null,
    })),
  };
}

function fromPersisted(p: PersistedState): AppState {
  return {
    ...p,
    settings: { ...defaultState().settings, ...p.settings },
    voiceCommands: (p.voiceCommands ?? []).map((c) => ({
      ...c,
      templates: (c.templates ?? []).map(deserializeTemplate),
      negative: c.negative ? deserializeTemplate(c.negative) : null,
      threshold: c.threshold ?? DEFAULT_DTW_THRESHOLD,
      enabled: c.enabled ?? true,
    })),
  };
}

/** 只保留当前还存在的模型 id，免得删了模型之后页面起不来 */
function sanitize(state: AppState): AppState {
  if (!MODELS.some((m) => m.id === state.settings.modelId)) {
    state.settings.modelId = DEFAULT_MODEL_ID;
  }
  return state;
}

// ---------------------------------------------------------------------------
// 读写
// ---------------------------------------------------------------------------

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== SCHEMA_VERSION) {
      console.warn(`存储的版本是 ${parsed.version}，当前是 ${SCHEMA_VERSION}，按当前版本重来`);
      return defaultState();
    }
    return sanitize(fromPersisted(parsed));
  } catch (e) {
    console.warn('读取本地存储失败，用默认配置', e);
    return defaultState();
  }
}

export function saveState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toPersisted(state)));
  } catch (e) {
    // QuotaExceededError 是这里最常见的：模板录太多条了
    console.warn('保存本地存储失败（可能是模板太多超出配额）', e);
  }
}

export function exportStateJson(state: AppState): string {
  return JSON.stringify(toPersisted(state), null, 2);
}

export function importStateJson(json: string): AppState {
  const parsed = JSON.parse(json) as PersistedState;
  if (typeof parsed !== 'object' || parsed === null) throw new Error('不是一个 JSON 对象');
  return sanitize(fromPersisted({ ...defaultState(), ...parsed, version: SCHEMA_VERSION }));
}

export function clearStoredState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export { uid };
