/**
 * sherpa-onnx 关键词检测引擎的封装。
 *
 * 上游 `wasm/kws/sherpa-onnx-kws.js` 把 C 结构体一个字段一个字段地按字节
 * 拼出来，这里照抄同一套布局（只是加了类型和名字）。之所以不直接用上游那份：
 *   1. 它假设模型已经 `--preload-file` 进 wasm 了，而我们要运行时下载模型；
 *   2. 它没有暴露 `...WithKeywords`，而那是"改词表不重载模型"的关键；
 *   3. 它挂在全局上，没有释放路径，换模型就漏内存。
 *
 * 做法上有两个刻意的选择：
 *
 * - **spotter 用空词表创建**。翻 `keyword-spotter-transducer-impl.h` 可以看到
 *   `CreateStream(keywords)` 会自己从传入串建 ContextGraph，并把 spotter 自带的
 *   词表 append 上去；空词表 → 就是"这个 stream 只用我给的词"。
 *   于是改词表 = 建个新 stream，模型一个字节都不用重读。
 * - **模型写进 MEMFS 而不是预加载**。一份 wasm 于是能服务中/英/中英各种模型，
 *   换模型和换语言不需要重新编译。
 */

import { TARGET_SAMPLE_RATE, assetUrl } from '../../audio/constants';
import type { ModelDescriptor } from '../../models/descriptors';
import { loadSherpaWasm } from './loadSherpa';
import type { SherpaKeywordResultJson, SherpaModule } from './types';

const PTR = 4; // wasm32

/**
 * 造一个"永远不可能触发"的哨兵词条。
 *
 * 为什么需要它：`KeywordSpotterConfig::Validate()` 里写死了
 * 「keywords_file 和 keywords_buf 不能都为空」，空词表建不出 spotter。
 * 但我们又不想让 spotter 自带任何真实词条——因为 `CreateStream(keywords)`
 * 是**把传入的词条 append 到 spotter 自带词表后面**，自带表非空的话
 * 每个 stream 都会捎带上一批不想要的词。
 *
 * 所以塞一条双重失效的哨兵进去：
 *   1. 音素用 `<unk>`——解码器里 unk 被当成 blank 跳过，context graph 永远
 *      推进不到终态（见 transducer-keyword-decoder.cc 的 `new_token != unk_id_`）；
 *   2. 阈值给 `#1.0`——触发要求「平均声学概率 ≥ 1.0」，softmax 概率不可能到 1。
 * 两条都是硬保证，不是"大概不会触发"。
 */
function buildSentinelKeyword(tokensPath: string, mod: SherpaModule): string {
  let token = '<unk>';
  try {
    const text = new TextDecoder().decode(mod.FS.readFile(tokensPath));
    const symbols = text
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((s): s is string => !!s);
    if (!symbols.includes('<unk>')) {
      // 这个模型没有 unk 符号，退而求其次用表尾最罕见的一个音素，仍靠阈值兜底
      token = symbols[symbols.length - 1] ?? '<unk>';
    }
  } catch {
    // 读不到就用 <unk>，第 2 条保证仍然生效
  }
  return `${token} @__kws_sentinel :0 #1.0`;
}

// ---- SherpaOnnxOnlineModelConfig 的字节布局（务必与 c-api.h 一致）----
const TRANSDUCER_LEN = 3 * PTR; // encoder / decoder / joiner
const PARAFORMER_LEN = 2 * PTR; // 不用，占位
const ZIPFORMER2_CTC_LEN = PTR; // 不用，占位
const TAIL_FIELDS_LEN = 9 * PTR; // tokens, num_threads, provider, debug,
//                                  model_type, modeling_unit, bpe_vocab,
//                                  tokens_buf, tokens_buf_size
const NEMO_CTC_LEN = PTR;
const TONE_CTC_LEN = PTR;
const MODEL_CONFIG_LEN =
  TRANSDUCER_LEN + PARAFORMER_LEN + ZIPFORMER2_CTC_LEN + TAIL_FIELDS_LEN + NEMO_CTC_LEN + TONE_CTC_LEN;

const MODEL_CONFIG_OFFSET_TOKENS = TRANSDUCER_LEN + PARAFORMER_LEN + ZIPFORMER2_CTC_LEN; // 24

