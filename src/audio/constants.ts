/**
 * 整条音频流水线共用的常量。
 *
 * 上游 sherpa-onnx 的 KWS 模型固定吃 16 kHz 单声道 Float32；
 * DTW 那条路也按 16 kHz 算 MFCC。所以整条链路只在入口重采样一次，
 * 下游拿到的永远是 16 k / 定长块，谁都不用再关心设备采样率。
 */

export const TARGET_SAMPLE_RATE = 16000;

/** 每块 1024 样本 = 64 ms。够小，唤醒延迟感觉不出来；又够大，不至于天天 postMessage */
export const CHUNK_SAMPLES = 1024;

/** models/ 与 samples/ 之外的静态资源根（Vite 的 BASE_URL） */
export function assetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL; // 形如 "/kws_custom_commands/"
  return `${base}${relativePath.replace(/^\/+/, '')}`;
}
