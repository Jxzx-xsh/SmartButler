#!/usr/bin/env bash
#
# restart.sh —— 重启本地 dev 服务（后端 SMARTBUTLER_PORT，缺省 8820；前端 8821）
#
# 为什么单独写：
# 直接用 pkill -9 会跳过 Fastify 的 onClose 钩子，导致采集网关的 ffmpeg 子进程
# 变成孤儿继续占着摄像头连接（表现为"重启后画面还是旧的/一直重连"）。本脚本先发
# TERM 让后端优雅退出、由 onClose 停掉 ffmpeg，超时才 SIGKILL，最后再兜底清理残留。
#
# 用法：
#   bash scripts/restart.sh           # 重启并做健康检查
#   bash scripts/restart.sh --stop    # 只停止
#
# 可选环境变量：
#   SMARTBUTLER_LOG   日志文件路径，缺省 /tmp/smartbutler-dev.log
#   SMARTBUTLER_PORT  后端端口，缺省 8820
#   PWA_PORT          前端端口，缺省 8821（与 pwa/vite.config.ts 的 strictPort 一致）

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

LOG_FILE="${SMARTBUTLER_LOG:-/tmp/smartbutler-dev.log}"
BACKEND_PORT="${SMARTBUTLER_PORT:-8820}"
PWA_PORT="${PWA_PORT:-8821}"
STOP_ONLY=0
if [ "${1:-}" = "--stop" ]; then
  STOP_ONLY=1
fi

# 选择 Node 运行时。
#
# 项目用 volta 声明 Node 22.20.0（见 package.json 的 volta 字段），而 better-sqlite3
# 的原生模块是针对该版本编译的：若 PATH 里 homebrew 的 node（如 v26）先被选中，
# 后端会在 require 时报 ERR_DLOPEN_FAILED 直接崩。故优先把 volta 的 shim 前置，
# 让 shim 按 package.json 自动切到项目声明的版本。
ensure_node_path() {
  if [ -x "${HOME}/.volta/bin/npm" ]; then
    PATH="${HOME}/.volta/bin:${PATH}"
    export PATH
  fi
  if command -v npm >/dev/null 2>&1; then
    return 0
  fi
  local dir
  for dir in "/opt/homebrew/bin" "/usr/local/bin"; do
    if [ -d "${dir}" ]; then
      PATH="${dir}:${PATH}"
    fi
  done
  export PATH
  command -v npm >/dev/null 2>&1
}

# 列出占用指定 TCP 端口的 PID（空格分隔，空串表示未占用）
port_pids() {
  lsof -ti "tcp:$1" 2>/dev/null | tr '\n' ' '
}

# 优雅停止占用端口的进程：TERM → 等 5s → 仍占用则 KILL
stop_port() {
  local port="$1"
  local pids
  pids="$(port_pids "${port}")"
  if [ -z "$(echo "${pids}" | tr -d ' ')" ]; then
    return 0
  fi
  echo "[restart] 端口 ${port} 被占用（PID:${pids}），发送 TERM 等待优雅退出……"
  # shellcheck disable=SC2086 # 多 PID 需要按空格展开
  kill ${pids} 2>/dev/null || true

  local i
  for i in $(seq 1 20); do
    if [ -z "$(port_pids "${port}" | tr -d ' ')" ]; then
      echo "[restart] 端口 ${port} 已释放"
      return 0
    fi
    sleep 0.25
  done

  pids="$(port_pids "${port}")"
  if [ -n "$(echo "${pids}" | tr -d ' ')" ]; then
    echo "[restart] 优雅退出超时，强制 KILL（PID:${pids}）"
    # shellcheck disable=SC2086
    kill -9 ${pids} 2>/dev/null || true
  fi
}

# 兜底清理遗留的 ffmpeg 拉流/转码子进程（正常路径下 onClose 已处理，这里防 SIGKILL 遗留）
cleanup_orphan_ffmpeg() {
  local pattern
  for pattern in 'image2pipe' 's16le'; do
    if pgrep -f "ffmpeg.*${pattern}" >/dev/null 2>&1; then
      echo "[restart] 清理遗留 ffmpeg 进程（${pattern}）"
      pkill -9 -f "ffmpeg.*${pattern}" 2>/dev/null || true
    fi
  done
}

# 轮询等待 HTTP 就绪，最多 30s
wait_http() {
  local url="$1"
  local name="$2"
  local i
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null -m 2 "${url}" 2>/dev/null; then
      echo "[restart] ${name} 就绪：${url}"
      return 0
    fi
    sleep 0.5
  done
  echo "[restart] ${name} 启动超时（30s），请查看日志：${LOG_FILE}"
  return 1
}

ensure_node_path || {
  echo "[restart] 找不到 npm，请确认 Node 已安装并在 PATH 中"
  exit 1
}

stop_port "${BACKEND_PORT}"
stop_port "${PWA_PORT}"
cleanup_orphan_ffmpeg

if [ "${STOP_ONLY}" = "1" ]; then
  echo "[restart] 已停止（--stop）"
  exit 0
fi

echo "[restart] 后台启动 dev 服务（日志：${LOG_FILE}）……"
nohup npm run dev >"${LOG_FILE}" 2>&1 &
NEW_PID=$!
disown 2>/dev/null || true
echo "[restart] 已启动，父进程 PID ${NEW_PID}"

BACKEND_OK=1
PWA_OK=1
wait_http "http://localhost:${BACKEND_PORT}/api/items" "后端" || BACKEND_OK=0
wait_http "http://localhost:${PWA_PORT}/" "前端" || PWA_OK=0

if [ "${BACKEND_OK}" = "1" ]; then
  echo "[restart] 采集状态：$(curl -fsS -m 3 "http://localhost:${BACKEND_PORT}/api/capture/status" 2>/dev/null || echo '读取失败')"
fi

if [ "${BACKEND_OK}" = "1" ] && [ "${PWA_OK}" = "1" ]; then
  echo "[restart] 完成：后端 ${BACKEND_PORT} ✅、前端 ${PWA_PORT} ✅"
  exit 0
fi

echo "[restart] 启动未完全就绪，最近日志："
tail -n 20 "${LOG_FILE}" 2>/dev/null || true
exit 1
