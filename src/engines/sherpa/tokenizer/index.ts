/**
 * 词条文本 → sherpa-onnx 关键词串。
 *
 * 这就是浏览器里的 `sherpa-onnx-cli text2token`。上游那个工具是 C++/Python 的，
 * 前端拿不到，所以这里自己实现：
 *   汉字 run  → ppinyin（./ppinyin.ts）
 *   英文字母 run → CMU 发音词典（./lexicon.ts）
 * 生成的每个音素都要在模型的 tokens.txt 里出现过，否则 sherpa-onnx 侧
 * 会在 EncodeKeywords 里报 "Cannot find ID for token" 并返回空 stream
 * —— 那种失败在 UI 上完全无声，所以这里提前拦下来。
 *
 * 输出行格式与上游一致：
 *   x iǎo ài t óng x ué @小爱同学 :2.0 #0.6
 * `:` 与 `#` 必须紧贴数值，`@` 后的显示文本不能含空格和 `/`。
 */

import { hanziToSyllables, isHan, syllableToPhones } from './ppinyin';
import { wordToPhones, type Lexicon } from './lexicon';

export interface TokenizeContext {
  /** 模型 tokens.txt 里的全部音素 */
  tokens: Set<string>;
  /** 模型没有英文词典时为 null */
  lexicon: Lexicon | null;
}

export type TokenizeIssueKind =
  | 'no-lexicon'
  | 'oov-word'
  | 'unknown-char'
  | 'bad-phone';

export interface TokenizeIssue {
  kind: TokenizeIssueKind;
  /** 出问题的原文片段 */
  fragment: string;
  message: string;
}

export interface TokenizeResult {
  ok: boolean;
  /** 音素序列，如 ['x','iǎo','ài','t','óng','x','ué'] */
  phones: string[];
  issues: TokenizeIssue[];
}

/** 显示文本要能安全地塞进 `@...`：空格和 `/` 都会破坏格式 */
export function sanitizeDisplay(text: string): string {
  return text.trim().replace(/[\s/]+/g, '_');
}

function isLatinLetter(ch: string): boolean {
  return ch === "'" || /[A-Za-z]/.test(ch);
}

export function tokenize(text: string, ctx: TokenizeContext): TokenizeResult {
  const phones: string[] = [];
  const issues: TokenizeIssue[] = [];

  let hanBuf = '';
  let wordBuf = '';

  const flushHan = () => {
    if (!hanBuf) return;
    for (const syl of hanziToSyllables(hanBuf)) {
      phones.push(...syllableToPhones(syl));
    }
    hanBuf = '';
  };

  const flushWord = () => {
    if (!wordBuf) return;
    const word = wordBuf;
    wordBuf = '';
    if (!ctx.lexicon) {
      issues.push({
        kind: 'no-lexicon',
        fragment: word,
        message: `当前模型没有英文发音词典，无法处理“${word}”。请切换到「中文 + 英文」模型。`,
      });
      return;
    }
    const found = wordToPhones(word, ctx.lexicon);
    if (!found) {
      issues.push({
        kind: 'oov-word',
        fragment: word,
        message: `英文词典里没有“${word}”。换个词，或直接改用录音造词。`,
      });
      return;
    }
    phones.push(...found);
  };

  const flush = () => {
    flushHan();
    flushWord();
  };

  for (const ch of text) {
    if (isHan(ch)) {
      flushWord();
      hanBuf += ch;
    } else if (isLatinLetter(ch)) {
      flushHan();
      wordBuf += ch;
    } else if (/[\s_\-·,，、。.!！?？]/u.test(ch)) {
      // 分隔符：结束当前 run，丢掉
      flush();
    } else {
      flush();
      issues.push({
        kind: 'unknown-char',
        fragment: ch,
        message: `不认识“${ch}”：只支持汉字和英文字母，数字与标点请改用录音造词。`,
      });
    }
  }
  flush();

  // 白名单校验：不在 tokens.txt 里的音素必然会让 sherpa-onnx 静默失败
  const seenBad = new Set<string>();
  for (const p of phones) {
    if (!ctx.tokens.has(p) && !seenBad.has(p)) {
      seenBad.add(p);
      issues.push({
        kind: 'bad-phone',
        fragment: p,
        message: `音素“${p}”不在当前模型的 tokens.txt 里，八成是生僻字或多音字。`,
      });
    }
  }

  if (phones.length === 0 && issues.length === 0) {
    issues.push({
      kind: 'unknown-char',
      fragment: text,
      message: '没解析出任何音素，词条是空的？',
    });
  }

  return { ok: issues.length === 0, phones, issues };
}

export interface KeywordOptions {
  /** 增强分数，越大越容易触发。留空用模型默认值 */
  boost?: number;
  /** 触发阈值（0~1），越小越容易触发。留空用模型默认值 */
  threshold?: number;
}

/** 生成一行关键词，即 keywords.txt 里的一行 */
export function buildKeywordLine(
  text: string,
  phones: string[],
  opts: KeywordOptions = {},
): string {
  const parts = [...phones, `@${sanitizeDisplay(text)}`];
  if (opts.boost != null) parts.push(`:${opts.boost}`);
  if (opts.threshold != null) parts.push(`#${opts.threshold}`);
  return parts.join(' ');
}

/**
 * 拼成 `SherpaOnnxCreateKeywordStreamWithKeywords` 要的串。
 * C++ 侧把 `/` 替换成换行再逐行解析，所以斜杠是硬分隔符。
 */
export function buildKeywordsPayload(lines: string[]): string {
  return lines.join('/');
}

/** 读模型 tokens.txt，得到音素白名单 */
export function parseTokens(text: string): Set<string> {
  const set = new Set<string>();
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const sym = t.split(/\s+/)[0];
    if (sym) set.add(sym);
  }
  return set;
}

export interface ParsedKeywordLine {
  phones: string[];
  display: string;
  boost?: number;
  threshold?: number;
}

/**
 * 拆一行 keywords.txt。`:`, `#`, `@` 开头的 token 是附加信息，
 * 剩下的才是音素——与上游 EncodeBase 的判定顺序一致。
 */
export function parseKeywordLine(line: string): ParsedKeywordLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const phones: string[] = [];
  let display = '';
  let boost: number | undefined;
  let threshold: number | undefined;

  for (const tok of trimmed.split(/\s+/)) {
    if (!tok) continue;
    switch (tok[0]) {
      case ':':
        boost = Number.parseFloat(tok.slice(1));
        break;
      case '#':
        threshold = Number.parseFloat(tok.slice(1));
        break;
      case '@':
        display = tok.slice(1);
        break;
      default:
        phones.push(tok);
    }
  }
  if (phones.length === 0) return null;
  return { phones, display, boost, threshold };
}
