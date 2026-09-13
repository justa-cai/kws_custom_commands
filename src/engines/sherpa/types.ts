/**
 * sherpa-onnx WASM 模块的类型面。
 *
 * wasm 那侧是用 emscripten 编出来的（见 wasm/build.sh），导出的运行时方法
 * 在 CMakeLists 的 EXPORTED_RUNTIME_METHODS 里写死了，这里按那份清单声明。
 * 指针运算部分是 C 结构体的字节布局，改动前先回去看
 * `wasm/kws-wasm.patch` 和上游 wasm/kws/sherpa-onnx-kws.js。
 */

/** emscripten 的 MEMFS。只用到写文件和建目录 */
export interface EmscriptenFS {
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  mkdirTree(path: string): void;
  unlink(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

export interface SherpaModule {
  // ---- emscripten 运行时 ----
  _malloc(size: number): number;
  _free(ptr: number): void;
  _CopyHeap(src: number, len: number, dst: number): void;
  lengthBytesUTF8(s: string): number;
  stringToUTF8(s: string, ptr: number, maxBytes: number): void;
  UTF8ToString(ptr: number): string;
  setValue(ptr: number, value: number, type: string): void;
  getValue(ptr: number, type: string): number;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  FS: EmscriptenFS;

  // ---- 关键词检测 C API（见 wasm/kws-wasm.patch 的 exported_functions）----
  _SherpaOnnxCreateKeywordSpotter(configPtr: number): number;
  _SherpaOnnxDestroyKeywordSpotter(spotter: number): void;
  _SherpaOnnxCreateKeywordStream(spotter: number): number;
  _SherpaOnnxCreateKeywordStreamWithKeywords(spotter: number, keywordsPtr: number): number;
  _SherpaOnnxIsKeywordStreamReady(spotter: number, stream: number): number;
  _SherpaOnnxDecodeKeywordStream(spotter: number, stream: number): void;
  _SherpaOnnxResetKeywordStream(spotter: number, stream: number): void;
  _SherpaOnnxGetKeywordResult(spotter: number, stream: number): number;
  _SherpaOnnxDestroyKeywordResult(result: number): void;
  _SherpaOnnxDestroyOnlineStream(stream: number): void;
  _SherpaOnnxOnlineStreamAcceptWaveform(
    stream: number,
    sampleRate: number,
    samplesPtr: number,
    numSamples: number,
  ): void;
  _SherpaOnnxOnlineStreamInputFinished(stream: number): void;
}

export type SherpaModuleFactory = (options?: {
  locateFile?: (path: string, prefix: string) => string;
  print?: (text: string) => void;
  printErr?: (text: string) => void;
}) => Promise<SherpaModule>;

declare global {
  interface Window {
    createSherpaKws?: SherpaModuleFactory;
  }
}

/** `SherpaOnnxGetKeywordResult` 返回的 JSON */
export interface SherpaKeywordResultJson {
  keyword?: string;
  tokens?: string[];
  timestamps?: number[];
  start_time?: number;
}
