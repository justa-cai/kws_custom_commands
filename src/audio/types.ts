/** 音频源统一契约：麦克风和 wav 文件都往同一条流水线里灌 16 k 定长块 */

export type ChunkHandler = (chunk: Float32Array) => void;

export interface AudioSourceEvents {
  /** 每块 1024 样本（16 kHz 单声道，取值 [-1,1]） */
  onChunk: ChunkHandler;
  /** 每块的 RMS，给音量条用 */
  onLevel?: (rms: number) => void;
  /** 文件播完 / 流结束 */
  onEnded?: () => void;
}

export interface AudioSource {
  readonly kind: 'mic' | 'file';
  readonly label: string;
  start(events: AudioSourceEvents): Promise<void>;
  stop(): Promise<void>;
}
