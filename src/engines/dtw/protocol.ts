/** 主线程 ↔ DTW Worker 的消息协议 */

import type { CalibrationResult } from './DtwEngine';
import type { DtwHit, DtwTemplate, SerializedTemplate, VoiceCommand } from './types';

export interface DtwRuntimeOptions {
  stepFrames?: number;
  cooldownFrames?: number;
  confirmCount?: number;
  windowScale?: number;
}

export type DtwRequest =
  | { type: 'setCommands'; commands: VoiceCommand[] }
  | { type: 'setOptions'; options: DtwRuntimeOptions }
  | { type: 'feed'; chunk: Float32Array }
  | { type: 'flush' }
  | { type: 'reset' }
  | { id: number; type: 'extract'; samples: Float32Array }
  | { id: number; type: 'calibrate'; templates: DtwTemplate[]; negative: DtwTemplate | null };

export interface ExtractedPayload {
  template: SerializedTemplate | null;
  reason?: string;
  /** 端点检测切出来的那段音频，用于试听 */
  trimmed?: Float32Array;
}

export type DtwResponse =
  | { type: 'hit'; hit: DtwHit }
  | { id: number; type: 'extracted'; payload: ExtractedPayload }
  | { id: number; type: 'calibrated'; result: CalibrationResult }
  | { type: 'error'; message: string };