// ---- SherpaOnnxKeywordSpotterConfig ----
const FEAT_CONFIG_LEN = 2 * PTR; // sample_rate / feature_dim
const KWS_TAIL_LEN = 7 * PTR; // max_active_paths, num_trailing_blanks,
//                               keywords_score, keywords_threshold,
//                               keywords_file, keywords_buf, keywords_buf_size

// ---- SherpaOnnxKeywordResult 里 json 字段的字节偏移 ----
// keyword / tokens / tokens_arr / count / timestamps / start_time / json
const RESULT_JSON_OFFSET = 24;

const KWS_CONFIG_LEN = FEAT_CONFIG_LEN + MODEL_CONFIG_LEN + KWS_TAIL_LEN;

export interface KwsHit {
  /** 词条的显示文本（我们写进 `@...` 的那部分） */
  keyword: string;
  tokens: string[];
  timestamps: number[];
  /** 命中片段相对 stream 起点的时间，秒 */
  startTime: number;
}

export interface ModelLoadProgress {
  file: string;
  fileIndex: number;
  fileCount: number;
  loaded: number;
  /** 服务端没给 content-length 时为 0 */
  total: number;
}

export interface KwsEngineOptions {
  onLog?: (line: string) => void;
  onProgress?: (p: ModelLoadProgress) => void;
}

/** 挂一个 stream；一个 stream 持有一份独立的词表 */
export class KwsStream {
  private samplesPtr = 0;
  private samplesCap = 0;

  constructor(
    private readonly mod: SherpaModule,
    private readonly spotter: number,
    private handle: number,
  ) {}

  get alive(): boolean {
    return this.handle !== 0;
  }

  /** 喂一块 16 kHz 单声道音频，返回这次喂进去触发出来的词（通常 0 或 1 个） */
  feed(chunk: Float32Array): KwsHit[] {
    if (!this.handle) return [];
    this.acceptWaveform(chunk);

    const hits: KwsHit[] = [];
    while (this.mod._SherpaOnnxIsKeywordStreamReady(this.spotter, this.handle) === 1) {
      this.mod._SherpaOnnxDecodeKeywordStream(this.spotter, this.handle);
      const hit = this.readResult();
      if (hit) {
        hits.push(hit);
        // 上游 demo 同样在命中后立刻 reset：清掉解码状态，
        // 否则同一个词会连着触发好几帧
        this.mod._SherpaOnnxResetKeywordStream(this.spotter, this.handle);
      }
    }
    return hits;
  }

  /** 丢掉当前解码状态，但保留词表 */
  reset(): void {
    if (this.handle) this.mod._SherpaOnnxResetKeywordStream(this.spotter, this.handle);
  }

  dispose(): void {
    if (this.samplesPtr) {
      this.mod._free(this.samplesPtr);
      this.samplesPtr = 0;
      this.samplesCap = 0;
    }
    if (this.handle) {
      this.mod._SherpaOnnxDestroyOnlineStream(this.handle);
      this.handle = 0;
    }
  }

  private acceptWaveform(samples: Float32Array): void {
    if (this.samplesCap < samples.length) {
      if (this.samplesPtr) this.mod._free(this.samplesPtr);
      this.samplesPtr = this.mod._malloc(samples.length * PTR);
      this.samplesCap = samples.length;
    }
    this.mod.HEAPF32.set(samples, this.samplesPtr / PTR);
    this.mod._SherpaOnnxOnlineStreamAcceptWaveform(
      this.handle,
      TARGET_SAMPLE_RATE,
      this.samplesPtr,
      samples.length,
    );
  }

  private readResult(): KwsHit | null {
    const r = this.mod._SherpaOnnxGetKeywordResult(this.spotter, this.handle);
    if (!r) return null;

    const jsonPtr = this.mod.getValue(r + RESULT_JSON_OFFSET, 'i8*');
    const json = jsonPtr ? this.mod.UTF8ToString(jsonPtr) : '';
    this.mod._SherpaOnnxDestroyKeywordResult(r);
    if (!json) return null;

    let parsed: SherpaKeywordResultJson;
    try {
      parsed = JSON.parse(json) as SherpaKeywordResultJson;
    } catch {
      return null;
    }

    const keyword = typeof parsed.keyword === 'string' ? parsed.keyword : '';
    if (!keyword) return null; // 没命中时 keyword 为空串

    return {
      keyword,
      tokens: normalizeTokens(parsed.tokens),
      timestamps: Array.isArray(parsed.timestamps) ? parsed.timestamps : [],
      startTime: typeof parsed.start_time === 'number' ? parsed.start_time : 0,
    };
  }
}

