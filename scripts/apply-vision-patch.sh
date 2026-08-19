#!/bin/bash
# apply-vision-patch.sh — 升级 dsh-vision-router 后重新应用我们的补丁
#
# 用法：
#   1. 升级插件：dsh plugin --profile web add dsh-vision-router@新版本
#   2. 应用补丁：bash scripts/apply-vision-patch.sh
#   3. 重启 DSH：/web-restart

set -e

PLUGIN_DIR="$HOME/.dsh/profiles/web/node_modules/dsh-vision-router"
PATCH_FILE="$(dirname "$0")/../patches/vision-router-sensenova-muse.patch"

if [ ! -d "$PLUGIN_DIR" ]; then
  echo "❌ 插件目录不存在: $PLUGIN_DIR"
  exit 1
fi

if [ ! -f "$PATCH_FILE" ]; then
  echo "❌ 补丁文件不存在: $PATCH_FILE"
  exit 1
fi

# 检查是否已应用
if grep -q "isSenseNova" "$PLUGIN_DIR/index.js" 2>/dev/null; then
  echo "✅ 补丁已应用，无需重复"
  exit 0
fi

# 应用补丁
echo "📦 应用补丁到 $PLUGIN_DIR/index.js ..."
cd "$PLUGIN_DIR"
if patch -p1 --forward < "$PATCH_FILE" 2>/dev/null; then
  echo "✅ 补丁应用成功"
else
  echo "⚠️  部分 hunk 可能已应用或有冲突，检查输出"
fi

echo ""
echo "下一步：重启 DSH（/web-restart）"
