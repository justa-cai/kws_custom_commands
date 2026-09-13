/**
 * 子序列 DTW（自由起点 + 自由终点）。
 *
 * 为什么是"子序列"而不是整段对齐：运行时我们手里只有一条不断流入的特征流，
 * 根本不知道那个词从哪一帧开始、到哪一帧结束。自由起点让模板可以对齐到
 * 流的任意位置，自由终点让它在词念完的那一帧收尾——这正是关键词检测要的语义。
 *
 * 性能的关键是**早停**：逐行算，一旦"到目前为止的平均代价"已经超过阈值，
 * 立刻放弃。不匹配的词通常在前 5~10 行就被砍掉，实测能省掉 90% 以上的计算。
 * 没有这一条，光靠 VAD 门控也撑不住几十条模板的实时打分。
 */

import type { FeatureMatrix } from './Mfcc';

export interface DtwOptions {
  /** 归一化距离超过它就提前放弃。去掉早停就传 Infinity */
  cutoff: number;
}

export interface DtwMatch {
  /** 按模板帧数与特征维数归一化后的距离（每维 RMS），可直接当阈值用 */
  distance: number;
  /** 匹配终点在 candidate 里的帧下标 */
  endFrame: number;
}

const INF = 1e30;

/**
 * 行缓冲复用。
 *
 * 运行时每 30ms 要对每条命令的每条模板算一次，几十条模板就是几十次调用；
 * 每次调用都 new 两个 Float32Array 的话，光垃圾回收就够卡一下了。
 * 这函数是同步的、调用方串行，所以共用一份 scratch 是安全的。
 */
let scratchPrev = new Float32Array(0);
let scratchCurr = new Float32Array(0);

function ensureScratch(n: number): void {
  if (scratchPrev.length < n) {
    scratchPrev = new Float32Array(n);
    scratchCurr = new Float32Array(n);
  }
}

/**
 * 在 candidate 里找 template 的最佳对齐。
 *
 * @returns 没找到（或早停掉）返回 null
 */
export function subsequenceDtw(
  template: FeatureMatrix,
  candidate: FeatureMatrix,
  opts: DtwOptions,
): DtwMatch | null {
  const dim = template.dim;
  const m = template.frames;
  const n = candidate.frames;
  if (dim === 0 || m === 0 || n === 0) return null;
  if (candidate.dim !== dim) return null;
  // 候选比模板还短一大截，不可能对齐（允许念快一点，留 0.5 倍余量）
  if (n < Math.floor(m * 0.5)) return null;

  const t = template.data;
  const c = candidate.data;
  ensureScratch(n);
  let prev = scratchPrev;
  let curr = scratchCurr;

  // 第一行：自由起点，所以每个 j 都可以是路径起点
  for (let j = 0; j < n; j++) {
    let acc = 0;
    const cb = j * dim;
    for (let k = 0; k < dim; k++) {
      const d = t[k]! - c[cb + k]!;
      acc += d * d;
    }
    prev[j] = acc;
  }

  const cutoffCost = opts.cutoff * opts.cutoff * dim; // 距离换算成平方代价

  let rowMin = INF;
  for (let j = 0; j < n; j++) if (prev[j]! < rowMin) rowMin = prev[j]!;
  if (rowMin > cutoffCost) return null;

  for (let i = 1; i < m; i++) {
    const tb = i * dim;
    rowMin = INF;
    for (let j = 0; j < n; j++) {
      let acc = 0;
      const cb = j * dim;
      for (let k = 0; k < dim; k++) {
        const d = t[tb + k]! - c[cb + k]!;
        acc += d * d;
      }

      // 三邻居取最小：竖直 / 水平 / 对角
      let best = prev[j]!;
      if (j > 0) {
        const left = curr[j - 1]!;
        if (left < best) best = left;
        const diag = prev[j - 1]!;
        if (diag < best) best = diag;
      }
      const v = acc + best;
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }

    // 平均代价已经超标 → 后面只会更差，直接砍掉
    if (rowMin / (i + 1) > cutoffCost) return null;

    // 行缓冲轮换，不重新分配
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  // 自由终点：最后一行取最小
  let bestCost = INF;
  let bestJ = 0;
  for (let j = 0; j < n; j++) {
    const v = prev[j]!;
    if (v < bestCost) {
      bestCost = v;
      bestJ = j;
    }
  }
  if (!Number.isFinite(bestCost)) return null;

  const distance = Math.sqrt(bestCost / m / dim);
  return { distance, endFrame: bestJ };
}
