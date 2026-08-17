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
# cloudflare tunnel 经 dsh.want.biz 访问时，需把该 authority 加入 /api 信任栅栏；
# 可用 DSH_WEB_TRUSTED_HOST 覆盖（可多个，空格分隔）。
WEB_TRUSTED_HOST="${DSH_WEB_TRUSTED_HOST:-dsh.want.biz}"

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
  # 统一走守护脚本 ~/bin/dsh-web.sh（其 DSH_HOME 与会话根与 TUI 一致：~/.dsh）。
  # 守护脚本后台 nohup 拉起、PID 写 ~/.dsh/run/dsh-web.pid、日志写 ~/.dsh/logs/dsh-web.log；
  # 自定义端口经 DSH_WEB_PORT 透传，与 ygsw/ygs 体系及 dsh-web status/restart 完全对上。
  # 若守护脚本不可用，则回退到旧方式裸拉起（保持容错）。
  if [ -x "$HOME/bin/dsh-web.sh" ]; then
    DSH_WEB_PORT="$WEB_PORT" "$HOME/bin/dsh-web.sh" start >/dev/null 2>&1 || true
  else
    (
      cd "$REPL_ROOT"
      trusted_args=()
      for h in $WEB_TRUSTED_HOST; do trusted_args+=(--trusted-host "$h"); done
      nohup node apps/cli/lib/bin.js web --host 127.0.0.1 --port "$WEB_PORT" "${trusted_args[@]}" \
        >/tmp/launch-web.log 2>&1 &
      echo $! >"$WEB_PID_FILE"
    )
  fi
  for _ in $(seq 1 25); do
    sleep 1
    lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
  done
  if lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    local pid
    # 优先读取守护脚本的 pid 文件；缺失时回退到旧 pid 文件
    if [ -f "$HOME/.dsh/run/dsh-web.pid" ]; then
      pid="$(cat "$HOME/.dsh/run/dsh-web.pid" 2>/dev/null || echo 'unknown')"
    else
      pid="$(cat "$WEB_PID_FILE" 2>/dev/null || echo 'unknown')"
    fi
    echo "[launch] web 就绪 http://127.0.0.1:$WEB_PORT (pid $pid)"
    log_status "web 启动成功 http://127.0.0.1:$WEB_PORT (pid $pid)"
  else
    echo "[launch] WARNING: web 未能在 $WEB_PORT 就绪，详见日志 (守护脚本 / 旧 /tmp/launch-web.log)"
    log_status "web 启动失败 :$WEB_PORT (守护脚本 / 旧 /tmp/launch-web.log)"
  fi
}
ensure_web

# ---- TUI session 协调：Copy-on-Write + 退出时合并 ----
# 为 TUI 创建 session 副本，避免与 web 并发写入冲突。
COORDINATOR="$REPL_ROOT/session-coordinator.cjs"

# 找到当前工作区最新的 session（用于恢复）
find_latest_session() {
  local sessions_dir="$HOME/.dsh/sessions"
  local project_dir
  # 将 PROJECT 路径转为 dsh 的项目目录名
  project_dir=$(echo "$PROJECT" | sed 's|/|-|g; s|^-||; s|-$||')
  local proj_path="$sessions_dir/--${project_dir}--"
  if [ ! -d "$proj_path" ]; then
    echo ""
    return
  fi
  # 找最近修改的 session 目录（排除 -tui-copy 和 .bak 文件）
  local latest
  latest=$(ls -t "$proj_path" 2>/dev/null | grep -v '\-tui-copy$' | grep -v '\.bak' | head -1)
  echo "$latest"
}

LATEST_SESSION=$(find_latest_session)
TUI_SESSION_ID=""
TUI_COPY_SESSION=""

if [ -n "$LATEST_SESSION" ] && [ -f "$COORDINATOR" ]; then
  echo "[launch] 发现最新 session: $LATEST_SESSION"
  # 创建副本
  TUI_COPY_SESSION=$(node "$COORDINATOR" copy "$LATEST_SESSION" 2>&1)
  TUI_SESSION_ID=$(echo "$TUI_COPY_SESSION" | grep "副本 ID:" | awk '{print $NF}')
  if [ -n "$TUI_SESSION_ID" ]; then
    echo "[launch] TUI 将使用副本: $TUI_SESSION_ID"
  fi
fi

# 合并函数（TUI 退出时调用）
cleanup_tui_session() {
  if [ -n "$LATEST_SESSION" ] && [ -f "$COORDINATOR" ]; then
    echo ""
    echo "[launch] 合并 TUI session..."
    node "$COORDINATOR" merge "$LATEST_SESSION" 2>&1 || {
      echo "[launch] ⚠️  合并失败，副本已保留"
      echo "[launch] 手动清理: node $COORDINATOR cleanup $LATEST_SESSION"
    }
  fi
}

# 设置 trap，TUI 退出时自动合并
trap cleanup_tui_session EXIT

# ---- TUI：目标工作区（默认 web 项目目录）----
PROJECT="${DSH_WEB_PROJECT:-/Users/ygs/Downloads/deepseek-harness-book-main}"
cd "$PROJECT"

if [ -n "$TUI_SESSION_ID" ]; then
  echo "[launch] 启动 TUI (resume: $TUI_SESSION_ID)"
  exec node "$REPL_ROOT/apps/repl/lib/bin.js" --web-sessions --resume "$TUI_SESSION_ID"
else
  echo "[launch] 启动 TUI (新 session)"
  exec node "$REPL_ROOT/apps/repl/lib/bin.js" --web-sessions
fi
