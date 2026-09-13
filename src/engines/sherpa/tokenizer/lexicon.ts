/**
 * 英文 → 音素，走模型自带的 CMU 发音词典。
 *
 * zh-en 模型的 `en.phone` 就是一份 CMUdict：
 *   LIGHT  L AY1 T
 *   UP     AH1 P
 * 上游 text2token 用 --tokens-type phone+ppinyin + --lexicon en.phone 查它。
 * 这里浏览器内做同一件事：单词大写化后查表。
 */

/** WORD -> "P H O N E S" 的音素串（已按空格拆开存数组） */
export type Lexicon = Map<string, string[]>;

export function parseLexicon(text: string): Lexicon {
  const lex: Lexicon = new Map();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';;;')) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const word = line.slice(0, sp);
    const phones = line.slice(sp + 1).trim().split(/\s+/);
    if (phones.length === 0 || phones[0] === '') continue;
    lex.set(word.toUpperCase(), phones);
  }
  return lex;
}

/** 只保留英文字母和撇号，其余（连字符、标点）当分隔符 */
export function normalizeWord(word: string): string {
  return word.toUpperCase().replace(/[^A-Z']/g, '');
}

export function wordToPhones(word: string, lex: Lexicon): string[] | null {
  const key = normalizeWord(word);
  if (!key) return null;
  return lex.get(key) ?? null;
}
