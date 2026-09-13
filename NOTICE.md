# 第三方内容说明

本仓库的**代码**采用 MIT 许可（见 `LICENSE`）。仓库里还包含以下第三方内容，
它们各自适用不同的许可，版权归各自作者所有。

## 语音模型（Apache License 2.0）

`public/models/` 下的 ONNX 权重、`tokens.txt`、`en.phone` 来自
[k2-fsa/sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 的关键词检测（KWS）
预训练模型发布，采用 **Apache License 2.0**。

| 目录 | 上游模型 | 下载地址 |
|---|---|---|
| `public/models/zh-en/` | `sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20` | <https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2> |
| `public/models/zh/` | `sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01` | <https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01.tar.bz2> |

各目录下的 `README.md` 记录了精确的文件名对照（我们做了改名和 int8 取舍）。

Apache License 2.0 全文：<https://www.apache.org/licenses/LICENSE-2.0>

## 测试音频与黄金样本

`public/samples/*.wav`（模型自带的 `test_wavs`）与 `public/models/*/golden-*.txt`
（上游 `sherpa-onnx-cli text2token` 的输出）同样是上述模型发布的一部分，
适用同一许可。它们在这里的用途是：让页面上的「跑一遍分词器自检」有一个
官方 oracle 可比，以及让没有麦克风的环境也能验证整条链路。

## 运行时依赖

- [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)（Apache-2.0）—— 编译进 `public/wasm/`
- [ONNX Runtime](https://github.com/microsoft/onnxruntime)（MIT）—— 由上游构建脚本拉取
- [Emscripten](https://emscripten.org/)（MIT / University of Illinois）—— WASM 工具链
- [pinyin-pro](https://github.com/zh-lx/pinyin-pro)（MIT）—— 浏览器端汉字转拼音

`public/wasm/` 下的产物**不在本仓库里**，由 `wasm/build.sh` 或 CI 编译生成。
