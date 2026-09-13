/*
 * 麦克风采集的 AudioWorklet 处理器。
 *
 * 为什么是 .js 而不是 .ts：这个文件必须能被 `audioWorklet.addModule(url)`
 * 直接加载，而 Vite 对 TS 文件的 `?url` 处理并不可靠（实测构建时既不产出
 * 资源也不内联，只在 bundle 里留了个解析不出来的引用）。放在 public/ 下
 * 由静态服务器直接托管是最稳的——dev 和 build 行为完全一致，
 * 也不依赖打包器的 URL 语义。
 *
 * 这个脚本跑在 AudioWorkletGlobalScope 上（独立音频线程），
 * 可用的全局量只有：registerProcessor / AudioWorkletProcessor /
 * sampleRate / currentTime / currentFrame。没有 window、没有 DOM。
 *
 * 它只做一件事：把 128 样本一块的 render quantum 攒成 1024 样本的定长块
 * 再 postMessage 出去——每 2.7 ms 发一条消息太浪费，64 ms 一条刚好。
 *
 * 这里不做重采样：主线程那侧有带相位的流式重采样器，跨块连续，
 * 状态放在 worklet 里反而更难维护。
 */

const BLOCK = 1024;

class KwsCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BLOCK);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;

    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === BLOCK) {
        // 必须 copy：这块 buffer 下一轮就被复用了
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('kws-capture', KwsCaptureProcessor);
