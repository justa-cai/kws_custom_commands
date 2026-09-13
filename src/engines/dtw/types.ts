/**
 * DTW 录音造词的数据模型。
 *
 * 和 sherpa-onnx 那条路不同，这里没有"模型"可言：模板就是用户自己的声音。
 * 好处是**天然支持任何语言**——模板匹配只看声学形状，不看文本，
 * 所以冰岛语、方言、甚至吹口哨都能造词，这是开放词汇模型给不了的。
 * 代价是识别精度全靠模板质量和阈值调校，所以每条命令都带着自己的阈值。
 */

/** 一条模板 = 一段特征帧序列 */
export interface DtwTemplate {
  /** 特征维数 = 2 × 13（倒谱 + 差分） */
  dim: number;
  frames: number;
  data: Float32Array;
}

/** 一次录音造词的结果：同一个词可能会录好几遍，存成多条模板 */
export interface VoiceCommand {
  id: string;
  /** 用户给这个词起的名字，命中时直接展示 */
  text: string;
  templates: DtwTemplate[];
  /** 归一化距离阈值，越小越严格 */
  threshold: number;
  enabled: boolean;
  createdAt: number;
  /** 造词时录的负样本，用来算阈值；保留下来便于之后重新校准 */
  negative?: DtwTemplate | null;
}

export interface DtwHit {
  commandId: string;
  text: string;
  distance: number;
  /** 命中发生的时间（相对本次会话开始，秒） */
  time: number;
}

// ---------------------------------------------------------------------------
// 序列化：模板要能进 localStorage 和导出成 JSON
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SerializedTemplate {
  dim: number;
  frames: number;
  /** Float32 小端字节的 base64 */
  data: string;
}

export function serializeTemplate(t: DtwTemplate): SerializedTemplate {
  return {
    dim: t.dim,
    frames: t.frames,
    data: bytesToBase64(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength)),
  };
}

export function deserializeTemplate(s: SerializedTemplate): DtwTemplate {
  const bytes = base64ToBytes(s.data);
  // 复制一份，避免对齐问题
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return {
    dim: s.dim,
    frames: s.frames,
    data: new Float32Array(copy.buffer),
  };
}

export const DEFAULT_DTW_THRESHOLD = 1.2;
