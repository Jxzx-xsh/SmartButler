#!/usr/bin/env bash
#
# smoke.sh —— 端到端冒烟脚本
#
# 流程：
#   1. 灌入种子数据（npm --prefix backend run db:seed）；
#   2. 后台起后端（npm --prefix backend run start），记录 PID；
#   3. 轮询等待 /api/items 就绪（最多 ~20s）；
#   4. 依次 curl 一组只读状态端点 + POST /api/command，打印状态码与简要响应；
#   5. 未配置的外部服务（LM Studio / HA）优雅降级，非 200 不视为失败、不中断脚本；
#   6. trap EXIT 时关闭后端、清理临时日志。
#
# 注意：这里特意不用 `set -e`——需要逐个端点容错继续，由各步显式判断。

set -uo pipefail

# 切到仓库根目录（脚本位于 <root>/scripts/ 下）
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# 端口：优先取环境变量 SMARTBUTLER_PORT，默认 3000（与后端默认一致）
PORT="${SMARTBUTLER_PORT:-3000}"
BASE="http://127.0.0.1:${PORT}"
LOG_FILE="/tmp/sb_smoke_backend.log"

BACKEND_PID=""

# 清理函数：关闭后端、删临时日志（容错）
cleanup() {
  if [[ -n "${BACKEND_PID}" ]]; then
    echo ""
    echo "[smoke] 关闭后端（PID=${BACKEND_PID}）……"
    kill "${BACKEND_PID}" 2>/dev/null || true
    wait "${BACKEND_PID}" 2>/dev/null || true
  fi
  rm -f "${LOG_FILE}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# 工具：GET 端点，打印状态码 + 截断的响应体（容错，永不中断脚本）
check_get() {
  local path="$1"
  local body code
  body="$(curl -s -m 10 -w $'\n%{http_code}' "${BASE}${path}" 2>/dev/null)"
  code="$(printf '%s' "${body}" | tail -n1)"
  body="$(printf '%s' "${body}" | sed '$d')"
  echo "[smoke] GET ${path} -> ${code:-无响应}"
  echo "        ${body:0:200}"
}

# 工具：POST JSON 端点
check_post() {
  local path="$1"
  local data="$2"
  local body code
  body="$(curl -s -m 20 -w $'\n%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -d "${data}" "${BASE}${path}" 2>/dev/null)"
  code="$(printf '%s' "${body}" | tail -n1)"
  body="$(printf '%s' "${body}" | sed '$d')"
  echo "[smoke] POST ${path} -> ${code:-无响应}"
  echo "        ${body:0:300}"
}

echo "[smoke] === SmartButler 端到端冒烟 (PORT=${PORT}) ==="

# 1) 灌种子数据
echo "[smoke] 灌入种子数据（db:seed）……"
if ! npm --prefix backend run db:seed; then
  echo "[smoke] 警告：db:seed 失败，继续尝试起后端（可能已有数据）。"
fi

# 2) 后台起后端
echo "[smoke] 后台启动后端（npm --prefix backend run start）……"
SMARTBUTLER_PORT="${PORT}" npm --prefix backend run start >"${LOG_FILE}" 2>&1 &
BACKEND_PID="$!"
echo "[smoke] 后端 PID=${BACKEND_PID}，日志：${LOG_FILE}"

# 3) 轮询等待 /api/items 就绪（最多 ~20s）
echo "[smoke] 等待后端就绪……"
READY=0
for i in $(seq 1 40); do
  code="$(curl -s -m 3 -o /dev/null -w '%{http_code}' "${BASE}/api/items" 2>/dev/null || true)"
  if [[ "${code}" == "200" ]]; then
    READY=1
    echo "[smoke] 后端已就绪（第 ${i} 次探测，HTTP 200）。"
    break
  fi
  # 后端若已崩溃退出，提前结束等待
  if ! kill -0 "${BACKEND_PID}" 2>/dev/null; then
    echo "[smoke] 后端进程已退出，启动失败。末尾日志："
    tail -n 30 "${LOG_FILE}" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

if [[ "${READY}" -ne 1 ]]; then
  echo "[smoke] 等待超时：后端 ${BASE}/api/items 未就绪。末尾日志："
  tail -n 30 "${LOG_FILE}" 2>/dev/null || true
  exit 1
fi

# 4) 逐个端点冒烟（全部容错，未配置服务降级视为正常）
echo "[smoke] --- 只读端点 ---"
check_get "/api/items"
check_get "/api/items/expiring"
check_get "/api/ai/health"
check_get "/api/capture/status"
check_get "/api/gating/status"
check_get "/api/ha/status"

echo "[smoke] --- 指令端点 ---"
check_post "/api/command" '{"text":"还有什么快过期了"}'

echo "[smoke] 冒烟完成"
