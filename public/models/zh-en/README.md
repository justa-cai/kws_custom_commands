# 模型：中文 + 英文（zh-en）

## 来源

| | |
|---|---|
| 上游 | [k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) |
| 模型名 | `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` |
| 下载 | <https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2> |
| 许可 | **Apache License 2.0**，版权归上游作者所有 |
| 语言 | 中文 + 英文（可在同一个词条里混用） |

## 本目录的文件

上游的原始文件名带了 epoch / chunk 信息，这里统一改名成 `encoder.onnx` 这种，
原始名对照：

| 本目录 | 上游原文件名 |
|---|---|
| `encoder.onnx` | `encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx` |
| `decoder.onnx` | `decoder-epoch-13-avg-2-chunk-16-left-64.onnx` |
| `joiner.onnx` | `joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx` |
| `tokens.txt` | `tokens.txt` |
| `en.phone` | `en.phone` |

用了 **int8** 量化的 encoder / joiner 把体积从 13 MB 压到 4.6 MB。decoder 保持 fp32——
上游模型卡里明确写了 "decoder does not benefit much from quantization"，
而且它本来就只有 740 KB。

`chunk-16` 这一档的延迟是 320 ms（`chunk-8` 是 160 ms，但模型更大）。直播唤醒场景
够用，也对 CPU 更友好。

## 自检素材

| 文件 | 用途 |
|---|---|
| `golden-keywords.txt` | 上游 `text2token` 的产物，页面上的「跑一遍分词器自检」拿它逐音素比对（10/10） |
| `golden-keywords-raw.txt` | 上面那批词条的原始文本，便于阅读 |
| `sample-transcripts.txt` | `samples/en_*.wav` 的英文转写，用来确认该去哪段音频里找唤醒词 |

`../samples/zh_*.wav` 和 `../samples/en_*.wav` 也是这个模型自带的 `test_wavs`。

## 分词方式

`--tokens-type ppinyin` + 英文走 CMU 词典：

```
小爱同学          →  x iǎo ài t óng x ué
LIGHT UP          →  L AY1 T AH1 P
```

中文的「声母 + 带调韵母」切分规则和拼音正字法（`j/q/x/y` 后的 ü 写作 u）
见 `src/engines/sherpa/tokenizer/ppinyin.ts`。
