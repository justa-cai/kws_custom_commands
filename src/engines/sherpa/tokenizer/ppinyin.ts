/**
 * 中文 → 音素（sherpa-onnx 的 ppinyin 建模单元）。
 *
 * 上游 `sherpa-onnx-cli text2token --tokens-type ppinyin` 把每个汉字拆成
 * 「声母 + 带调韵母」，例如 小爱同学 → `x iǎo ài t óng x ué`。
 * 浏览器里没有那个 C++ 工具，这里用 pinyin-pro 复刻同一套规则。
 *
 * 唯一需要特别处理的坑是拼音正字法：j/q/x/y 后的 ü 写作 u
 * （军 jūn 而不是 jǖn、学 xué 而不是 xüé），n/l 后保留 ü（女 nǚ、绿 lǜ）。
 * 少了这条，模型自带的官方样本只能过 13/16。
 *
 * 正确性由 `src/selftest` 拿模型自带的 golden-keywords.txt 逐字节比对兜底
 * —— 那批文件是官方 text2token 生成的，等于把上游工具当成了 oracle。
 */

import { pinyin } from 'pinyin-pro';

/** ü 及其带调形式 → u 及其带调形式 */
const UMLAUT_TO_PLAIN: Record<string, string> = {
  ü: 'u',
  ǖ: 'ū',
  ǘ: 'ú',
  ǚ: 'ǔ',
  ǜ: 'ù',
};

/** 这些声母后面的 ü 要按正字法写成 u */
const UMLAUT_STRIPPING_INITIALS = new Set(['j', 'q', 'x', 'y']);

export interface Syllable {
  /** 声母。零声母音节（爱、儿、安…）为空串 */
  initial: string;
  /** 带调韵母，如 iǎo / ué / ǚ */
  final: string;
  /** 原字，仅用于报错时指认 */
  char: string;
}

const HAN_RE = /^\p{Script=Han}$/u;

export function isHan(ch: string): boolean {
  return HAN_RE.test(ch);
}

function stripUmlaut(initial: string, final: string): string {
  if (!UMLAUT_STRIPPING_INITIALS.has(initial)) return final;
  return [...final].map((c) => UMLAUT_TO_PLAIN[c] ?? c).join('');
}

/**
 * 把一串纯汉字切成音节。传入的字符串里必须全是汉字，
 * 混排文本请先按 run 切分（见 ./index.ts）。
 */
export function hanziToSyllables(han: string): Syllable[] {
  const chars = [...han];
  if (chars.length === 0) return [];

  const initials = pinyin(han, {
    pattern: 'initial',
    toneType: 'none',
    type: 'array',
  }) as string[];
  const finals = pinyin(han, {
    pattern: 'final',
    toneType: 'symbol',
    type: 'array',
  }) as string[];

  // pinyin-pro 对多音字会按上下文消歧，正常情况下逐字对齐。
  // 万一它给出了长度不符的结果，宁可显式报错也不要静默错位。
  if (initials.length !== chars.length || finals.length !== chars.length) {
    throw new Error(
      `pinyin-pro 返回长度与字符数不符: ${chars.length} 字 → ` +
        `${initials.length} 声母 / ${finals.length} 韵母`,
    );
  }

  return chars.map((char, i) => {
    const initial = initials[i] ?? '';
    return {
      char,
      initial,
      final: stripUmlaut(initial, finals[i] ?? ''),
    };
  });
}

/** 音节的音素展开：有声母就 [声母, 韵母]，零声母就只有 [韵母] */
export function syllableToPhones(s: Syllable): string[] {
  return s.initial ? [s.initial, s.final] : [s.final];
}
