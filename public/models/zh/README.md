# 模型：中文（zh）

## 来源

| | |
|---|---|
| 上游 | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) |
| 模型名 | `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` |
| 下载 | <https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2> |
| 许可 | **Apache License 2.0**，版权归上游作者所有 |
| 语言 | 仅中文（训练数据是 WenetSpeech L 子集，约 10000 小时） |

## 本目录的文件

| 本目录 | 上游原文件名 |
|---|---|
| `encoder.onnx` | `encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx` |
| `decoder.onnx` | `decoder-epoch-12-avg-2-chunk-16-left-64.onnx` |
| `joiner.onnx` | `joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx` |
| `tokens.txt` | `tokens.txt` |

**没有 `en.phone`。** 所以这个模型不支持英文词条——页面上输入英文会明确报错，
而不是静默失效。要中英混合请切到 `zh-en` 模型。

## 自检素材

| 文件 | 用途 |
|---|---|
| `golden-keywords.txt` | 常见唤醒词（你好军哥 / 蛋哥蛋哥 / 小爱同学 …），自检用（8/8） |
| `golden-test-keywords.txt` | 上游的易混词集（文森特卡索 / 周望军 …），自检用（8/8） |
| `golden-keywords-raw.txt` | 上面那批词条的原始文本 |

## 分词方式

和 `zh-en` 的中文部分完全一致（`--tokens-type ppinyin`），走同一份
`src/engines/sherpa/tokenizer/ppinyin.ts`。
