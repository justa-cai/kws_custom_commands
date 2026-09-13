/**
 * 模型描述符。
 *
 * 一个模型 = 一组 onnx 权重 + tokens.txt（+ 可选的英文发音词典）。
 * 新增语言/模型的成本应该只有「往 public/models/ 放文件 + 在下面加一条」，
 * 任何地方都不应该出现 if (modelId === '...')。
 */

export interface ModelFiles {
  encoder: string;
  decoder: string;
  joiner: string;
  /** 音素表，同时也是分词时的合法性白名单 */
  tokens: string;
  /** CMU 发音词典（上游叫 en.phone）。没有它就只支持中文 */
  lexicon?: string;
}

export interface GoldenCase {
  label: string;
  /** 相对模型目录的文件名，内容同上游 text2token 的输入格式 */
  file: string;
  /** 该黄金样本里的语种，仅用于展示 */
  kind: 'zh' | 'en' | 'mixed';
}

export interface ModelDescriptor {
  id: string;
  label: string;
  /** 一句话说明，展示在模型选择器下方 */
  summary: string;
  /** public/ 下的目录，末尾不带斜杠 */
  dir: string;
  files: ModelFiles;
  /** 该模型能识别的语言，用于 UI 提示 */
  languages: string[];
  goldens: GoldenCase[];
  /** public/ 下的示例音频，供「上传音频」一键试听/回归 */
  sampleWavs: string[];
  license: string;
  upstream: string;
}

export const MODELS: ModelDescriptor[] = [
  {
    id: 'zh-en',
    label: '中文 + 英文',
    summary: '中英混合，同一个词条里可以既有汉字又有英文单词。默认用这个。',
    dir: 'models/zh-en',
    files: {
      encoder: 'encoder.onnx',
      decoder: 'decoder.onnx',
      joiner: 'joiner.onnx',
      tokens: 'tokens.txt',
      lexicon: 'en.phone',
    },
    languages: ['中文', '英文'],
    goldens: [
      { label: '中英混合关键词', file: 'golden-keywords.txt', kind: 'mixed' },
    ],
    sampleWavs: [
      'samples/zh_0.wav',
      'samples/zh_1.wav',
      'samples/zh_2.wav',
      'samples/zh_3.wav',
      'samples/zh_4.wav',
      'samples/zh_5.wav',
      'samples/zh_6.wav',
      'samples/en_0.wav',
      'samples/en_1.wav',
    ],
    license: 'Apache-2.0',
    upstream:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2',
  },
  {
    id: 'zh',
    label: '中文',
    summary: '纯中文，模型更小。英文词条在这个模型下会报错——它没有英文发音词典。',
    dir: 'models/zh',
    files: {
      encoder: 'encoder.onnx',
      decoder: 'decoder.onnx',
      joiner: 'joiner.onnx',
      tokens: 'tokens.txt',
    },
    languages: ['中文'],
    goldens: [
      { label: '常见唤醒词', file: 'golden-keywords.txt', kind: 'zh' },
      { label: '易混词', file: 'golden-test-keywords.txt', kind: 'zh' },
    ],
    sampleWavs: [
      'samples/zh_0.wav',
      'samples/zh_1.wav',
      'samples/zh_2.wav',
      'samples/zh_3.wav',
      'samples/zh_4.wav',
      'samples/zh_5.wav',
      'samples/zh_6.wav',
    ],
    license: 'Apache-2.0',
    upstream:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2',
  },
];

export const DEFAULT_MODEL_ID = 'zh-en';

export function getModel(id: string): ModelDescriptor {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error(`未知模型: ${id}`);
  return m;
}
