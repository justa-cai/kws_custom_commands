/**
 * 分词器自检。
 *
 * 把模型自带的 keywords.txt / golden-*.txt 当黄金样本——那批文件是上游
 * `sherpa-onnx-cli text2token` 生成的，等于拿官方工具当 oracle，逐音素比对。
 * 任何一次改分词规则（换 pinyin-pro 版本、调正字法、改切 run 的逻辑）都能
 * 立刻在页面上看到有没有把中文 16/16、英文 2/2 跑挂了。
 *
 * 之所以做成页面里的一个按钮而不是单测文件：这个自检要在部署好的
 * GitHub Pages 上、用真实加载的模型跑一遍，那才是它有价值的地方。
 */

import {
  parseTokens,
  tokenize,
  parseKeywordLine,
  type TokenizeIssue,
} from '../engines/sherpa/tokenizer';
import { parseLexicon, type Lexicon } from '../engines/sherpa/tokenizer/lexicon';
import type { ModelDescriptor } from '../models/descriptors';

export interface SelfTestIO {
  /** 读模型目录下的相对路径，如 'tokens.txt' */
  readText(path: string): Promise<string>;
}

export interface GoldenFailure {
  display: string;
  expected: string;
  actual: string;
  issues: TokenizeIssue[];
}

export interface GoldenCaseOutcome {
  label: string;
  kind: 'zh' | 'en' | 'mixed';
  total: number;
  passed: number;
  failures: GoldenFailure[];
}

export interface GoldenReport {
  modelId: string;
  modelLabel: string;
  cases: GoldenCaseOutcome[];
  total: number;
  passed: number;
  ok: boolean;
  /** 加载 tokens/词典时的致命错误，非空则 cases 为空 */
  fatal?: string;
}

export async function runGoldenSelfTest(
  model: ModelDescriptor,
  io: SelfTestIO,
): Promise<GoldenReport> {
  let tokens: Set<string>;
  let lexicon: Lexicon | null = null;
  try {
    tokens = parseTokens(await io.readText(model.files.tokens));
    if (model.files.lexicon) {
      lexicon = parseLexicon(await io.readText(model.files.lexicon));
    }
  } catch (e) {
    return {
      modelId: model.id,
      modelLabel: model.label,
      cases: [],
      total: 0,
      passed: 0,
      ok: false,
      fatal: `加载材料失败: ${(e as Error).message}`,
    };
  }

  const cases: GoldenCaseOutcome[] = [];
  for (const golden of model.goldens) {
    const outcome: GoldenCaseOutcome = {
      label: golden.label,
      kind: golden.kind,
      total: 0,
      passed: 0,
      failures: [],
    };
    try {
      const text = await io.readText(golden.file);
      for (const line of text.split('\n')) {
        const expected = parseKeywordLine(line);
        if (!expected) continue;
        outcome.total += 1;
        // 黄金样本里的显示文本用下划线代替空格（@LIGHT_UP），
        // 分词器把下划线当分隔符，所以直接喂回去就行。
        const actual = tokenize(expected.display, { tokens, lexicon });
        const same =
          actual.ok &&
          actual.phones.length === expected.phones.length &&
          actual.phones.every((p, i) => p === expected.phones[i]);
        if (same) {
          outcome.passed += 1;
        } else {
          outcome.failures.push({
            display: expected.display,
            expected: expected.phones.join(' '),
            actual: actual.phones.join(' '),
            issues: actual.issues,
          });
        }
      }
    } catch (e) {
      outcome.failures.push({
        display: `(读取 ${golden.file} 失败)`,
        expected: '',
        actual: '',
        issues: [
          { kind: 'unknown-char', fragment: golden.file, message: (e as Error).message },
        ],
      });
    }
    cases.push(outcome);
  }

  const total = cases.reduce((n, c) => n + c.total, 0);
  const passed = cases.reduce((n, c) => n + c.passed, 0);
  return {
    modelId: model.id,
    modelLabel: model.label,
    cases,
    total,
    passed,
    ok: total > 0 && passed === total,
  };
}
