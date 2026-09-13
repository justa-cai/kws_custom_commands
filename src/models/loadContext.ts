/**
 * 把模型的"文字材料"（tokens.txt + 可选的英文发音词典）拉下来，
 * 组装成分词器要的上下文。
 *
 * 这两个文件不大（tokens 2 KB、en.phone 3 MB），但决定了"哪些字能造词"，
 * 所以模型一切换就必须重新读——热词表是照着旧的 tokens 造的，换模型后
 * 音素可能根本不存在了。
 */

import { assetUrl } from '../audio/constants';
import { parseLexicon, type Lexicon } from '../engines/sherpa/tokenizer/lexicon';
import { parseTokens, type TokenizeContext } from '../engines/sherpa/tokenizer';
import type { ModelDescriptor } from './descriptors';

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 ${url} 失败: HTTP ${res.status}`);
  return res.text();
}

export async function loadTokenizeContext(model: ModelDescriptor): Promise<TokenizeContext> {
  const base = assetUrl(model.dir);
  const [tokensText, lexiconText] = await Promise.all([
    fetchText(`${base}/${model.files.tokens}`),
    model.files.lexicon
      ? fetchText(`${base}/${model.files.lexicon}`)
      : Promise.resolve<string | null>(null),
  ]);

  const lexicon: Lexicon | null = lexiconText ? parseLexicon(lexiconText) : null;
  return { tokens: parseTokens(tokensText), lexicon };
}