/**
 * 不同版本的结果里 tokens 有时是数组、有时是拼好的一整串，统一成数组。
 * 这个字段只用于展示，不要拿它做判断。
 */
function normalizeTokens(tokens: unknown): string[] {
  if (Array.isArray(tokens)) return tokens.map((t) => String(t));
  if (typeof tokens === 'string') return tokens.split(/\s+/).filter(Boolean);
  return [];
}

export class KwsEngine {
  private disposed = false;

  private constructor(
    private readonly mod: SherpaModule,
    private readonly spotter: number,
    private readonly model: ModelDescriptor,
  ) {}

  get modelId(): string {
    return this.model.id;
  }

  static async create(
    model: ModelDescriptor,
    options: KwsEngineOptions = {},
  ): Promise<KwsEngine> {
    const mod = await loadSherpaWasm({ onLog: options.onLog });
    const fsDir = await writeModelToFs(mod, model, options.onProgress);
    const tokensPath = `${fsDir}/${model.files.tokens}`;
    const config = buildSpotterConfig(mod, model, fsDir, buildSentinelKeyword(tokensPath, mod));

    let spotter = 0;
    try {
      spotter = mod._SherpaOnnxCreateKeywordSpotter(config.ptr);
    } finally {
      // 必须等 spotter 建完再释放：config 里存的是池内指针
      config.free();
    }
    if (!spotter) {
      throw new Error(`创建 KeywordSpotter 失败（模型 ${model.id}）。看控制台的 [sherpa] 日志。`);
    }

    return new KwsEngine(mod, spotter, model);
  }

  /**
   * 按当前词表建一路 stream。`keywords` 是 `音素... @显示文本 :boost #阈值`
   * 用 `/` 拼起来的串（见 tokenizer/buildKeywordsPayload）。
   * 返回 null 表示 sherpa-onnx 那边没接受（一般是音素不在 tokens.txt 里）。
   */
  createStream(keywords: string): KwsStream | null {
    if (this.disposed) throw new Error('KwsEngine 已释放');
    const ptr = this.toCString(keywords);
    try {
      const handle = this.mod._SherpaOnnxCreateKeywordStreamWithKeywords(this.spotter, ptr);
      if (!handle) return null;
      return new KwsStream(this.mod, this.spotter, handle);
    } finally {
      this.mod._free(ptr);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.spotter) this.mod._SherpaOnnxDestroyKeywordSpotter(this.spotter);
    // MEMFS 里的模型文件不删：同一份 wasm 里再加载别的模型时，
    // 同名文件的下载还能被浏览器 HTTP 缓存命中。
  }

  private toCString(s: string): number {
    const len = this.mod.lengthBytesUTF8(s) + 1;
    const ptr = this.mod._malloc(len);
    this.mod.stringToUTF8(s, ptr, len);
    return ptr;
  }
}

// ---------------------------------------------------------------------------
// 下面是把 JS 值写进 C 结构体的部分
// ---------------------------------------------------------------------------

/** 把一组字符串打进一块内存，返回每个串的指针 */
function allocStrings(mod: SherpaModule, list: string[]) {
  const lens = list.map((s) => mod.lengthBytesUTF8(s) + 1);
  const total = lens.reduce((a, b) => a + b, 0);
  const buf = mod._malloc(total);
  const ptrs: number[] = [];
  let off = 0;
  for (let i = 0; i < list.length; i++) {
    mod.stringToUTF8(list[i]!, buf + off, lens[i]!);
    ptrs.push(buf + off);
    off += lens[i]!;
  }
  return { buf, ptrs, free: () => mod._free(buf) };
}

