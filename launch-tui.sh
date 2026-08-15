#!/bin/bash
# 启动 dsh-repl TUI，默认带 --web-sessions：把会话根切到 dsh web 的共享根
# (<$DSH_HOME>/sessions，默认 ~/.dsh/sessions)，使 TUI 与 web 读写同一份日志。
#
# 若 web 服务（dsh web）尚未在 DSH_WEB_PORT（默认 3080）监听，则先后台拉起一个，
# 再启动 TUI；已存在则跳过，避免重复。
#
# web 的每次启动结果会追加记录到 $DSH_WEB_STATUS_LOG（默认 /tmp/launch-web-status.txt），
# 便于随时查看启动是否成功。
#
# 默认 cd 到 web 项目目录（命中该工作区的会话）；可用 DSH_WEB_PROJECT 覆盖：
#   DSH_WEB_PROJECT=/path/to/project ./launch-tui.sh
# web 端口可用 DSH_WEB_PORT 覆盖，如： DSH_WEB_PORT=9080 ./launch-tui.sh
set -euo pipefail

REPL_ROOT="$(cd "$(dirname "$0")" && pwd)"
WEB_PORT="${DSH_WEB_PORT:-3080}"
WEB_STATUS_LOG="${DSH_WEB_STATUS_LOG:-/tmp/launch-web-status.txt}"
WEB_PID_FILE=/tmp/launch-web.pid

# 把一条启动结果记录追加到状态日志（附带时间戳）。
log_status() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$WEB_STATUS_LOG"
}

# 加载项目凭证（OPENCODE_GO_API_KEY 等），供 opencode-go 提供方使用。
set -a
# shellcheck disable=SC1091
source "$REPL_ROOT/.env"
set +a
if [ -n "${OPENCODE_GO_API_KEY:-}" ]; then
  echo "[launch] OPENCODE_GO_API_KEY loaded (len=${#OPENCODE_GO_API_KEY})"
else
  echo "[launch] WARNING: OPENCODE_GO_API_KEY NOT loaded"
  log_status "WARNING OPENCODE_GO_API_KEY 未加载"
fi

# ---- web：未起则后台拉起一个 dsh web；结果落盘记录 ----
ensure_web() {
  if lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[launch] web 已在 http://127.0.0.1:$WEB_PORT 运行"
    log_status "web 已存在 http://127.0.0.1:$WEB_PORT (本次未启动)"
    return
  fi
  echo "[launch] web 未在 $WEB_PORT 监听，后台启动…"
  log_status "开始后台启动 web :$WEB_PORT"
  # 在 deepseek-harness 目录后台起 web（其 DSH_HOME 与会话根与 TUI 一致：~/.dsh）。
  # nohup 让它忽略 SIGHUP，从而在 TUI 退出 / 终端会话结束后仍独立存活；
  # PID 写入 $WEB_PID_FILE 便于后续管理。
  # shellcheck disable=SC2086
  (
    cd "$REPL_ROOT"
    nohup node apps/cli/lib/bin.js web --host 127.0.0.1 --port "$WEB_PORT" \
      >/tmp/launch-web.log 2>&1 &
    echo $! >"$WEB_PID_FILE"
  )
  for _ in $(seq 1 25); do
    sleep 1
    lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  done
  if lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    local pid
    pid="$(cat "$WEB_PID_FILE" 2>/dev/null || echo 'unknown')"
    echo "[launch] web 就绪 http://127.0.0.1:$WEB_PORT (pid $pid)"
    log_status "web 启动成功 http://127.0.0.1:$WEB_PORT (pid $pid)"
  else
    echo "[launch] WARNING: web 未能在 $WEB_PORT 就绪，详见 /tmp/launch-web.log"
    log_status "web 启动失败 :$WEB_PORT (详见 /tmp/launch-web.log)"
  fi
}
ensure_web

# ---- TUI：目标工作区（默认 web 项目目录）----
PROJECT="${DSH_WEB_PROJECT:-/Users/ygs/Downloads/deepseek-harness-book-main}"
cd "$PROJECT"

exec node "$REPL_ROOT/apps/repl/lib/bin.js" --web-sessions
