#!/usr/bin/env bash
# ==============================================================================
# restore-patches.sh — 一键恢复 dsh rc.8 三项 UI 优化（升级后重打）
# 位置：~/.dsh/profiles/web/restore-patches.sh
# 备份：ygsdoc/dsh-rc8-ui-patches/ （含本脚本 + 3 个 pnpm 补丁 + 3 个本地插件）
# ==============================================================================
#
# 【背景】
# 2026-08-20 升级 dsh 到 0.1.0-rc.8 后，以下三处通过直接改 node_modules 实现的
# 优化被覆盖丢失（pnpm 直接改文件不持久，npm -g 升级会覆盖 /opt/homebrew 下文件）：
#
# 【三项优化】
# 1) TPS 显示到输入框 master 同行右侧
#    - 原状：dsh-live-stats 默认把 TPS 渲染到输入框下方居中的状态条
#            [data-slot="conversation.composer.dock"]，样式居中、带一位小数（如 33.6）
#    - 目标：搬到输入框内 master 控件同行最右侧，整数 + 冒号格式（如 TPS: 234 tok/s）
#    - 实现：pnpm 补丁 @captain1275/dsh-live-stats
#            * formatTokensPerSecond: String(Math.round(value)) 整数化
#            * STYLE: marginLeft:auto + whiteSpace:nowrap（靠右行内）
#            * 文案: "TPS " -> "TPS: "
#            * 挂载: conversation.composer.dock -> conversation.input.right
#    - 文件：patches/@captain1275__dsh-live-stats.patch
#            已登记到 pnpm-workspace.yaml patchedDependencies，pnpm install 自动重打
#
# 2) 去掉输入框上方的 session log
#    - 原状：输入框上方有一条居中的 session 统计/日志条（composer dock）
#    - 目标：完全隐藏该条，输入框更干净
#    - 实现：pnpm 补丁 @captain1275/dsh-web-ui-all
#            在 lib/client.js 的 apply() 中注入 CSS：
#              [data-slot="conversation.composer.dock"] {display:none}
#              [data-dsh-stats] {display:none}
#            同时本地插件 hide-session-log.plugin.mjs 做双保险
#    - 文件：patches/@captain1275__dsh-web-ui-all.patch + plugins/hide-session-log.plugin.mjs
#
# 3) 手机左侧菜单常显（窄屏不自动收起）
#    - 原状：dsh-client-ui-layout 在 <1024px 视为窄屏，sidebarCollapsed = !narrowExpanded，
#            且 aurora 皮肤会把折叠状态持久化到 localStorage，下次加载 150ms 后强制回折
#            导致手机选工作空间后，侧边栏一会儿就消失，连 56px 导轨也不显示
#    - 目标：手机端左侧菜单常显，不自动收起
#    - 实现（三重保险）：
#      a) pnpm 补丁 @captain1275/dsh-client-ui-skin-aurora：删掉对
#         localStorage dsh.ui-skin-aurora.sidebar-collapsed 的读写及自动回折逻辑
#      b) 全局布局补丁 /opt/homebrew/.../dsh-client-ui-layout/lib/client.js：
#         SIDEBAR_AUTO_COLLAPSE 1024 -> 0，使 narrow 永远 false
#         （npm -g 升级会丢失，已纳入本脚本自动重打）
#      c) 本地插件 mobile-sidebar-always-visible + mobile-rail-fab：
#         CSS 强制 [data-sidebar-collapsed] 时仍 display:flex + JS 监听折叠后自动展开
#         另在 web-ui-all 补丁中也注入 @media 兜底 CSS
#    - 文件：patches/@captain1275__dsh-client-ui-skin-aurora.patch
#            + 全局 layout 文件 + plugins/mobile-*.plugin.mjs
#            + patches/@captain1275__dsh-web-ui-all.patch 中的 @media 部分
#
# 【我们改的 vs 你修的】
# - 我们改的：上述 3 个 pnpm 补丁 + 3 个本地插件 + cordis.patch.yml 注册 + 全局 layout 直改
# - 你修的（启动失败后）：
#   a) 为 hide-session-log / mobile-sidebar 加 document 守卫：
#      if (typeof document === 'undefined' || typeof window === 'undefined') return
#      否则宿主端 (node) 执行会抛 ReferenceError: document is not defined
#   b) pnpm install 补齐 @deepseek-ai/dsh-sdk-protocol，使 subagent-codex/claude-code 可解析
#      （cordis.patch.yml 中那两行 insert 若依赖缺失会导致整个 profile 加载失败）
#   本脚本已包含守卫，pnpm 补丁已登记，下次升级后重跑本脚本即可，无需手动改插件
#
# 【用法】
#   dsh 每次 npm i -g @deepseek-ai/dsh@新rc 后执行：
#     bash ~/.dsh/profiles/web/restore-patches.sh
#   或
#     bash ygsdoc/dsh-rc8-ui-patches/restore-patches.sh
#   脚本会：校验补丁存在 -> pnpm install 重打 -> 重打全局布局 -> 重启 web
#
# 【验证】
#   curl -s http://127.0.0.1:3080/ | grep -o "TPS:" | head
#   grep -c "localStorage.*sidebar-collapsed" ~/.dsh/profiles/web/node_modules/@captain1275/dsh-client-ui-skin-aurora/lib/client.js  # 应为 0
#   grep -n SIDEBAR_AUTO_COLLAPSE /opt/homebrew/.../dsh-client-ui-layout/lib/client.js  # 应为 0
#
# ==============================================================================
set -euo pipefail
PROFILE_DIR="${HOME}/.dsh/profiles/web"
GLOBAL_LAYOUT="/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js"

