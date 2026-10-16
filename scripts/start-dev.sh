#!/usr/bin/env bash
#
# start-dev.sh —— 本地开发一键启动脚本
#
# 并行后台起后端（tsx watch）与前端（vite）dev server，二者共用本终端输出。
# 退出时（正常退出 / Ctrl-C / 被 kill）统一清理两个子进程，保证不留僵尸进程。
# 任一进程退出即整体收尾，不阻塞卡死。
# 注意：收尾用轮询 `kill -0` 判断子进程存活，兼容 macOS 自带 bash 3.2（`wait -n` 需 bash 4+）。
#
# 说明：根 package.json 的 `npm run dev` 用 concurrently 做同样的事并带前缀标签，
# 本脚本提供纯 shell 版本（不依赖 concurrently），行为等价、更可控。

set -euo pipefail

# 切到仓库根目录（脚本位于 <root>/scripts/ 下）
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# 记录子进程 PID，便于统一清理
PIDS=()

# 清理函数：容错 kill 两个子进程（忽略已退出的）
cleanup() {
  echo ""
  echo "[start-dev] 正在清理子进程……"
  for pid in "${PIDS[@]}"; do
    # 进程可能已退出，kill 失败不报错
    kill "${pid}" 2>/dev/null || true
  done
  # 给子进程一点时间优雅退出
  wait 2>/dev/null || true
  echo "[start-dev] 已退出。"
}

# 正常退出 / Ctrl-C / TERM 均触发清理
trap cleanup EXIT INT TERM

echo "[start-dev] 启动后端 dev（npm --prefix backend run dev）……"
npm --prefix backend run dev &
PIDS+=("$!")

echo "[start-dev] 启动前端 dev（npm --prefix pwa run dev）……"
npm --prefix pwa run dev &
PIDS+=("$!")

echo "[start-dev] 前后端已并行启动，按 Ctrl-C 退出。"

# 阻塞直到任一子进程退出；任一退出即返回，随后 trap EXIT 统一清理另一个。
# bash 3.2 不支持 `wait -n`，改为轮询两个子进程 PID：任一不再存活即收尾。
while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      break 2
    fi
  done
  sleep 1
done
