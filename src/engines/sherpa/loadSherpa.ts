/**
 * 加载 sherpa-onnx 的 WASM 模块。
 *
 * 产物是 emscripten 用 `-sMODULARIZE=1 -sEXPORT_NAME=createSherpaKws` 编的，
 * 但**不是 ES module**：它是个经典脚本，跑完在 window 上挂一个
 * `createSherpaKws` 工厂函数。用 `<script>` 注入而不是 `import()`，
 * 是因为经典脚本这条路对打包器和 MIME 类型都不挑，最不容易出事。
 *
 * 产物不进仓库（.gitignore 掉了 public/wasm/），本地要先 `npm run wasm:build`。
 * 没编过的话这里会给出明确的指引，而不是让页面白屏。
 */

import { assetUrl } from '../../audio/constants';
import type { SherpaModule, SherpaModuleFactory } from './types';

const SCRIPT_PATH = 'wasm/sherpa-onnx-wasm-kws-main.js';

let pending: Promise<SherpaModule> | null = null;

export interface LoadSherpaOptions {
  /** 收 emscripten 的 stdout/stderr；不传就只写 console */
  onLog?: (line: string) => void;
}

export function loadSherpaWasm(options: LoadSherpaOptions = {}): Promise<SherpaModule> {
  if (!pending) {
    pending = boot(options).catch((e) => {
      pending = null; // 失败要能重试
      throw e;
    });
  }
  return pending;
}

export function isSherpaWasmLoaded(): boolean {
  return pending !== null;
}

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-kws-wasm]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(notBuiltMessage())));
      return;
    }

    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.dataset.kwsWasm = '1';
    el.addEventListener('load', () => {
      el.dataset.loaded = '1';
      resolve();
    });
    el.addEventListener('error', () => reject(new Error(notBuiltMessage())));
    document.head.appendChild(el);
  });
}

function notBuiltMessage(): string {
  return [
    `加载 ${SCRIPT_PATH} 失败。`,
    '这个文件是编译产物，不在仓库里。先跑一次：',
    '    npm run wasm:build',
    '（首次会下载 emsdk 并编译 sherpa-onnx，约 20-40 分钟；之后是增量的。）',
  ].join('\n');
}

async function boot(options: LoadSherpaOptions): Promise<SherpaModule> {
  await injectScript(assetUrl(SCRIPT_PATH));

  const factory: SherpaModuleFactory | undefined = window.createSherpaKws;
  if (typeof factory !== 'function') {
    throw new Error(`${SCRIPT_PATH} 已加载，但没有挂上 createSherpaKws 工厂函数。构建产物不对？`);
  }

  const log = (line: string) => {
    options.onLog?.(line);
    if (!options.onLog) console.debug('[sherpa]', line);
  };

  const mod = await factory({
    locateFile: (path) => assetUrl(`wasm/${path}`),
    print: log,
    printErr: (line) => {
      options.onLog?.(line);
      console.warn('[sherpa]', line);
    },
  });

  return mod;
}
