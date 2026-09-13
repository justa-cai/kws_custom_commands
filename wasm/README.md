# WASM 构建说明

编译 sherpa-onnx 的**单线程** WebAssembly KWS，产物放到 `public/wasm/`。

```bash
npm run wasm:build            # 增量
CLEAN=1 npm run wasm:build    # 从零重建（删掉源码目录与 emsdk 的 upstream）
```

产物（`public/wasm/`，不入库）：

| 文件 | 大小 | 说明 |
|---|---|---|
| `sherpa-onnx-wasm-kws-main.wasm` | ~13 MB | 单线程，不含任何模型权重 |
| `sherpa-onnx-wasm-kws-main.js` | ~75 KB | emscripten 胶水，暴露全局 `createSherpaKws`（`-sMODULARIZE`，**不是** ES module） |
| `upstream-sherpa-onnx-kws.js` | — | 上游的 glue 副本，只作参考——`src/engines/sherpa/KwsEngine.ts` 是按它的结构体布局写的 |

## 版本锁定

| 组件 | 版本 | 说明 |
|---|---|---|
| sherpa-onnx | `v1.13.8` | 改这里要同步改 `.github/workflows/build-wasm.yml` 的 `SHERPA_ONNX_VERSION`，以及下面这笔补丁 |
| emsdk | `4.0.23` | 上游 `build-wasm-simd-kws.sh` 里标注 "known to work" 的版本 |
| onnxruntime wasm | 由上游 cmake 自己拉（v1.28.2） | 见 `cmake/onnxruntime-wasm-simd.cmake` |

## 改了什么（`kws-wasm.patch`）

对上游 `wasm/kws/CMakeLists.txt` 打了四处补丁，全都有明确理由：

1. **去掉 `assets/` 的存在性检查** —— 我们要在运行时加载模型，不在配置期要求模型就位。
2. **去掉 `--preload-file assets@.`** —— 这是关键。上游把模型烤进 `.data` 文件，一份 wasm 只能服务一个模型。改成运行时 `fetch` 写进 MEMFS 之后，一份 wasm 能切换中文 / 英文 / 中英混合模型，页面也不必在首屏就吞下 30 MB。
3. **多导出两个符号** —— `SherpaOnnxCreateKeywordStreamWithKeywords`（改词表只重建 stream，不重载 ONNX）和 `SherpaOnnxDecodeMultipleKeywordStreams`。这两个 C API 上游本来就有，只是没进 wasm 的导出列表。
4. **`-sMODULARIZE=1 -sEXPORT_NAME=createSherpaKws -sENVIRONMENT=web`，并把 `FS` 加进 `EXPORTED_RUNTIME_METHODS`** —— 前者让胶水暴露成一个工厂函数而不是全局 `Module`；后者是运行时写模型文件到 MEMFS 必需的。

另外把 `INITIAL_MEMORY` 从 512 MB 降到 64 MB（保留 `ALLOW_MEMORY_GROWTH=1`）：512 MB 是启动就一次性分配的，手机上很容易直接分配失败。

## 关于单线程

这个构建**没有 pthread，也不用 `SharedArrayBuffer`**，所以不需要 `COOP`/`COEP` 响应头，可以直接跑在 GitHub Pages 上。

这不是我们改出来的——上游 `wasm/kws/CMakeLists.txt`、`build-wasm-simd-kws.sh`、`wasm/wasm-common.cmake`、`cmake/onnxruntime-wasm-simd.cmake` 全链路本来就没有 `-pthread`。网上流传的"必须自己删 `-pthread`"是针对别的构建目标（比如 ASR）的过时说法。

想自己验证：

```bash
grep -c "pthread\|SharedArrayBuffer" public/wasm/sherpa-onnx-wasm-kws-main.js   # 应该是 0
ls public/wasm/*.worker.js                                                       # 应该不存在
```

## 踩过的坑

- **`keywords_file` 在 WASM 构建下是"内容"不是"路径"。** `keyword-spotter-transducer-impl.h` 里 `#ifdef SHERPA_ONNX_ENABLE_WASM_KWS` 那一支把 `config_.keywords_file` 直接当字符串解析。所以传路径进去会被当成一堆乱码词条。
- **`KeywordSpotterConfig::Validate()` 不允许词表为空**，但 `CreateStream(keywords)` 又是把传入词条 **append** 到 spotter 自带词表后面。想"每路 stream 用自己的词表"就必须让 spotter 自带表非空又永不触发 —— 见 `KwsEngine.ts` 里的 `buildSentinelKeyword`（用 `<unk>` + `#1.0` 双重失效）。
- **字符串池要活到 `SherpaOnnxCreateKeywordSpotter` 返回之后再释放。** 结构体里存的是池内指针，提前 `_free` 是悬垂指针，wasm 里不会立刻崩，只会读到垃圾路径然后报一个莫名其妙的错。