echo "== 1) 校验 pnpm 补丁文件 =="
ls -lh "$PROFILE_DIR/patches/" | grep -E "live-stats|skin-aurora|web-ui-all" || { echo "❌ 缺少 pnpm 补丁"; exit 1; }
echo "--- pnpm-workspace 登记 ---"
grep -A2 patchedDependencies "$PROFILE_DIR/pnpm-workspace.yaml" | head -n 10

echo ""
echo "== 2) pnpm install 重打补丁（profile 依赖） =="
(cd "$PROFILE_DIR" && pnpm install --silent 2>&1 | tail -n 5) || true
echo "✓ pnpm 补丁已重打"

echo ""
echo "== 3) 全局布局补丁：手机侧边栏常显 =="
if [ -f "$GLOBAL_LAYOUT" ]; then
  if grep -q "SIDEBAR_AUTO_COLLAPSE = 1024" "$GLOBAL_LAYOUT"; then
    echo "  重打全局布局..."
    perl -i -pe 's/const SIDEBAR_AUTO_COLLAPSE = 1024;/const SIDEBAR_AUTO_COLLAPSE = 0; \/\/ patched: keep sidebar always visible on mobile/' "$GLOBAL_LAYOUT"
    echo "  ✓ 全局布局已补丁: $(grep -n SIDEBAR_AUTO_COLLAPSE "$GLOBAL_LAYOUT" | head -n1)"
  else
    echo "  ✓ 全局布局已是补丁态: $(grep -n SIDEBAR_AUTO_COLLAPSE "$GLOBAL_LAYOUT" | head -n1)"
  fi
else
  echo "  ⚠ 未找到全局布局文件，跳过（路径可能变更）: $GLOBAL_LAYOUT"
fi

echo ""
echo "== 4) 校验本地插件守卫 =="
for f in "$PROFILE_DIR"/hide-session-log.plugin.mjs "$PROFILE_DIR"/mobile-sidebar-always-visible.plugin.mjs "$PROFILE_DIR"/mobile-rail-fab.plugin.mjs; do
  if [ -f "$f" ]; then
    if grep -q "typeof document" "$f"; then echo "  ✓ $f 有守卫"; else echo "  ⚠ $f 缺守卫"; fi
  fi
done

echo ""
echo "== 5) 重启 web =="
# 优先用守护脚本，其次兜底 nohup
if command -v dsh-web >/dev/null 2>&1 && [ -x "$HOME/bin/dsh-web.sh" ]; then
  "$HOME/bin/dsh-web.sh" restart 2>&1 | tail -n 20 || true
else
  pkill -9 -f "dsh.*web" 2>&1; sleep 2
  nohup dsh web --host 127.0.0.1 --port 3080 --trusted-host dsh.want.biz >/tmp/dsh-web-restore.log 2>&1 &
  sleep 3
fi
sleep 2
if curl -s -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:3080/ | grep -q "200"; then
  echo "✓ web 已就绪 http://127.0.0.1:3080/"
else
  echo "⚠ web 未就绪，请手动: ~/bin/dsh-web.sh restart; curl http://127.0.0.1:3080/"
fi

echo ""
echo "== 完成 =="
echo "验证命令："
echo "  grep -n 'TPS:' ~/.dsh/profiles/web/node_modules/@captain1275/dsh-live-stats/lib/client.js"
echo "  grep -c 'localStorage.*sidebar-collapsed' ~/.dsh/profiles/web/node_modules/@captain1275/dsh-client-ui-skin-aurora/lib/client.js  # 应为 0"
echo "  curl -s http://127.0.0.1:3080/ | grep -o 'hide-session-log\|mobile-sidebar' | head"
