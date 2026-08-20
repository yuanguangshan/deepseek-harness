#!/usr/bin/env bash
# ==============================================================================
# apply.sh — 一键应用 dsh web UI 四项优化补丁
# 位置：ygsdoc/dsh-rc8-ui-patches/patches-v2/apply.sh
#
# 用法：
#   bash apply.sh              # 自动检测 profile 路径并应用
#   bash apply.sh /custom/path # 指定 profile 目录
#
# 前置条件：
#   - dsh web profile 目录存在（默认 ~/.dsh/profiles/web）
#   - node_modules 已安装（pnpm install）
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROFILE_DIR="${1:-$HOME/.dsh/profiles/web}"

# 颜色
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }

# 检查 profile 目录
if [ ! -d "$PROFILE_DIR/node_modules" ]; then
  fail "未找到 node_modules: $PROFILE_DIR"
  echo "   请先运行: cd $PROFILE_DIR && pnpm install"
  exit 1
fi

APPLIED=0
SKIPPED=0

apply_patch() {
  local pkg_dir="$1"
  local patch_file="$2"
  local target="$PROFILE_DIR/node_modules/$pkg_dir/lib/client.js"

  if [ ! -f "$target" ]; then
    warn "跳过 $pkg_dir: 目标文件不存在"
    SKIPPED=$((SKIPPED + 1))
    return
  fi

  if grep -q "patched" "$target" 2>/dev/null; then
    warn "跳过 $pkg_dir: 已应用过"
    SKIPPED=$((SKIPPED + 1))
    return
  fi

  if patch -p0 -d "$PROFILE_DIR/node_modules" < "$SCRIPT_DIR/$patch_file" >/dev/null 2>&1; then
    ok "$pkg_dir"
    APPLIED=$((APPLIED + 1))
  else
    fail "$pkg_dir: patch 失败"
  fi
}

echo "== 应用 dsh web UI 补丁 =="
echo "Profile: $PROFILE_DIR"
echo ""

# 1) live-stats: TPS 整数化 + 移到输入框同行右侧
apply_patch "@captain1275/dsh-live-stats" "@captain1275__dsh-live-stats.patch"

# 2) skin-aurora: 手机侧栏常显
apply_patch "@captain1275/dsh-client-ui-skin-aurora" "@captain1275__dsh-client-ui-skin-aurora.patch"

# 3) web-ui-all: session log 文字隐藏 + 模型名移到占位符 + 模型菜单缩窄
apply_patch "@captain1275/dsh-web-ui-all" "@captain1275__dsh-web-ui-all.patch"

# 4) web-ui-settings: keyed slot key 修复（可能需要 pnpm install 才能生效）
apply_patch "@captain1275/dsh-client-ui-web-ui-settings" "@captain1275__dsh-client-ui-web-ui-settings@0.2.8.patch"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "应用: $APPLIED  跳过: $SKIPPED"
if [ "$APPLIED" -gt 0 ]; then
  ok "补丁已生效，请硬刷新浏览器 (Cmd+Shift+R)"
fi
