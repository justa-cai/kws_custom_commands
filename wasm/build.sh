#!/usr/bin/env bash
#
# 编译 sherpa-onnx 的单线程 WebAssembly KWS，产物落到 public/wasm/。
# 本地和 CI 走同一条路径，见 .github/workflows/build-wasm.yml。
#
# 用法：
#   ./wasm/build.sh                  # 增量构建
#   CLEAN=1 ./wasm/build.sh          # 从零重建
#   WORK_DIR=/somewhere ./wasm/build.sh
#
# 环境变量：
#   SHERPA_ONNX_VERSION  上游 tag，默认 v1.13.8（改这里要同步改 wasm/README.md）
#   EMSDK_VERSION        emsdk 版本，默认 4.0.23（上游脚本标注 known to work）
#   WORK_DIR             构建缓存目录，默认 <repo>/tmp/wasm-build
#   OUT_DIR              产物输出目录，默认 <repo>/public/wasm
#   JOBS                 并行度，默认 nproc
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHERPA_ONNX_VERSION="${SHERPA_ONNX_VERSION:-v1.13.8}"
EMSDK_VERSION="${EMSDK_VERSION:-4.0.23}"
WORK_DIR="${WORK_DIR:-${REPO_ROOT}/tmp/wasm-build}"
OUT_DIR="${OUT_DIR:-${REPO_ROOT}/public/wasm}"
JOBS="${JOBS:-$(nproc)}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

if [[ -n "${CLEAN:-}" ]]; then
  log "CLEAN=1，删除 ${WORK_DIR}/sherpa-onnx 与构建目录"
  rm -rf "${WORK_DIR}/sherpa-onnx" "${WORK_DIR}/emsdk/upstream" 2>/dev/null || true
fi

mkdir -p "${WORK_DIR}" "${OUT_DIR}"

# --------------------------------------------------------------------------
# 1. emsdk
# --------------------------------------------------------------------------
if [[ ! -d "${WORK_DIR}/emsdk/.git" ]]; then
  log "克隆 emsdk"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "${WORK_DIR}/emsdk"
fi

if [[ ! -f "${WORK_DIR}/emsdk/upstream/emscripten/emcc" ]]; then
  log "安装 emsdk ${EMSDK_VERSION}（约 1-2 GB，只做一次）"
  (cd "${WORK_DIR}/emsdk" && ./emsdk install "${EMSDK_VERSION}")
fi

log "激活 emsdk ${EMSDK_VERSION}"
(cd "${WORK_DIR}/emsdk" && ./emsdk activate "${EMSDK_VERSION}")
# shellcheck disable=SC1091
source "${WORK_DIR}/emsdk/emsdk_env.sh" >/dev/null
emcc --version | head -1

# --------------------------------------------------------------------------
# 2. sherpa-onnx 源码 + 补丁
# --------------------------------------------------------------------------
if [[ ! -d "${WORK_DIR}/sherpa-onnx/.git" ]]; then
  log "克隆 sherpa-onnx ${SHERPA_ONNX_VERSION}"
  GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 --branch "${SHERPA_ONNX_VERSION}" \
    https://github.com/k2-fsa/sherpa-onnx.git "${WORK_DIR}/sherpa-onnx"
fi

PATCH_FILE="${REPO_ROOT}/wasm/kws-wasm.patch"
log "应用补丁 $(basename "${PATCH_FILE}")"
cd "${WORK_DIR}/sherpa-onnx"
if git apply --reverse --check "${PATCH_FILE}" 2>/dev/null; then
  echo "补丁已经打过了，跳过"
else
  git apply --check "${PATCH_FILE}"   # 打不上就直接失败，别产出一个坏 wasm
  git apply "${PATCH_FILE}"
  echo "补丁已应用"
fi
cd "${REPO_ROOT}"

# --------------------------------------------------------------------------
# 3. 编译
# --------------------------------------------------------------------------
log "运行上游 build-wasm-simd-kws.sh"
cd "${WORK_DIR}/sherpa-onnx"
# 上游脚本里写死了 make -j8，用 MAKEFLAGS 让 cmake 生成的 Makefile 跟随 JOBS
export MAKEFLAGS="-j${JOBS}"
./build-wasm-simd-kws.sh 2>&1 | tail -40
cd "${REPO_ROOT}"

# --------------------------------------------------------------------------
# 4. 收产物
# --------------------------------------------------------------------------
BUILD_OUT="${WORK_DIR}/sherpa-onnx/build-wasm-simd-kws/install/bin/wasm"
log "收集产物 ${BUILD_OUT} -> ${OUT_DIR}"
for f in sherpa-onnx-wasm-kws-main.js sherpa-onnx-wasm-kws-main.wasm; do
  [[ -f "${BUILD_OUT}/${f}" ]] || { echo "缺少产物 ${f}，构建失败" >&2; exit 1; }
  cp -f "${BUILD_OUT}/${f}" "${OUT_DIR}/${f}"
done

# 留一份上游的 glue 作参考（我们的 TS 封装是按它的 struct 布局写的）
cp -f "${WORK_DIR}/sherpa-onnx/wasm/kws/sherpa-onnx-kws.js" "${OUT_DIR}/upstream-sherpa-onnx-kws.js"

log "完成。产物："
ls -lh "${OUT_DIR}"
