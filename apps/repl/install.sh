#!/usr/bin/env bash
#
# dsh-repl — 一键安装脚本（参考 dsh-shortcuts 的 install.sh 风格）
#
# 把 repl 打成"独立的、可安装的前端"（独立 TUI 前端）。它驱动的 agent 运行时
# 是 **deepseek-harness 自带的**（dsh-jsonrpc-agent + cordis 插件闭包），由已
# 安装的 deepseek-harness 提供，本包不打包也不要求单独安装它。
# 由于前端闭包（@deepseek-ai/*）已被打单文件 lib/bin.js，本包只依赖公开的
# pi-tui / js-yaml，因此可脱离私有 registry 直接 npm 安装。
#
# 前置：目标机器已安装 deepseek-harness（agent 运行时来自其中）。
#
# 用法（任选其一）:
#   # 在已复制的发布目录 / 已解包的 tarball 内运行:
#   ./install.sh
#   # 或从仓库源码一键构建并安装:
#   curl -fsSL https://raw.githubusercontent.com/deepseek-ai/dsh-repl/main/install.sh | bash
#
# 环境变量（可选）:
#   DSH_REPL_TARBALL   指向本包的 .tgz（默认自动检测同目录或 from 源码 npm pack）
#   DSH_REPL_REGISTRY  指定 npm registry（默认用 npm 当前配置）
#   DSH_REPL_ROOT      已安装 deepseek-harness 的根目录（默认自动从 repl 所在位置推导）
#   DSH_REPL_CONFIG    代替默认的 <harness>/examples/jsonrpc-agent/interactive.cordis.yml
#
# 幂等：重复运行安全，会重建 bin 链接并确保 PATH 注册完整。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- 判定 tarball 来源 ----
# 本脚本可被放在发布目录内（旁边有 package.json/lib），也可独立 curl 下来用。
TARBALL="${DSH_REPL_TARBALL:-}"
if [ -z "$TARBALL" ]; then
  # 同目录下的 tarball（pnpm pack 产物）
  local_tg="$(ls -t "$SCRIPT_DIR"/deepseek-ai-dsh-repl-*.tgz 2>/dev/null | head -1 || true)"
  if [ -n "$local_tg" ]; then
    TARBALL="$local_tg"
  elif [ -f "$SCRIPT_DIR/package.json" ]; then
    echo "==> 检测到源码目录，构建本包…"
    (cd "$SCRIPT_DIR" && pnpm exec tsc -b tsconfig.json 2>/dev/null && pnpm exec tsdown --config tsdown.config.ts)
    TARBALL="$(cd "$SCRIPT_DIR" && pnpm pack 2>/dev/null | grep -E '\.tgz$' | tail -1)"
    TARBALL="$SCRIPT_DIR/${TARBALL##*/}"
  fi
fi

if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "错误: 找不到可安装的 dsh-repl tarball。"
  echo "      请先获取发布 tarball（或设置 DSH_REPL_TARBALL 指向它）。"
  exit 1
fi

echo "==> 1/3 全局安装 tarball: $TARBALL"
if [ -n "${DSH_REPL_REGISTRY:-}" ]; then
  npm install -g --registry "$DSH_REPL_REGISTRY" "$TARBALL"
else
  npm install -g "$TARBALL"
fi

echo "==> 2/3 校验 bin 可达"
if command -v dsh-repl >/dev/null 2>&1; then
  echo "    ✅ dsh-repl 已可用: $(command -v dsh-repl)"
else
  echo "    ⚠️  未在 PATH 中找到 dsh-repl；npm 全局 bin 目录可能需要加入 PATH。"
fi

echo "==> 3/3 接入 agent 运行时（deepseek-harness 自带）"
cat <<'EOF'

    ✅ 安装完成！dsh-repl 前端已就绪。

    前置依赖是 deepseek-harness 自带的 agent 运行时（dsh-jsonrpc-agent + cordis
    插件闭包），由已安装的 deepseek-harness 提供；repl 会默认自动定位它：
      - 在 deepseek-harness 目录内运行  → 直接 `dsh-repl`，无需配置
      - 从别的目录运行                → 设置 DSH_REPL_ROOT 指向 deepseek-harness 根
                                           export DSH_REPL_ROOT=/path/to/deepseek-harness
      - 特殊布局                      → 用 DSH_REPL_RUNTIME/DSH_REPL_CONFIG 精确指定

    卸载:  npm uninstall -g @deepseek-ai/dsh-repl
EOF
