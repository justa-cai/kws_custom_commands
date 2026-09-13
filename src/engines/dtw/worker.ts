/// <reference lib="webworker" />

/**
 * DTW 的 Web Worker。
 *
 * 放 Worker 里跑是因为主线程同时扛着两件事：sherpa-onnx 的 ONNX 推理
 * 和 DOM 渲染。再往里塞几十条模板的 DTW 打分，UI 会明显掉帧。
 *
 * 造词（extract）和阈值校准（calibrate）也走这里，保证它们和运行时
 * 用的是**同一份特征提取代码**——这类参数失配一旦出现，现象是
 * "录音时好好的，运行时一个都不触发"，很难查。
 */

import { calibrate, DtwEngine, extractTemplate } from './DtwEngine';
import {
  deserializeTemplate,
  serializeTemplate,
  type DtwTemplate,
  type SerializedTemplate,
} from './types';
import type { DtwRequest, DtwResponse } from './protocol';

const engine = new DtwEngine({
  onHit: (hit) => post({ type: 'hit', hit }),
});

function post(msg: DtwResponse): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = (ev: MessageEvent<DtwRequest>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'setCommands':
        engine.setCommands(msg.commands);
        break;

      case 'setOptions':
        // 选项只在构造时用得上，运行时改不了；这里只做提醒，不静默忽略
        console.warn('[dtw] setOptions 需要重建 engine，已忽略', msg.options);
        break;

      case 'feed':
        engine.feed(msg.chunk);
        break;

      case 'flush':
        engine.flush();
        break;

      case 'reset':
        engine.reset();
        break;

      case 'extract': {
        const { template, reason, trimmed } = extractTemplate(msg.samples);
        post({
          id: msg.id,
          type: 'extracted',
          payload: {
            template: template ? serializeTemplate(template) : null,
            ...(reason !== undefined ? { reason } : {}),
            ...(trimmed ? { trimmed } : {}),
          },
        });
        break;
      }

      case 'calibrate': {
        const templates = msg.templates.map((t) => hydrate(t));
        const negative = msg.negative ? hydrate(msg.negative) : null;
        post({ id: msg.id, type: 'calibrated', result: calibrate(templates, negative) });
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', message: `DTW worker: ${(e as Error).message}` });
  }
};

/** 跨线程传过来的模板可能是 Float32Array（结构化克隆）也可能已被序列化 */
function hydrate(t: DtwTemplate | SerializedTemplate): DtwTemplate {
  if (t.data instanceof Float32Array) return t as DtwTemplate;
  return deserializeTemplate(t as SerializedTemplate);
}