async function fetchToFs(
  mod: SherpaModule,
  url: string,
  fsPath: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载模型文件失败: ${url} (HTTP ${res.status})`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);

  const parts: Uint8Array[] = [];
  let loaded = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      parts.push(value);
      loaded += value.length;
      onBytes(loaded, total);
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    parts.push(buf);
    loaded = buf.length;
    onBytes(loaded, total);
  }

  const merged = new Uint8Array(loaded);
  let off = 0;
  for (const p of parts) {
    merged.set(p, off);
    off += p.length;
  }
  mod.FS.writeFile(fsPath, merged);
}

/** 下载模型权重并写进 MEMFS，返回模型目录 */
async function writeModelToFs(
  mod: SherpaModule,
  model: ModelDescriptor,
  onProgress?: (p: ModelLoadProgress) => void,
): Promise<string> {
  const dir = `/models/${model.id}`;
  mod.FS.mkdirTree(dir);

  const files = [
    model.files.encoder,
    model.files.decoder,
    model.files.joiner,
    model.files.tokens,
    ...(model.files.lexicon ? [model.files.lexicon] : []),
  ];

  const base = assetUrl(model.dir);
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    await fetchToFs(mod, `${base}/${file}`, `${dir}/${file}`, (loaded, total) => {
      onProgress?.({
        file,
        fileIndex: i,
        fileCount: files.length,
        loaded,
        total,
      });
    });
  }
  return dir;
}

/** 拼 SherpaOnnxKeywordSpotterConfig。返回的 free() 必须在 **spotter 建好之后** 再调 */
function buildSpotterConfig(
  mod: SherpaModule,
  model: ModelDescriptor,
  fsDir: string,
  sentinel: string,
): { ptr: number; free: () => void } {
  // 字符串池和结构体是一体的：结构体里存的是池内指针，
  // 所以池必须活到 SherpaOnnxCreateKeywordSpotter 读完为止。
  // 提前 free 就是经典的悬垂指针——wasm 里不会立刻崩，只会读到垃圾路径。
  const strings = allocStrings(mod, [
    `${fsDir}/${model.files.encoder}`,
    `${fsDir}/${model.files.decoder}`,
    `${fsDir}/${model.files.joiner}`,
    `${fsDir}/${model.files.tokens}`,
    'cpu', // provider
    sentinel, // keywords_file：WASM 构建下这个字段被当成词条内容本身解析
  ]);
  const [encoder, decoder, joiner, tokens, provider, keywords] = strings.ptrs as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  const ptr = mod._malloc(KWS_CONFIG_LEN);
  mod.HEAPU8.fill(0, ptr, ptr + KWS_CONFIG_LEN);

  // --- featConfig ---
  mod.setValue(ptr + 0, TARGET_SAMPLE_RATE, 'i32');
  mod.setValue(ptr + 4, 80, 'i32');

  // --- modelConfig ---
  const mc = ptr + FEAT_CONFIG_LEN;
  mod.setValue(mc + 0, encoder, 'i8*');
  mod.setValue(mc + 4, decoder, 'i8*');
  mod.setValue(mc + 8, joiner, 'i8*');
  // paraformer / zipformer2_ctc 留 0
  mod.setValue(mc + MODEL_CONFIG_OFFSET_TOKENS + 0, tokens, 'i8*');
  mod.setValue(mc + MODEL_CONFIG_OFFSET_TOKENS + 4, 1, 'i32'); // num_threads=1，wasm 是单线程构建
  mod.setValue(mc + MODEL_CONFIG_OFFSET_TOKENS + 8, provider, 'i8*');
  mod.setValue(mc + MODEL_CONFIG_OFFSET_TOKENS + 12, 0, 'i32'); // debug
  // model_type / modeling_unit / bpe_vocab / tokens_buf / tokens_buf_size 留空。
  // modeling_unit 只被 ASR 的 EncodeHotwords 用到，KWS 这条链路根本不读它。

  // --- 词表相关的尾巴 ---
  const tail = ptr + FEAT_CONFIG_LEN + MODEL_CONFIG_LEN;
  mod.setValue(tail + 0, 4, 'i32'); // max_active_paths
  mod.setValue(tail + 4, 1, 'i32'); // num_trailing_blanks
  // keywords_score / keywords_threshold 是全局默认值，每个词条还能用
  // `:score #threshold` 单独覆盖（我们只用它来兜哨兵）
  mod.setValue(tail + 8, 1.0, 'float');
  mod.setValue(tail + 12, 0.25, 'float');
  // keywords_file：WASM 构建下这个字段被直接当成词条内容解析，
  // 只放哨兵；真实词表一律通过 createStream(keywords) 逐流给。
  mod.setValue(tail + 16, keywords, 'i8*');
  mod.setValue(tail + 20, 0, 'i8*'); // keywords_buf 留空（两个都非空会报冲突）
  mod.setValue(tail + 24, 0, 'i32'); // keywords_buf_size

  return {
    ptr,
    free: () => {
      mod._free(ptr);
      strings.free();
    },
  };
}
